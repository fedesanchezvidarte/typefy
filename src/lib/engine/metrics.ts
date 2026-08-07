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
	typedChars: number; // MEASURED char strokes only — Zen strokes never reach the count
	elapsedMs: number; // span of the WHOLE slice minus excludeMs, never a measured-only span
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
 *
 * `excludeMs` discounts dead time from the span before the gross-WPM formula runs — time
 * the session was blocked on the delivery layer rather than on the typist (spec #18: the
 * engine's `awaiting` state; see `SessionState.awaitingMs`). A 40-second wait for a window
 * falls *inside* the first→last stroke span and nothing in the log marks it, so the
 * discount has to be carried alongside the log and applied here. It defaults to 0, which
 * leaves every existing caller and every existing metrics test untouched.
 *
 * It lives in this module rather than in `session.ts` deliberately: the alternative was
 * recomputing WPM there, which would put a second copy of the gross-WPM formula in a second
 * module — the one thing this module exists to prevent. Recorded honestly in the ADR-0004
 * amendment as a delivery-layer concern that reached the metrics module.
 *
 * `accuracyRaw` and `typedChars` have no time term and are untouched by the discount.
 *
 * Since spec #24 the COUNTING terms are taken over the measured strokes only: a stroke typed
 * in Zen carries `measured: false` and contributes to neither `typedChars` nor the
 * first-attempt population. An absent flag reads as measured, which is what keeps every
 * pre-4a slice and fixture scoring identically.
 *
 * The TIME term is deliberately NOT recomputed over the measured strokes. Zen time is
 * discounted through `excludeMs` — the identical mechanism as `awaiting` — because the
 * accumulator carried alongside the log is the only thing that can account for Zen time
 * spent between strokes, or before the first one. Two span calculations would drift; one
 * span minus one accumulated discount cannot.
 *
 * This is the second, smaller widening of the seam ADR-0004's 2026-08-01 amendment opened:
 * the module now reads a provenance flag as well as taking a discount. Surfaced, not
 * smuggled — the signature is unchanged and no fourth parameter was added.
 */
export function computeMetrics(
	slice: readonly Keystroke[],
	endTime?: number,
	excludeMs = 0
): MetricsSnapshot {
	if (slice.length === 0) {
		return ZERO_SNAPSHOT;
	}

	// Absent means measured — the pre-4a corpus, the schema backfill and the v1 buffer all
	// rest on the same construction argument (spec #24).
	const measured = slice.filter((k) => k.measured !== false);
	const typedChars = measured.filter((k) => k.kind === 'char').length;
	const firstAttempts = measured.filter((k) => k.firstAttempt);
	const firstAttemptHits = firstAttempts.filter((k) => k.judgment === 'hit').length;

	const firstStroke = slice[0].timestamp;
	const lastStroke = endTime ?? slice[slice.length - 1].timestamp;
	// Floored at 0: a discount larger than the span (a session that waited longer than it
	// typed) must report 0 elapsed and 0 WPM, never negative time and never negative speed.
	const elapsedMs = Math.max(lastStroke - firstStroke - Math.max(excludeMs, 0), 0);

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
