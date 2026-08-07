import { describe, expect, it } from 'vitest';
import { matchesSearch, normalizeForSearch, parseSearchQuery } from './search.js';

/**
 * The `?q` catalog search (spec #25 §2). Pure: matching happens on data already fetched by
 * `listBooks`, so this module needs neither SvelteKit nor Supabase — same posture as
 * `language-filter.ts`.
 */

describe('parseSearchQuery', () => {
	it('accepts a non-empty string as-is', () => {
		expect(parseSearchQuery('Pride')).toBe('Pride');
	});

	it('treats null as "no search"', () => {
		expect(parseSearchQuery(null)).toBeNull();
	});

	it('treats undefined as "no search"', () => {
		expect(parseSearchQuery(undefined)).toBeNull();
	});

	it('treats an empty string as "no search"', () => {
		expect(parseSearchQuery('')).toBeNull();
	});

	it('treats a whitespace-only string as "no search"', () => {
		expect(parseSearchQuery('   ')).toBeNull();
		expect(parseSearchQuery('\t\n')).toBeNull();
	});

	it('treats a value that is not a string at all as "no search"', () => {
		// A query parameter can repeat, arriving as an array; never throw on it.
		expect(parseSearchQuery(['a', 'b'])).toBeNull();
		expect(parseSearchQuery(7)).toBeNull();
	});

	it('preserves internal whitespace and surrounding content, only rejecting all-whitespace', () => {
		expect(parseSearchQuery('  Pride and Prejudice  ')).toBe('  Pride and Prejudice  ');
	});
});

describe('normalizeForSearch', () => {
	it('lowercases', () => {
		expect(normalizeForSearch('PRIDE')).toBe('pride');
	});

	it('strips accents via NFD + combining-diacritical removal', () => {
		expect(normalizeForSearch('Cervantes')).toBe('cervantes');
		expect(normalizeForSearch('Ñandú')).toBe('nandu');
		expect(normalizeForSearch('café')).toBe('cafe');
	});

	it('is idempotent — normalizing an already-normalized string changes nothing', () => {
		const once = normalizeForSearch('Ñandú Café');
		expect(normalizeForSearch(once)).toBe(once);
	});
});

describe('matchesSearch', () => {
	const book = { title: 'Don Quijote de la Mancha', author: 'Miguel de Cervantes' };

	it('matches a substring of the title', () => {
		expect(matchesSearch(book, 'Quijote')).toBe(true);
	});

	it('matches a substring of the author', () => {
		expect(matchesSearch(book, 'Cervantes')).toBe(true);
	});

	it('is case-insensitive', () => {
		expect(matchesSearch(book, 'quijote')).toBe(true);
		expect(matchesSearch(book, 'CERVANTES')).toBe(true);
	});

	it('is accent-insensitive', () => {
		expect(matchesSearch({ title: 'Ñandú', author: 'Anon' }, 'nandu')).toBe(true);
		expect(matchesSearch({ title: 'Nandu', author: 'Anon' }, 'ñandú')).toBe(true);
	});

	it('rejects a query that matches neither title nor author', () => {
		expect(matchesSearch(book, 'Frankenstein')).toBe(false);
	});

	it('matches anywhere in the string, not just a prefix', () => {
		expect(matchesSearch(book, 'Mancha')).toBe(true);
	});

	it('matches everything on an all-whitespace query — turning that into "no search" is parseSearchQuery\'s job, not this one\'s', () => {
		// `matchesSearch` trusts its caller (`parseSearchQuery`) to have already turned
		// whitespace-only input into `null` before it ever reaches here; called directly with
		// one anyway, it degrades to "no needle" rather than throwing or matching nothing.
		expect(matchesSearch(book, '   ')).toBe(true);
	});

	it('handles an extremely long query without throwing, and correctly finds no match', () => {
		// Longer than any real field, and not a substring of one — nothing to find, and
		// nothing pathological about looking.
		const veryLong = 'x'.repeat(5000);
		expect(() => matchesSearch(book, veryLong)).not.toThrow();
		expect(matchesSearch(book, veryLong)).toBe(false);
	});

	it('matching runs query-in-field, never field-in-query: a long query merely CONTAINING a real title is not a match', () => {
		const padded = `${'x'.repeat(5000)}Quijote${'y'.repeat(5000)}`;
		expect(matchesSearch(book, padded)).toBe(false);
	});
});
