/**
 * Generated typographic cover composition (spec #9, brief §3).
 *
 * When a book has no curated cover art (`cover_url` null), the library renders
 * a cover composed from the book's own title and author in the active font on
 * a colour drawn from the active palette. The one piece of layout logic — the
 * title size step — lives here as a pure, testable function; the rest is CSS.
 *
 * Thresholds come from the approved mockup: short titles set large, medium
 * titles medium, long titles small, so a one-word and a twelve-word title both
 * sit correctly in the same 2/3 frame.
 */

export type CoverTitleSize = 'lg' | 'md' | 'sm';

export function coverTitleSize(title: string): CoverTitleSize {
	const length = Array.from(title).length;
	if (length <= 8) {
		return 'lg';
	}
	if (length <= 18) {
		return 'md';
	}
	return 'sm';
}
