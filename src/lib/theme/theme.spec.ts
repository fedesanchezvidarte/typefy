import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
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

describe('fonts', () => {
	it('ships sans, serif and mono, defaulting to sans', () => {
		expect(FONT_IDS).toEqual(['sans', 'serif', 'mono']);
		expect(DEFAULT_FONT).toBe('sans');
	});

	it('every stack self-hosts an IBM Plex face with a generic fallback', () => {
		expect(FONTS.sans.stack).toMatch(/^'IBM Plex Sans'.*sans-serif$/);
		expect(FONTS.serif.stack).toMatch(/^'IBM Plex Serif'.*serif$/);
		expect(FONTS.mono.stack).toMatch(/^'IBM Plex Mono'.*monospace$/);
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
