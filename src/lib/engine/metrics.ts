import type { Keystroke } from './types.js';

/**
 * Metrics over keystroke-log slices (spec #5: the log is the single source of truth).
 *
 * Works over ANY contiguous slice — word, chunk, or session (concatenated chunk logs) —
 * which is what makes per-word live metrics and Phase 4 granularity pickers possible
 * without touching the state machine. `chunk.ts` never imports this module (metrics
 * separability: Zen mode later simply stops calling it).
 */

export interface MetricsSnapshot {
	grossWpm: number; // (typed chars ÷ 5) ÷ elapsed minutes; backspaces excluded from typed chars
	accuracyRaw: number; // first-attempt hits ÷ first-attempt entries; corrected counts as a miss. 0..1
	typedChars: number;
	elapsedMs: number;
}

const ZERO_SNAPSHOT: MetricsSnapshot = {
	grossWpm: 0,
	accuracyRaw: 0,
	typedChars: 0,
	elapsedMs: 0
};

/**
 * Computes gross WPM and Accuracy (raw) over a contiguous slice of a keystroke log.
 * `endTime` enables live metrics (elapsed = endTime − first stroke); omitted, elapsed
 * spans first → last stroke in the slice.
 */
export function computeMetrics(slice: readonly Keystroke[], endTime?: number): MetricsSnapshot {
	if (slice.length === 0) {
		return ZERO_SNAPSHOT;
	}

	const typedChars = slice.filter((k) => k.kind === 'char').length;
	const firstAttempts = slice.filter((k) => k.firstAttempt);
	const firstAttemptHits = firstAttempts.filter((k) => k.judgment === 'hit').length;

	const firstStroke = slice[0].timestamp;
	const lastStroke = endTime ?? slice[slice.length - 1].timestamp;
	const elapsedMs = lastStroke - firstStroke;

	return {
		grossWpm: elapsedMs > 0 ? typedChars / 5 / (elapsedMs / 60_000) : 0,
		accuracyRaw: firstAttempts.length > 0 ? firstAttemptHits / firstAttempts.length : 0,
		typedChars,
		elapsedMs
	};
}

/**
 * Splits a chunk's log into word slices. A word ends when an expected-space position
 * is judged (the space stroke closes the slice); trailing strokes form the last slice.
 */
export function wordSlices(log: readonly Keystroke[]): readonly (readonly Keystroke[])[] {
	const slices: Keystroke[][] = [];
	let current: Keystroke[] = [];

	for (const stroke of log) {
		current.push(stroke);
		if (stroke.kind === 'char' && stroke.expected === ' ') {
			slices.push(current);
			current = [];
		}
	}
	if (current.length > 0) {
		slices.push(current);
	}
	return slices;
}
