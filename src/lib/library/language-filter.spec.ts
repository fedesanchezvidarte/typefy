import { describe, expect, it } from 'vitest';
import { LANGUAGE_FILTERS, defaultLanguageFilter, parseLanguageFilter } from './language-filter.js';

/**
 * The `?lang` filter (spec #19 §4). Pure: the URL and the locale are both passed in, so this
 * spec needs neither SvelteKit nor Paraglide.
 */

describe('LANGUAGE_FILTERS', () => {
	it('offers both content languages and `all`, so nothing is unreachable', () => {
		expect([...LANGUAGE_FILTERS].sort()).toEqual(['all', 'en', 'es']);
	});
});

describe('parseLanguageFilter', () => {
	it('accepts each of the three filters', () => {
		for (const value of LANGUAGE_FILTERS) {
			expect(parseLanguageFilter(value, 'en')).toBe(value);
		}
	});

	it('falls back when the parameter is absent', () => {
		expect(parseLanguageFilter(null, 'es')).toBe('es');
		expect(parseLanguageFilter(undefined, 'en')).toBe('en');
	});

	it('falls back on an empty string', () => {
		expect(parseLanguageFilter('', 'en')).toBe('en');
	});

	it('falls back on an unknown language rather than erroring', () => {
		// A hand-edited or stale link must still open the page — the `?passage=N` posture.
		expect(parseLanguageFilter('fr', 'es')).toBe('es');
	});

	it('is case-sensitive: `EN` is not `en`, and falls back', () => {
		// One canonical spelling per filter keeps the active state and the shared URL unambiguous.
		expect(parseLanguageFilter('EN', 'es')).toBe('es');
	});

	it('falls back on a value that is not a string at all', () => {
		expect(parseLanguageFilter(['en', 'es'], 'en')).toBe('en');
		expect(parseLanguageFilter(7, 'all')).toBe('all');
	});

	it('never throws, whatever it is handed', () => {
		expect(() => parseLanguageFilter({ lang: 'en' }, 'en')).not.toThrow();
	});
});

describe('defaultLanguageFilter', () => {
	it('starts an English UI on English books and a Spanish UI on Spanish books', () => {
		expect(defaultLanguageFilter('en')).toBe('en');
		expect(defaultLanguageFilter('es')).toBe('es');
	});

	it('falls back to English for a locale with no content language', () => {
		// The mapping is explicit, not a cast: UI locale and content language are different
		// vocabularies that happen to share two strings (CONTEXT.md locale independence).
		expect(defaultLanguageFilter('fr')).toBe('en');
		expect(defaultLanguageFilter('')).toBe('en');
	});

	it('never defaults to `all` — a visitor sees books they can read', () => {
		for (const locale of ['en', 'es', 'de']) {
			expect(defaultLanguageFilter(locale)).not.toBe('all');
		}
	});
});
