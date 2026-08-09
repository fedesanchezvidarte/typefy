/**
 * The page measure (spec #32; ADR-0005 amendment, ADR-0015).
 *
 * Three numbers and one function, and deliberately nothing else. This module is the SEAM
 * between two layers that must agree and cannot see each other:
 *
 * - `chunker.ts` sizes a chunk against `MAX_CHARS` and `MAX_LINES`.
 * - `TypingSurface.svelte` sets its measure to `CHARS_PER_LINE` `ch` from this same constant.
 *
 * It is extracted from `chunker.ts` rather than left there for two reasons. The component can
 * import the measure without dragging two hundred lines of sentence splitting into the client
 * bundle; and 66 has exactly one definition, so the CSS value is literally the chunker's
 * constant rather than a second copy of it that drifts the moment either side is edited.
 *
 * **Zero imports, by contract.** The line budget is an ESTIMATE against a fixed nominal
 * measure, never a DOM measurement: chunk boundaries are the progress key and must be
 * byte-identical on every device, in every font, at every viewport width. The teleprompter
 * measures the DOM; that measurement produces pixels and can never reach a chunk boundary.
 */

/**
 * The nominal characters per rendered line, and the value the typing surface's measure is
 * pinned to in `ch` units.
 *
 * `1ch` is the advance width of the digit `0`. In Roboto Mono the surface therefore fits
 * exactly 66 characters per line; in the proportional reading faces average prose is narrower
 * than a digit, so it fits rather more. The asymmetry runs the SAFE way — a face fitting more
 * than 66 renders a 24-line budget in fewer than 24 rendered lines, which never overflows.
 * The dangerous direction is fitting FEWER than 66, which is what a px measure produces in
 * mono. `ch` bounds the worst case at exactly this number; that bound, not constancy across
 * faces, is what the line budget rests on.
 */
export const CHARS_PER_LINE = 66;

/** Estimated rendered lines per page — a screenful, which is what a page now means. */
export const MAX_LINES = 24;

/**
 * The character backstop. `MAX_LINES * CHARS_PER_LINE` is 1584, so on dense prose (whose
 * paragraphs fill their last line rather than wasting it) both budgets bind at roughly the
 * same place, and neither is decorative. Dialogue — many short paragraphs, each rounding a
 * partial line up — binds on lines far below this.
 */
export const MAX_CHARS = 1600;

/**
 * A paragraph's cost in rendered lines: `max(1, ceil(length / CHARS_PER_LINE))`.
 *
 * The floor of 1 is the whole reason a run of one-word dialogue paragraphs fills a page: each
 * occupies a rendered line of its own however short it is, and a budget that summed characters
 * alone would happily stack forty of them onto one screen.
 *
 * Measured in CODE POINTS, matching the engine's `Array.from` split, so a precomposed `á`
 * costs one character here exactly as it occupies one position there.
 */
export function lineCost(paragraph: string): number {
	const length = Array.from(paragraph).length;
	return Math.max(1, Math.ceil(length / CHARS_PER_LINE));
}
