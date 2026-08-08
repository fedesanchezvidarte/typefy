import { describe, expect, it } from 'vitest';
import {
	DEFAULT_LANGUAGE_FILTER,
	LANGUAGE_FILTERS,
	parseLanguageFilter
} from './language-filter.js';

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

describe('DEFAULT_LANGUAGE_FILTER', () => {
	it('is `all` — an unparameterised /type shows the whole library', () => {
		expect(DEFAULT_LANGUAGE_FILTER).toBe('all');
	});

	it('is one of the offered filters, so the default is always reachable from the control', () => {
		expect(LANGUAGE_FILTERS).toContain(DEFAULT_LANGUAGE_FILTER);
	});
});
