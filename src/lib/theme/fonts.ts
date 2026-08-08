/**
 * Reading-font axis of the two-axis theming model (spec #9, ADR-0011; scope
 * narrowed to "reading font" by the Phase 5a amendment, spec #30).
 *
 * A font family is type and only type — it never assumes a background (brief
 * condition 1). As of the Phase 5a amendment this axis no longer applies
 * app-wide: interface chrome is fixed to Roboto and only the two components
 * that render a book's own text (the typing screen and the landing hero, both
 * via `TypingSurface`) read this choice. The optical-matching / no-reflow
 * condition (ADR-0011's original condition 2) is dropped for this axis —
 * Roboto, Roboto Serif and Roboto Mono are unrelated families with different
 * metrics, so switching faces may reflow the passage in those two components;
 * nothing else in the app is affected.
 *
 * The faces are self-hosted via Fontsource (imported in src/routes/layout.css);
 * the stacks below only ever reach the fallbacks when the webfont fails.
 */

export interface FontFamily {
	/** CSS font-family stack, applied to book text via `--reading-font-stack`. */
	readonly stack: string;
	/**
	 * The face's own name, shown under each specimen in `FontSwitcher`. A brand name, so it
	 * lives here rather than in `messages/` — it reads the same in every UI locale.
	 */
	readonly name: string;
}

export const FONTS = {
	sans: { stack: "'Roboto', system-ui, sans-serif", name: 'Roboto' },
	serif: { stack: "'Roboto Serif', Georgia, serif", name: 'Roboto Serif' },
	mono: { stack: "'Roboto Mono', ui-monospace, monospace", name: 'Roboto Mono' }
} as const satisfies Record<string, FontFamily>;

export type FontId = keyof typeof FONTS;

export const FONT_IDS = Object.keys(FONTS) as readonly FontId[];

export const DEFAULT_FONT: FontId = 'sans';

export function isFontId(value: unknown): value is FontId {
	return typeof value === 'string' && value in FONTS;
}
