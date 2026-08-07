import type { Chunk, Mode } from '../types.js';
import type { ChunkEngineState, ChunkEvent, Keystroke, LoadedChunks } from './types.js';
import { createChunk, applyChunkEvent } from './chunk.js';
import { computeMetrics, type MetricsSnapshot } from './metrics.js';

/**
 * In-memory session over a typeable text: chunks consumed in order by ABSOLUTE index,
 * auto-advance on completion, aggregates at the end. This is the ONLY module that wires the
 * state machine to metrics — chunk.ts stays metrics-free — and since spec #24 it is also the
 * only module that knows a stroke may be UNMEASURED.
 *
 * Since spec #18 the session holds a WINDOW of the text rather than all of it, so it has a
 * third state: `awaiting`, entered when the next chunk has not arrived yet. It is the
 * engine's first state a user cannot leave by typing — it transitions on `window-loaded`,
 * an event from the delivery layer. The session is deliberately NOT re-created per window:
 * re-creating it would reset `completedLog` and move the cumulative-WPM definition out of
 * the engine.
 *
 * Spec #24 adds the MODE axis. Measurement is no longer pinned to one whole passage but to
 * MEASURED SPANS — contiguous stretches typed in Normal. Zen spans are discounted from
 * elapsed time by the very mechanism `awaiting` already uses (an open-span marker plus an
 * accumulator, fed into `computeMetrics`'s `excludeMs`), and Zen strokes are excluded from
 * the counting terms by the `measured` flag this module stamps onto every event it forwards.
 */

/**
 * One frozen traversal, the payload a `chunk_attempts` row is built from.
 *
 * `grossWpm` and `accuracyRaw` are NULL exactly when the traversal was not WHOLLY measured
 * (`chunkFullyMeasured`). That asymmetry against the live figure is deliberate and is the
 * heart of spec #24 §4: `chunk_attempts` is what `best_wpm` and every future stats screen
 * read, so a partial figure filed as *that passage's* result would let a 20-character Normal
 * sprint at the end of a passage bank a personal best. The live figure has no such
 * consequence — it is information for the person typing right now.
 *
 * The span is recorded EITHER WAY: a row that carries figures must carry what they measured
 * alongside them, and a mixed traversal therefore writes non-zero spans with NULL metrics.
 */
export interface ChunkResult {
	grossWpm: number | null;
	accuracyRaw: number | null;
	/** WALL CLOCK, first keystroke → completion. Meaning unchanged by spec #24. */
	elapsedMs: number;
	/** Milliseconds of measured span in this traversal. Always `<= elapsedMs`. */
	measuredMs: number;
	/** Char strokes typed inside measured spans. */
	measuredChars: number;
	mode: Mode;
}

export interface SessionSummary {
	/** Cumulative gross WPM over the session's running log (not a per-chunk mean). NULL after ANY Zen. */
	averageWpm: number | null;
	/** Aggregate first-attempt hits ÷ entries across all chunks. NULL after ANY Zen. */
	overallAccuracy: number | null;
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
	/**
	 * The measurement axis (spec #24). Flat fields mirroring the `awaitingSince`/`awaitingMs`
	 * pair rather than a nested `span` object: the visual parity is what makes the mechanism
	 * recognisable as the SAME one, which is the whole argument for reusing it.
	 */
	readonly mode: Mode;
	/**
	 * Start of the OPEN Zen span; null in Normal, while `awaiting` owns the clock, or when no
	 * clock was available to stamp it. Serves both scopes below — there is at most one open
	 * span and it belongs to each of them.
	 */
	readonly unmeasuredSince: number | null;
	/** Closed Zen spans, SESSION scope. Discounted from every cumulative metric. */
	readonly unmeasuredMs: number;
	/** Closed Zen spans within the ACTIVE traversal. Reset at every traversal boundary. */
	readonly chunkUnmeasuredMs: number;
	/**
	 * No Zen at all in the ACTIVE traversal. One boolean per traversal, killed permanently by
	 * any switch to Zen while it is active and NEVER restored by switching back — a return to
	 * Normal resumes measurement but does not re-clean the row. A boolean rather than
	 * `chunkUnmeasuredMs === 0` because a zero-millisecond Zen excursion is still a Zen
	 * excursion and the row must say so.
	 */
	readonly chunkFullyMeasured: boolean;
	/**
	 * This session has been in Zen at some point. Set once, cleared only by `restart-session`.
	 * It is the predicate `sessionSummary` is all-or-nothing on — not a comparison against
	 * `unmeasuredMs === 0`, which an instantaneous toggle would defeat.
	 */
	readonly everUnmeasured: boolean;
}

export type SessionEvent =
	| ChunkEvent
	| { type: 'restart-chunk' }
	| { type: 'restart-session' }
	| { type: 'set-mode'; mode: Mode; timestamp: number }
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
 *
 * `mode` is DEFAULTED (spec #24). That default is the regression guarantee behind "a
 * fully-Normal session is byte-identical to pre-4a": every pre-existing caller and every
 * pre-existing test keeps compiling and keeps producing the same numbers, unedited.
 * A session opened in Zen counts as having contained Zen from its first instant — otherwise
 * a wholly-Zen sitting would report a summary the user asked not to be measured for.
 */
export function createSession(
	text: LoadedChunks,
	startIndex = 0,
	mode: Mode = 'normal'
): SessionState {
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
		awaitingMs: 0,
		mode,
		// No clock exists here, so an opening Zen span cannot be stamped at a real instant —
		// the `awaitingSince` precedent, applied verbatim. It opens on the first stroke.
		unmeasuredSince: null,
		unmeasuredMs: 0,
		chunkUnmeasuredMs: 0,
		chunkFullyMeasured: mode === 'normal',
		everUnmeasured: mode === 'zen'
	};
}

/** The session's running keystroke log: completed chunks' strokes + the active chunk's. */
export function runningLog(state: SessionState): readonly Keystroke[] {
	return [...state.completedLog, ...(state.activeChunk?.log ?? [])];
}

/** Milliseconds accrued on an open span marker up to `endTime`; 0 when either is absent. */
function openSpan(since: number | null, endTime: number | undefined): number {
	return since !== null && endTime !== undefined ? Math.max(endTime - since, 0) : 0;
}

/**
 * Cumulative metrics over the whole session's log, with dead time discounted for BOTH
 * reasons: time spent in `awaiting` and time spent in Zen. `endTime` enables live metrics.
 *
 * An OPEN span of either kind is discounted too when `endTime` is supplied: a UI polling
 * live metrics during a slow window fetch — or while the user sits in Zen — must not watch
 * WPM decay for a reason that is not the typist's. The accumulators alone would only close
 * the gap after the window landed or the mode switched back.
 *
 * The two discounts are summed, which is only correct because they are DISJOINT by
 * construction: `applySessionEvent` closes any open Zen span when the session enters
 * `awaiting`, and `applyWindowLoaded` reopens it on the return to `active`. Overlapping them
 * would subtract the same milliseconds twice and silently inflate cumulative WPM — floored
 * at 0, so it would never crash and never go negative, which is exactly what would make it
 * hard to notice.
 *
 * This function ALWAYS returns numbers. It is the span-honest LIVE figure of spec #24 §4: a
 * user who typed half a session in Zen and switched back sees a figure covering the Normal
 * half — real typing, really measured, and it disappears with the session. Its
 * all-or-nothing counterpart is `sessionSummary`. Do not conflate the two.
 */
export function runningMetrics(state: SessionState, endTime?: number): MetricsSnapshot {
	const openWait = openSpan(state.awaitingSince, endTime);
	const openZen = openSpan(state.unmeasuredSince, endTime);
	return computeMetrics(
		runningLog(state),
		endTime,
		state.awaitingMs + openWait + state.unmeasuredMs + openZen
	);
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
			awaitingMs: state.awaitingMs + closedWait,
			// The wait is over, so `awaitingSince` releases the clock and the Zen span REOPENS
			// if the user is still in Zen. This is the second half of the disjointness rule:
			// the span was closed on entering `awaiting` precisely so the wait would not be
			// discounted twice, and it must resume the moment typing becomes possible again.
			unmeasuredSince: state.mode === 'zen' ? event.timestamp : state.unmeasuredSince
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

/**
 * The mode switch. It touches the span accounting and NOTHING else — not `activeChunk`, not
 * the log, not `status`, not `results` — and is valid in every status, including `awaiting`
 * and `finished`: switching mode is free at any moment, mid-word or between passages.
 */
function applySetMode(
	state: SessionState,
	event: Extract<SessionEvent, { type: 'set-mode' }>
): SessionState {
	if (event.mode === state.mode) {
		// Identity. A UI re-asserting its cookie value must never fabricate a zero-length
		// span boundary, and must never invalidate a memo downstream for nothing.
		return state;
	}
	if (event.mode === 'zen') {
		return {
			...state,
			mode: 'zen',
			// While `awaiting`, `awaitingSince` already owns the clock. Opening a Zen span on
			// top of it would double-discount the wait; the span opens instead on the return
			// to `active` (see applyWindowLoaded). Same reasoning for `finished`: there is no
			// further typing to leave unmeasured.
			unmeasuredSince: state.status === 'active' ? event.timestamp : null,
			chunkFullyMeasured: false,
			everUnmeasured: true
		};
	}
	const closed =
		state.unmeasuredSince === null ? 0 : Math.max(event.timestamp - state.unmeasuredSince, 0);
	return {
		...state,
		mode: 'normal',
		unmeasuredSince: null,
		unmeasuredMs: state.unmeasuredMs + closed,
		chunkUnmeasuredMs: state.chunkUnmeasuredMs + closed
		// `chunkFullyMeasured` is deliberately NOT restored: measurement resumes, but this
		// traversal has already been in Zen and its row must keep saying so.
	};
}

export function applySessionEvent(state: SessionState, event: SessionEvent): SessionState {
	if (event.type === 'window-loaded') {
		return applyWindowLoaded(state, event);
	}
	if (event.type === 'set-mode') {
		return applySetMode(state, event);
	}
	if (event.type === 'restart-session') {
		// Back to the OPENING index, not to 0: with windows, index 0 is usually not loaded
		// on a resumed session, so restarting a session opened at passage 900 there would
		// drop straight into `awaiting` for a window nothing is going to request. Every
		// chunk loaded so far is kept, so the restart never awaits.
		//
		// The CURRENT mode carries over — it is a cookie-backed preference, not session
		// state — while every accumulator, both chunk fields and `everUnmeasured` reset.
		return createSession(state.text, state.openingIndex, state.mode);
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
			status: 'active',
			// A restart begins a NEW traversal, so the per-traversal accounting resets and the
			// traversal is clean again iff the user is in Normal. The SESSION-scope totals and
			// `everUnmeasured` are untouched: the Zen time really did happen this session.
			chunkUnmeasuredMs: 0,
			chunkFullyMeasured: state.mode === 'normal'
		};
	}
	if (state.status !== 'active' || state.activeChunk === null) {
		// Typing events after the last chunk, or while waiting for a window, are ignored:
		// the identical state object is returned, so nothing enters any log, no metric can
		// move, and nothing is buffered into the chunk that eventually arrives.
		return state;
	}

	// The single place `measured` is stamped. The UI dispatches plain char/backspace events;
	// the mode lives here, so provenance is written from one source of truth rather than
	// asserted by every call site.
	const measured = state.mode === 'normal';
	const activeChunk = applyChunkEvent(state.activeChunk, { ...event, measured } as ChunkEvent);

	// `restart` is the one ChunkEvent with no clock on it. Nothing below may fabricate an
	// instant for it — the `awaitingSince` precedent, applied to the Zen marker too.
	const now = 'timestamp' in event ? event.timestamp : null;

	// A Zen span that could not be stamped when the mode was set — no clock was available in
	// `createSession`, or the session was `awaiting` — opens at the first stroke that carries
	// one. Without this, a session OPENED in Zen would accrue no discount at all and a wholly
	// Zen traversal would report `measuredMs === elapsedMs` instead of 0.
	const unmeasuredSince = state.unmeasuredSince === null && !measured ? now : state.unmeasuredSince;

	if (!activeChunk.completed) {
		return { ...state, activeChunk, unmeasuredSince };
	}

	// Completion instant: freeze this chunk's result and auto-advance.
	const metrics = computeMetrics(activeChunk.log);
	const openZen = unmeasuredSince === null || now === null ? 0 : Math.max(now - unmeasuredSince, 0);
	const unmeasured = state.chunkUnmeasuredMs + openZen;
	const clean = state.chunkFullyMeasured;
	const result: ChunkResult = {
		grossWpm: clean ? metrics.grossWpm : null,
		accuracyRaw: clean ? metrics.accuracyRaw : null,
		elapsedMs: metrics.elapsedMs,
		// Floored at 0 because a Zen span can open BEFORE this chunk's first keystroke, in
		// which case `openZen` legitimately exceeds the wall clock. The floor plus the
		// wall-clock `elapsedMs` is what makes `measured_ms <= elapsed_ms` hold for every row.
		measuredMs: Math.max(metrics.elapsedMs - unmeasured, 0),
		measuredChars: activeChunk.log.filter((k) => k.kind === 'char' && k.measured !== false).length,
		mode: clean ? 'normal' : 'zen'
	};
	const results = new Map(state.results).set(state.activeIndex, result);

	// Still at the completion instant, before the boundary reset: the open Zen span closes
	// for the CHUNK and reopens immediately for the SESSION. Chunk totals stay exact, session
	// totals are unaffected, and nothing is counted twice.
	const carried = {
		unmeasuredMs: state.unmeasuredMs + openZen,
		// RE-STAMPED, not carried: the span that has just been folded into the chunk total
		// must not be folded a second time when it eventually closes. Carrying the original
		// marker forward would charge the next traversal for every millisecond of this one.
		unmeasuredSince: unmeasuredSince === null ? null : now,
		// A new traversal begins: clean again iff the user is in Normal.
		chunkUnmeasuredMs: 0,
		chunkFullyMeasured: state.mode === 'normal'
	};

	const nextIndex = state.activeIndex + 1;
	if (nextIndex >= state.text.chunkCount) {
		// Checked FIRST, and against books.chunk_count rather than the loaded map, which is
		// why the last chunk of a book can never enter `awaiting`.
		// The completed chunk stays active, so its strokes stay in `activeChunk.log` and
		// must NOT also be appended to `completedLog` — see the invariant on SessionState.
		return { ...state, activeChunk, results, status: 'finished', ...carried };
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
			...carried,
			// No timestamp means no instant to attribute the wait to, so the wait opens
			// unmeasured rather than at a fabricated one.
			awaitingSince: now,
			// Disjointness: `awaitingSince` now owns the clock, so the Zen span must NOT stay
			// open across the wait. It was folded into `unmeasuredMs` above and reopens in
			// `applyWindowLoaded` when typing becomes possible again.
			unmeasuredSince: null
		};
	}
	return {
		...state,
		activeIndex: nextIndex,
		activeChunk: createChunk(nextChunk.content),
		status: 'active',
		results,
		completedLog,
		...carried
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

	const totalActiveMs = completed.reduce((sum, c) => sum + c.result.elapsedMs, 0);

	if (state.everUnmeasured) {
		// All-or-nothing, and DELIBERATELY different from `runningMetrics`: a session that
		// contained any Zen time at all reports no WPM and no accuracy (spec #24 §11), so the
		// UI omits those tiles rather than advertising the numbers Zen refused.
		//
		// The predicate is the flag, not `unmeasuredMs === 0`: an instantaneous toggle accrues
		// zero milliseconds and still means the session was in Zen.
		//
		// The counters stay. Time is neither WPM nor accuracy, and Zen progress is progress —
		// §11 prohibits exactly two tiles and nothing else.
		return {
			averageWpm: null,
			overallAccuracy: null,
			chunksCompleted: completed.length,
			totalActiveMs
		};
	}

	if (completed.length === 0) {
		return { averageWpm: 0, overallAccuracy: 0, chunksCompleted: 0, totalActiveMs: 0 };
	}

	// For a completed chunk, first-attempt entries === charCount, so aggregate accuracy
	// (hits ÷ entries across all chunks) is the charCount-weighted mean of per-chunk ratios.
	// Past the `everUnmeasured` guard every result in this session is clean by construction,
	// so `accuracyRaw` is non-null throughout and the weighted-mean arithmetic below is the
	// pre-4a code, unmodified.
	const totalEntries = completed.reduce((sum, c) => sum + c.charCount, 0);
	const totalHits = completed.reduce(
		(sum, c) => sum + (c.result.accuracyRaw ?? 0) * c.charCount,
		0
	);

	return {
		averageWpm: runningMetrics(state).grossWpm,
		overallAccuracy: totalHits / totalEntries,
		chunksCompleted: completed.length,
		totalActiveMs
	};
}
