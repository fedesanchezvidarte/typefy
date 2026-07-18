import type { TypeableText } from '../types.js';
import type { ChunkEngineState, ChunkEvent } from './types.js';
import { createChunk, applyChunkEvent } from './chunk.js';
import { computeMetrics } from './metrics.js';

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
	averageWpm: number; // mean of per-chunk gross WPM
	overallAccuracy: number; // aggregate first-attempt hits ÷ first-attempt entries across all chunks
	chunksCompleted: number;
	totalActiveMs: number; // sum of per-chunk first-keystroke→completion times
}

export interface SessionState {
	readonly text: TypeableText;
	readonly activeIndex: number;
	readonly activeChunk: ChunkEngineState;
	readonly results: readonly (ChunkResult | null)[]; // frozen at each chunk's completion
	readonly finished: boolean;
}

export type SessionEvent = ChunkEvent | { type: 'restart-chunk' } | { type: 'restart-session' };

export function createSession(text: TypeableText): SessionState {
	return {
		text,
		activeIndex: 0,
		activeChunk: createChunk(text.chunks[0].content),
		results: text.chunks.map(() => null),
		finished: false
	};
}

export function applySessionEvent(state: SessionState, event: SessionEvent): SessionState {
	if (event.type === 'restart-session') {
		return createSession(state.text);
	}
	if (event.type === 'restart-chunk') {
		return {
			...state,
			activeChunk: createChunk(state.text.chunks[state.activeIndex].content)
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
		return { ...state, activeChunk, results, finished: true };
	}
	return {
		...state,
		activeIndex: nextIndex,
		activeChunk: createChunk(state.text.chunks[nextIndex].content),
		results,
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
		averageWpm: completed.reduce((sum, c) => sum + c.result.grossWpm, 0) / completed.length,
		overallAccuracy: totalHits / totalEntries,
		chunksCompleted: completed.length,
		totalActiveMs: completed.reduce((sum, c) => sum + c.result.elapsedMs, 0)
	};
}
