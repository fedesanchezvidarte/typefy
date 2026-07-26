import type { TypeableText } from '../types.js';
import type { ChunkEngineState, ChunkEvent, Keystroke } from './types.js';
import { createChunk, applyChunkEvent } from './chunk.js';
import { computeMetrics, type MetricsSnapshot } from './metrics.js';

/**
 * In-memory session over a typeable text: chunks consumed in order, auto-advance on
 * completion, aggregates at the end. This is the ONLY module that wires the state
 * machine to metrics — chunk.ts stays metrics-free (Zen mode later: stop calling them).
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
	readonly text: TypeableText;
	readonly activeIndex: number;
	readonly activeChunk: ChunkEngineState;
	readonly results: readonly (ChunkResult | null)[]; // frozen at each chunk's completion
	/**
	 * Concatenated keystroke logs of the chunks left behind this session, in completion
	 * order. Invariant: it never overlaps `activeChunk.log` — the active chunk's strokes
	 * live only in `activeChunk`, including the last chunk once the session is finished.
	 * That is what makes `runningLog` a plain concatenation and lets `restart-chunk`
	 * drop the active passage's strokes structurally.
	 */
	readonly completedLog: readonly Keystroke[];
	readonly finished: boolean;
}

export type SessionEvent = ChunkEvent | { type: 'restart-chunk' } | { type: 'restart-session' };

/**
 * Opens a session at `startIndex` (resume), defaulting to the first chunk. The index is
 * floored and clamped into `0..chunkCount - 1`; a non-finite value falls back to 0, so a
 * hand-edited or stale link can never produce an unopenable session. Resuming does NOT
 * fabricate results for the skipped chunks — `results` is all-null either way.
 */
export function createSession(text: TypeableText, startIndex = 0): SessionState {
	const index = Number.isFinite(startIndex)
		? Math.min(Math.max(Math.floor(startIndex), 0), text.chunkCount - 1)
		: 0;
	return {
		text,
		activeIndex: index,
		activeChunk: createChunk(text.chunks[index].content),
		results: text.chunks.map(() => null),
		completedLog: [],
		finished: false
	};
}

/** The session's running keystroke log: completed chunks' strokes + the active chunk's. */
export function runningLog(state: SessionState): readonly Keystroke[] {
	return [...state.completedLog, ...state.activeChunk.log];
}

/** Cumulative metrics over the whole session's log. `endTime` enables live metrics. */
export function runningMetrics(state: SessionState, endTime?: number): MetricsSnapshot {
	return computeMetrics(runningLog(state), endTime);
}

export function applySessionEvent(state: SessionState, event: SessionEvent): SessionState {
	if (event.type === 'restart-session') {
		return createSession(state.text);
	}
	if (event.type === 'restart-chunk') {
		return {
			...state,
			activeChunk: createChunk(state.text.chunks[state.activeIndex].content),
			// Clear `finished` so the restarted chunk is typeable again. A no-op mid-session
			// (finished is already false); it removes the dead state where restarting a chunk
			// after the session finished left `finished: true` and ignored all keystrokes.
			finished: false
		};
	}
	if (state.finished) {
		return state; // typing events after the last chunk are ignored
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
	const results = state.results.map((r, i) => (i === state.activeIndex ? result : r));

	const nextIndex = state.activeIndex + 1;
	if (nextIndex >= state.text.chunkCount) {
		// The completed chunk stays active, so its strokes stay in `activeChunk.log` and
		// must NOT also be appended to `completedLog` — see the invariant on SessionState.
		return { ...state, activeChunk, results, finished: true };
	}
	return {
		...state,
		activeIndex: nextIndex,
		activeChunk: createChunk(state.text.chunks[nextIndex].content),
		results,
		// The completed chunk is being left behind: its strokes move into the running log.
		completedLog: [...state.completedLog, ...activeChunk.log],
		finished: false
	};
}

export function sessionSummary(state: SessionState): SessionSummary {
	const completed = state.results
		.map((result, index) =>
			result ? { result, charCount: state.text.chunks[index].charCount } : null
		)
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
