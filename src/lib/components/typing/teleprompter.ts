/**
 * Teleprompter scroll math (spec #32 §7, §11 R7): given where the active line sits and
 * where the "band" it must stay inside is, how far to shift the track.
 *
 * **Pure math only — no DOM.** `TypingSurface.svelte` is the only caller and the only
 * place a `Range`/`getBoundingClientRect` measurement happens; this module never touches
 * either. That split is what makes the documented cut (spec #32 §12 cut #1, natural
 * `scrollIntoView` instead) a two-file deletion — this module and the one `$effect` that
 * calls it — rather than scroll logic threaded through the component that also owns the
 * caret, the input and the character stream.
 *
 * This is display-only and structurally cannot reach `src/lib/chunking/`: it takes pixel
 * measurements in, returns a pixel offset out, and nothing here can become a chunk
 * boundary. See `measure.ts`'s module comment for the seam this preserves.
 */

/**
 * How many rendered lines stay visible BELOW the caret's line on the typing screen — the
 * band's bottom margin, and the whole of what spec #45 changed here.
 *
 * Phase 5b's band was the viewport's middle third, which kept the text permanently in motion:
 * the caret was pinned near the centre, so almost every new line scrolled. With the card now
 * pinned to the viewport's height, the band runs from the very top to three lines short of the
 * bottom instead, and `computeTranslateY`'s first case ("already inside the band → no scroll")
 * does the rest: the page sits **completely still** until the caret reaches the last three
 * lines, then follows one line at a time, always leaving this much lookahead in view.
 */
export const LOOKAHEAD_LINES = 3;

export interface TeleprompterInput {
	/** The active line's top edge, in the UNTRANSFORMED track's own coordinate space (px). */
	activeLineTop: number;
	/** Rendered line height (px). */
	lineHeight: number;
	/** The viewport's own height (px) — the fixed, `overflow: hidden` window onto the track. */
	containerHeight: number;
	/** Top edge of the middle band within the viewport (px, `0..containerHeight`). */
	bandTop: number;
	/** Bottom edge of the middle band within the viewport (px, `bandTop..containerHeight`). */
	bandBottom: number;
}

/**
 * The `translateY` to apply to the track so the active line's rendered position (its
 * untransformed top plus this offset) stays within `[bandTop, bandBottom]`.
 *
 * Recomputed from scratch on every call rather than incrementally — there is no history to
 * thread through a pure function, and recomputing is cheap and self-correcting (a resize,
 * a font swap, a restored page all "just work" on the next measurement rather than needing
 * a reset).
 *
 * Three cases:
 * 1. The line's natural (untransformed) position already sits wholly inside the band: no
 *    scroll yet. This is what keeps the first several lines of a page still while the
 *    cursor is still above the point where scrolling would be needed at all.
 * 2. The line's natural position runs past the band's bottom: pin its bottom edge exactly
 *    to `bandBottom`, revealing exactly enough of what follows.
 * 3. The line's natural position sits above the band's top (reachable after backspacing
 *    back up past an earlier scroll): pin its top edge to `bandTop`, and never scroll the
 *    content back DOWN past where it naturally sits (`Math.min(0, …)` — a positive shift
 *    would push already-typed lines further down, which is never correct).
 *
 * `containerHeight` bounds the band rather than being consulted directly: a caller handing
 * in a `bandBottom` beyond it would ask this function to reveal blank space past the
 * viewport's own edge, so the band is clamped into the container before either case above
 * runs.
 */
export function computeTranslateY(input: TeleprompterInput): number {
	const { activeLineTop, lineHeight, containerHeight } = input;
	const bandTop = Math.max(0, Math.min(input.bandTop, containerHeight));
	const bandBottom = Math.max(bandTop, Math.min(input.bandBottom, containerHeight));

	const lineBottom = activeLineTop + lineHeight;

	if (activeLineTop >= bandTop && lineBottom <= bandBottom) {
		return 0;
	}
	if (lineBottom > bandBottom) {
		return bandBottom - lineBottom;
	}
	return Math.min(0, bandTop - activeLineTop);
}
