import { describe, expect, it } from 'vitest';
import { MODE_COOKIE, modeCookie, parseMode } from './mode';

/**
 * The mode cookie (spec #24 §10). These pin the CONTRACT — the same one `theme.ts` establishes
 * for palette and typeface — rather than the implementation: the cookie's name, the fact that
 * only the two axis values parse, and the four attributes of the client write.
 */
describe('parseMode', () => {
	it('accepts exactly the two values of the axis', () => {
		expect(parseMode('normal')).toBe('normal');
		expect(parseMode('zen')).toBe('zen');
	});

	it('rejects anything else, so no cookie and a junk cookie read the same', () => {
		// The caller's `?? 'normal'` turns every one of these into the default. Nothing here
		// invents a choice the user never made, and nothing throws: a stale hand-edited cookie
		// must still open the book, exactly as a stale `?passage=N` does.
		expect(parseMode(undefined)).toBeNull();
		expect(parseMode(null)).toBeNull();
		expect(parseMode('')).toBeNull();
		expect(parseMode('Zen')).toBeNull(); // the CHECK constraint is case-sensitive too
		expect(parseMode('sprint')).toBeNull(); // a value from a mode this spec did not add
	});
});

describe('modeCookie', () => {
	it('writes the mode under its own name, site-wide, for a year, SameSite=Lax', () => {
		expect(modeCookie('zen')).toBe(`${MODE_COOKIE}=zen; path=/; max-age=31536000; samesite=lax`);
		expect(modeCookie('normal')).toBe(
			`${MODE_COOKIE}=normal; path=/; max-age=31536000; samesite=lax`
		);
	});

	it('is named apart from the theme axes', () => {
		// Mode is the MEASUREMENT axis, not a theming one (§1). The separate name is half of
		// what keeps it from drifting into `themeHtmlAttributes` and acquiring a look.
		expect(MODE_COOKIE).toBe('typefy-mode');
	});

	it('round-trips through the parser it is read back by', () => {
		const written = modeCookie('zen');
		const value = written.slice(`${MODE_COOKIE}=`.length, written.indexOf(';'));
		expect(parseMode(value)).toBe('zen');
	});
});
