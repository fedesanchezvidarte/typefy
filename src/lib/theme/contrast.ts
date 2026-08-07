/**
 * WCAG 2.x contrast math (spec #25 §1) — sRGB relative luminance and the contrast-ratio
 * formula, hand-rolled per the brief rather than pulling in a colour library for ~20 lines
 * of well-specified arithmetic.
 *
 * Pure by construction (`lib-patterns` tier 1): no DOM, no palette knowledge, nothing but
 * hex strings in and numbers out. `theme.spec.ts` is the one caller — it iterates
 * `PALETTES` and checks every foreground token against its two backgrounds.
 */

/** Parses `#RRGGBB` (case-insensitive) into 0–255 channel values. */
function hexToRgb(hex: string): readonly [number, number, number] {
	const match = /^#?([0-9a-f]{6})$/i.exec(hex);
	if (!match) {
		throw new Error(`Not a 6-digit hex colour: "${hex}"`);
	}
	const value = match[1];
	return [
		parseInt(value.slice(0, 2), 16),
		parseInt(value.slice(2, 4), 16),
		parseInt(value.slice(4, 6), 16)
	];
}

/** WCAG's sRGB gamma-correction step for one channel (0–255 in, linear-light out). */
function linearize(channel: number): number {
	const c = channel / 255;
	return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance of a colour, 0 (black) to 1 (white). */
function relativeLuminance(hex: string): number {
	const [r, g, b] = hexToRgb(hex).map(linearize);
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * The WCAG contrast ratio between two colours, from 1 (identical) to 21 (black on white).
 * Symmetric: argument order never changes the result.
 */
export function contrastRatio(hexA: string, hexB: string): number {
	const lA = relativeLuminance(hexA);
	const lB = relativeLuminance(hexB);
	const lighter = Math.max(lA, lB);
	const darker = Math.min(lA, lB);
	return (lighter + 0.05) / (darker + 0.05);
}

/**
 * WCAG AA thresholds: `'text'` (normal-size text, 4.5:1) is the stricter bar; `'ui'`
 * (large text or non-text UI components like a caret, 3:1) is the looser one.
 */
export function meetsAA(ratio: number, kind: 'text' | 'ui'): boolean {
	const threshold = kind === 'text' ? 4.5 : 3;
	return ratio >= threshold;
}
