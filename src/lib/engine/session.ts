import type { Chunk } from '../types.js';
import type { ChunkEngineState, ChunkEvent, Keystroke, LoadedChunks } from './types.js';
import { createChunk, applyChunkEvent } from './chunk.js';
import { computeMetrics, type MetricsSnapshot } from './metrics.js';

/**
 * In-memory session over a typeable text: chunks consumed in order by ABSOLUTE index,
 * auto-advance on completion, aggregates at the end. This is the ONLY module that wires the
 * state machine to metrics — chunk.ts stays metrics-free (Zen mode later: stop calling them).
 *
 * Since spec #18 the session holds a WINDOW of the text rather than all of it, so it has a
 * third state: `awaiting`, entered when the next chunk has not arrived yet. It is the
 * engine's first state a user cannot leave by typing — it transitions on `window-loaded`,
 * an event from the delivery layer. The session is deliberately NOT re-created per window:
 * re-creating it would reset `completedLog` and move the cumulative-WPM definition out of
 * the engine.
 */

export interface ChunkResult {
	grossWpm: number;
	accuracyRaw: number;
	elapsedMs: number;
}

export interface SessionSummary {
	averageWpm: number; // cumulative gross WPM over the session's running log (not a per-chunk mean)
	overallAccuracy: number; // aggregate first-attempt hits ÷ first-attempt entries across all chunks
	chunksCompleted: number;
	totalActiveMs: number; // sum of per-chunk first-keystroke→completion times
}

export interface SessionState {
	readonly text: LoadedChunks;
	readonly activeIndex: number;
	/** null iff `status !== 'active'`. Never read without checking `status` first. */
	readonly activeChunk: ChunkEngineState | null;
	/**
	 * The named state. Replaces the old `finished: boolean` — one source of truth, not two,
	 * and what keeps `activeChunk`'s nullability from degenerating into scattered null checks.
	 */
	readonly status: 'active' | 'awaiting' | 'finished';
	/**
	 * Frozen at each chunk's completion, keyed by ABSOLUTE index. Absence means not
	 * completed; the map is sparse, because a windowed session never holds the whole text.
	 */
	readonly results: ReadonlyMap<number, ChunkResult>;
	/**
	 * Concatenated keystroke logs of the chunks left behind this session, in completion
	 * order. Invariant: it never overlaps `activeChunk.log` — the active chunk's strokes
	 * live only in `activeChunk`, including the last chunk once the session is finished.
	 * That is what makes `runningLog` a plain concatenation and lets `restart-chunk`
	 * drop the active passage's strokes structurally. Entering `awaiting` preserves it the
	 * same way a normal advance does: the completed log moves over, `activeChunk` goes null.
	 */
	readonly completedLog: readonly Keystroke[];
	/** Where `restart-session` returns to — the index the session was opened at, not 0. */
	readonly openingIndex: number;
	/** Timestamp `awaiting` was entered; null whenever not awaiting, or when unmeasurable. */
	readonly awaitingSince: number | null;
	/** Total ms this session spent in `awaiting`. Discounted from every cumulative metric. */
	readonly awaitingMs: number;
}

export type SessionEvent =
	| ChunkEvent
	| { type: 'restart-chunk' }
	| { type: 'restart-session' }
	| { type: 'window-loaded'; chunks: readonly Chunk[]; chunkCount: number; timestamp: number };

/**
 * Builds the engine's view of a typeable text from a window of chunks. `chunkCount` is
 * `books.chunk_count` and must never be "how many chunks I happen to hold" — that is what
 * keeps the last chunk out of `awaiting` and what makes `?passage=N` addressable.
 */
export function loadedChunks(chunks: readonly Chunk[], chunkCount: number): LoadedChunks {
	return {
		chunkCount,
		chunks: new Map(chunks.map((chunk) => [chunk.index, chunk]))
	};
}

/**
 * Opens a session at `startIndex` (resume), defaulting to the first chunk. The index is
 * floored and clamped into `0..chunkCount - 1`; a non-finite value falls back to 0, so a
 * hand-edited or stale link can never produce an unopenable session. Resuming does NOT
 * fabricate results for the skipped chunks — `results` is empty either way.
 *
 * If the opening chunk is not in the window (a loader/resolver mismatch, or an empty text),
 * the session opens `awaiting` rather than throwing. No clock is available here, so no dead
 * time is attributed to that opening wait.
 */
export function createSession(text: LoadedChunks, startIndex = 0): SessionState {
	const lastIndex = Math.max(text.chunkCount - 1, 0);
	const index = Number.isFinite(startIndex)
		? Math.min(Math.max(Math.floor(startIndex), 0), lastIndex)
		: 0;
	const chunk = text.chunks.get(index);
	return {
		text,
		activeIndex: index,
		activeChunk: chunk ? createChunk(chunk.content) : null,
		status: chunk ? 'active' : 'awaiting',
		results: new Map(),
		completedLog: [],
		openingIndex: index,
		awaitingSince: null,
		awaitingMs: 0
	};
}

/** The session's running keystroke log: completed chunks' strokes + the active chunk's. */
export function runningLog(state: SessionState): readonly Keystroke[] {
	return [...state.completedLog, ...(state.activeChunk?.log ?? [])];
}

/**
 * Cumulative metrics over the whole session's log, with time spent in `awaiting` discounted.
 * `endTime` enables live metrics.
 *
 * An OPEN wait is discounted too when `endTime` is supplied: a UI polling live metrics
 * during a slow window fetch must not watch WPM decay for a reason that is not the typist's.
 * `awaitingMs` alone would only close the gap after the window landed.
 */
export function runningMetrics(state: SessionState, endTime?: number): MetricsSnapshot {
	const openWait =
		state.awaitingSince !== null && endTime !== undefined
			? Math.max(endTime - state.awaitingSince, 0)
			: 0;
	return computeMetrics(runningLog(state), endTime, state.awaitingMs + openWait);
}

/** Merges an arriving window into the loaded map — a new Map, never a mutation. */
function mergeChunks(
	text: LoadedChunks,
	chunks: readonly Chunk[],
	chunkCount: number
): LoadedChunks {
	const merged = new Map(text.chunks);
	for (const chunk of chunks) {
		merged.set(chunk.index, chunk);
	}
	return { chunkCount, chunks: merged };
}

/**
 * A window arrived. Always merges and always adopts the response's authoritative
 * `chunkCount` — that is how a client holding a stale bound reconciles after a re-ingest
 * grew or shrank the book mid-session.
 */
function applyWindowLoaded(
	state: SessionState,
	event: Extract<SessionEvent, { type: 'window-loaded' }>
): SessionState {
	const text = mergeChunks(state.text, event.chunks, event.chunkCount);
	if (state.status !== 'awaiting') {
		// The normal, prefetched case: merge and return. Zero cost — this is the whole
		// point of prefetching before the boundary is reached.
		return { ...state, text };
	}

	const closedWait =
		state.awaitingSince === null ? 0 : Math.max(event.timestamp - state.awaitingSince, 0);

	const chunk = text.chunks.get(state.activeIndex);
	if (chunk) {
		return {
			...state,
			text,
			activeChunk: createChunk(chunk.content),
			status: 'active',
			awaitingSince: null,
			awaitingMs: state.awaitingMs + closedWait
		};
	}

	if (text.chunkCount <= state.activeIndex) {
		// The text really did end — a shrinking re-ingest, or a stale chunk_count. Finish
		// with a summary rather than awaiting a chunk that will never arrive.
		return {
			...state,
			text,
			status: 'finished',
			awaitingSince: null,
			awaitingMs: state.awaitingMs + closedWait
		};
	}

	// The window arrived but did not contain the awaited index: the wait is still open, so
	// `awaitingSince` is left alone rather than restarted.
	return { ...state, text };
}

export function applySessionEvent(state: SessionState, event: SessionEvent): SessionState {
	if (event.type === 'window-loaded') {
		return applyWindowLoaded(state, event);
	}
	if (event.type === 'restart-session') {
		// Back to the OPENING index, not to 0: with windows, index 0 is usually not loaded
		// on a resumed session, so restarting a session opened at passage 900 there would
		// drop straight into `awaiting` for a window nothing is going to request. Every
		// chunk loaded so far is kept, so the restart never awaits.
		return createSession(state.text, state.openingIndex);
	}
	if (event.type === 'restart-chunk') {
		const chunk = state.text.chunks.get(state.activeIndex);
		if (!chunk) {
			return state; // awaiting: there is no chunk to restart
		}
		return {
			...state,
			activeChunk: createChunk(chunk.content),
			// Clear `finished` so the restarted chunk is typeable again. A no-op mid-session;
			// it removes the dead state where restarting a chunk after the session finished
			// left it un-typeable and ignoring all keystrokes.
			status: 'active'
		};
	}
	if (state.status !== 'active' || state.activeChunk === null) {
		// Typing events after the last chunk, or while waiting for a window, are ignored:
		// the identical state object is returned, so nothing enters any log, no metric can
		// move, and nothing is buffered into the chunk that eventually arrives.
		return state;
	}

	const activeChunk = applyChunkEvent(state.activeChunk, event);
	if (!activeChunk.completed) {
		return { ...state, activeChunk };
	}

	// Completion instant: freeze this chunk's result and auto-advance.
	const metrics = computeMetrics(activeChunk.log);
	const result: ChunkResult = {
		grossWpm: metrics.grossWpm,
		accuracyRaw: metrics.accuracyRaw,
		elapsedMs: metrics.elapsedMs
	};
	const results = new Map(state.results).set(state.activeIndex, result);

	const nextIndex = state.activeIndex + 1;
	if (nextIndex >= state.text.chunkCount) {
		// Checked FIRST, and against books.chunk_count rather than the loaded map, which is
		// why the last chunk of a book can never enter `awaiting`.
		// The completed chunk stays active, so its strokes stay in `activeChunk.log` and
		// must NOT also be appended to `completedLog` — see the invariant on SessionState.
		return { ...state, activeChunk, results, status: 'finished' };
	}

	// The completed chunk is being left behind: its strokes move into the running log.
	const completedLog = [...state.completedLog, ...activeChunk.log];
	const nextChunk = state.text.chunks.get(nextIndex);
	if (!nextChunk) {
		return {
			...state,
			activeIndex: nextIndex,
			activeChunk: null,
			status: 'awaiting',
			results,
			completedLog,
			// `restart` is the one ChunkEvent with no clock on it. It cannot complete a
			// chunk in practice, but if it ever did there is no timestamp to attribute the
			// wait to — so the wait opens unmeasured rather than at a fabricated instant.
			awaitingSince: 'timestamp' in event ? event.timestamp : null
		};
	}
	return {
		...state,
		activeIndex: nextIndex,
		activeChunk: createChunk(nextChunk.content),
		status: 'active',
		results,
		completedLog
	};
}

export function sessionSummary(state: SessionState): SessionSummary {
	// Iterates the SPARSE results map and looks each charCount up by absolute index, which
	// is what makes the summary correct for a session that only ever held two windows.
	const completed = [...state.results.entries()]
		.map(([index, result]) => {
			const chunk = state.text.chunks.get(index);
			return chunk ? { result, charCount: chunk.charCount } : null;
		})
		.filter((entry): entry is { result: ChunkResult; charCount: number } => entry !== null);

	if (completed.length === 0) {
		return { averageWpm: 0, overallAccuracy: 0, chunksCompleted: 0, totalActiveMs: 0 };
	}

	// For a completed chunk, first-attempt entries === charCount, so aggregate accuracy
	// (hits ÷ entries across all chunks) is the charCount-weighted mean of per-chunk ratios.
	const totalEntries = completed.reduce((sum, c) => sum + c.charCount, 0);
	const totalHits = completed.reduce((sum, c) => sum + c.result.accuracyRaw * c.charCount, 0);

	return {
		averageWpm: runningMetrics(state).grossWpm,
		overallAccuracy: totalHits / totalEntries,
		chunksCompleted: completed.length,
		totalActiveMs: completed.reduce((sum, c) => sum + c.result.elapsedMs, 0)
	};
}
