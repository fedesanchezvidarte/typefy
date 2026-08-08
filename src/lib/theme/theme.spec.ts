import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contrastRatio, meetsAA } from './contrast';
import { coverTitleSize } from './cover';
import { DEFAULT_FONT, FONT_IDS, FONTS, isFontId } from './fonts';
import {
	DEFAULT_DARK_PALETTE,
	DEFAULT_LIGHT_PALETTE,
	isPaletteId,
	PALETTE_IDS,
	PALETTES,
	type PaletteTokens
} from './palettes';
import { parseFont, parsePalette, themeHtmlAttributes } from './theme';

const TOKEN_KEYS: readonly (keyof PaletteTokens)[] = [
	'bg',
	'sheet',
	'fg',
	'dim',
	'muted',
	'border',
	'accent',
	'error',
	'errorTint',
	'caret'
];

describe('palettes', () => {
	it('ships exactly the four launch palettes, two light and two dark', () => {
		expect(PALETTE_IDS).toEqual(['warm-light', 'cool-light', 'soft-dark', 'near-black']);
		const schemes = PALETTE_IDS.map((id) => PALETTES[id].scheme);
		expect(schemes.filter((s) => s === 'light')).toHaveLength(2);
		expect(schemes.filter((s) => s === 'dark')).toHaveLength(2);
	});

	it('every palette defines the full 10-token contract with hex values', () => {
		for (const id of PALETTE_IDS) {
			const tokens = PALETTES[id].tokens;
			for (const key of TOKEN_KEYS) {
				expect(tokens[key], `${id}.${key}`).toMatch(/^#[0-9A-F]{6}$/);
			}
		}
	});

	it('defaults: warm-light for light, soft-dark for system dark', () => {
		expect(DEFAULT_LIGHT_PALETTE).toBe('warm-light');
		expect(PALETTES[DEFAULT_LIGHT_PALETTE].scheme).toBe('light');
		expect(DEFAULT_DARK_PALETTE).toBe('soft-dark');
		expect(PALETTES[DEFAULT_DARK_PALETTE].scheme).toBe('dark');
	});
});

describe('WCAG AA contrast', () => {
	// Closes #21 (spec #25 §1). This is the automated check the brief asks for — a one-off
	// measurement would drift the moment a palette value changes again.
	//
	// Text tokens (fg, dim, muted, accent, error) are held to the 4.5:1 "normal text" bar
	// against BOTH surfaces a token can sit on (bg, sheet), rather than trying to classify
	// some of them as "large text" (the 3:1 exception): the passage renders at 18px/21px
	// (TypingSurface.svelte), below the ~24px/18pt large-text threshold, and accent/error
	// both appear as link/text-sized UI elsewhere in the app. Requiring 4.5:1 uniformly is
	// the simpler, defensibly-conservative rule, and it strictly subsumes 3:1, so nothing
	// that would pass the spec's stated bar fails this stricter one.
	//
	// caret is a non-text UI indicator (the blinking cursor bar), so it only needs 3:1.
	//
	// border and errorTint are deliberately EXCLUDED, not silently skipped:
	//   - border is a decorative content divider, not a UI component that conveys state on
	//     its own — WCAG 1.4.11 (non-text contrast) doesn't reach a plain card/input border.
	//   - errorTint is a BACKGROUND tint (behind an incorrect character), not a foreground
	//     token — "against bg and sheet" doesn't apply to a background the same way.
	const TEXT_TOKENS: readonly (keyof PaletteTokens)[] = ['fg', 'dim', 'muted', 'accent', 'error'];
	const SURFACES: readonly (keyof PaletteTokens)[] = ['bg', 'sheet'];

	describe.each(PALETTE_IDS)('%s', (id) => {
		const tokens = PALETTES[id].tokens;

		it.each(TEXT_TOKENS)('%s clears 4.5:1 against bg and sheet', (token) => {
			for (const surface of SURFACES) {
				const ratio = contrastRatio(tokens[token], tokens[surface]);
				expect(meetsAA(ratio, 'text'), `${id}.${token} vs ${surface} = ${ratio.toFixed(2)}`).toBe(
					true
				);
			}
		});

		it('caret clears 3:1 against bg and sheet (non-text UI)', () => {
			for (const surface of SURFACES) {
				const ratio = contrastRatio(tokens.caret, tokens[surface]);
				expect(meetsAA(ratio, 'ui'), `${id}.caret vs ${surface} = ${ratio.toFixed(2)}`).toBe(true);
			}
		});
	});
});

describe('fonts', () => {
	it('ships sans, serif and mono, defaulting to sans', () => {
		expect(FONT_IDS).toEqual(['sans', 'serif', 'mono']);
		expect(DEFAULT_FONT).toBe('sans');
	});

	it('every stack self-hosts a Roboto face with a generic fallback', () => {
		expect(FONTS.sans.stack).toMatch(/^'Roboto'.*sans-serif$/);
		expect(FONTS.serif.stack).toMatch(/^'Roboto Serif'.*serif$/);
		expect(FONTS.mono.stack).toMatch(/^'Roboto Mono'.*monospace$/);
	});
});

describe('layout.css parity', () => {
	// Palettes are data (palettes.ts) but painted by CSS (layout.css). This
	// guards the two against drifting: every palette needs a CSS block carrying
	// every one of its token values, and the default/system-dark blocks must
	// use the default palettes' values.
	// Hex casing differs (Prettier lowercases CSS hex; the records use the
	// mockup's uppercase), so parity is checked case-insensitively.
	const css = readFileSync(resolve(__dirname, '../../routes/layout.css'), 'utf8').toLowerCase();

	it.each(PALETTE_IDS)('%s tokens appear under its data-palette block', (id) => {
		const block = css.match(new RegExp(`\\[data-palette='${id}'\\]\\s*\\{([^}]*)\\}`))?.[1];
		expect(block, `CSS block for ${id}`).toBeDefined();
		const tokens = PALETTES[id].tokens;
		for (const key of TOKEN_KEYS) {
			expect(block, `${id}.${key}`).toContain(tokens[key].toLowerCase());
		}
		expect(block).toContain(`color-scheme: ${PALETTES[id].scheme}`);
	});

	it('the no-choice defaults are warm-light, and soft-dark under prefers-color-scheme', () => {
		expect(css).toContain(PALETTES['warm-light'].tokens.bg.toLowerCase());
		expect(css).toContain('@media (prefers-color-scheme: dark)');
		expect(css).toContain(PALETTES['soft-dark'].tokens.bg.toLowerCase());
	});

	it('every font stack appears in the CSS', () => {
		for (const id of FONT_IDS) {
			expect(css).toContain(FONTS[id].stack.toLowerCase());
		}
	});
});

describe('theme parsing and attribute injection', () => {
	it('parses only known ids, rejecting junk and undefined', () => {
		expect(parsePalette('near-black')).toBe('near-black');
		expect(parsePalette('hotdog-stand')).toBeNull();
		expect(parsePalette(undefined)).toBeNull();
		expect(parseFont('mono')).toBe('mono');
		expect(parseFont('comic-sans')).toBeNull();
		expect(isPaletteId('cool-light')).toBe(true);
		expect(isFontId('serif')).toBe(true);
	});

	it('emits attributes only for explicit choices', () => {
		expect(themeHtmlAttributes(null, null)).toBe('');
		expect(themeHtmlAttributes('soft-dark', null)).toBe(' data-palette="soft-dark"');
		expect(themeHtmlAttributes(null, 'mono')).toBe(' data-font="mono"');
		expect(themeHtmlAttributes('warm-light', 'serif')).toBe(
			' data-palette="warm-light" data-font="serif"'
		);
	});
});

describe('generated cover title sizing', () => {
	it('steps large → medium → small by title length (mockup thresholds)', () => {
		expect(coverTitleSize('Alice')).toBe('lg'); // 5 chars
		expect(coverTitleSize('12345678')).toBe('lg'); // boundary: 8
		expect(coverTitleSize('Frankenstein')).toBe('md'); // 12
		expect(coverTitleSize('123456789012345678')).toBe('md'); // boundary: 18
		expect(coverTitleSize('Don Quijote de la Mancha')).toBe('sm'); // 24
	});

	it('counts code points, not UTF-16 units', () => {
		expect(coverTitleSize('ñ'.repeat(8))).toBe('lg');
	});
});
