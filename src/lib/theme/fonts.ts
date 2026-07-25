/**
 * Font axis of the two-axis theming model (spec #9, ADR-0011).
 *
 * A font family is type and only type — it never assumes a background (brief
 * condition 1). All three faces are IBM Plex: a superfamily drawn on shared
 * vertical metrics and apparent size, which is what satisfies the brief's
 * optical-matching condition (condition 2) without per-family size fudging —
 * switching family does not reflow the passage or change page density.
 *
 * The faces are self-hosted via Fontsource (imported in src/routes/layout.css);
 * the stacks below only ever reach the fallbacks when the webfont fails.
 */

export interface FontFamily {
	/** CSS font-family stack, applied app-wide through `--font-stack`. */
	readonly stack: string;
}

export const FONTS = {
	sans: { stack: "'IBM Plex Sans', system-ui, sans-serif" },
	serif: { stack: "'IBM Plex Serif', Georgia, serif" },
	mono: { stack: "'IBM Plex Mono', ui-monospace, monospace" }
} as const satisfies Record<string, FontFamily>;

export type FontId = keyof typeof FONTS;

export const FONT_IDS = Object.keys(FONTS) as readonly FontId[];

export const DEFAULT_FONT: FontId = 'sans';

export function isFontId(value: unknown): value is FontId {
	return typeof value === 'string' && value in FONTS;
}
