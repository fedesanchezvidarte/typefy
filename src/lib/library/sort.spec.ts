import { describe, expect, it } from 'vitest';
import type { TypeableTextSummary } from '$lib/types';
import { BOOK_SORTS, parseBookSort, sortBooks } from './sort.js';

/**
 * The `?sort` catalog ordering (spec #25 §2). Pure: `sortBooks` takes the locale as an
 * argument (Paraglide's `getLocale()` is a UI concern the caller resolves), so this module
 * needs neither SvelteKit nor Paraglide — same posture as `language-filter.ts`.
 */

function book(overrides: Partial<TypeableTextSummary>): TypeableTextSummary {
	return {
		id: 'x',
		bookId: 'uuid-x',
		title: 'X',
		author: 'Y',
		language: 'en',
		chunkCount: 1,
		coverUrl: null,
		...overrides
	};
}

describe('BOOK_SORTS', () => {
	it('offers default, title and length', () => {
		expect(BOOK_SORTS).toEqual(['default', 'title', 'length']);
	});
});

describe('parseBookSort', () => {
	it('accepts each of the three sorts', () => {
		for (const value of BOOK_SORTS) {
			expect(parseBookSort(value)).toBe(value);
		}
	});

	it('falls back to default when missing', () => {
		expect(parseBookSort(null)).toBe('default');
		expect(parseBookSort(undefined)).toBe('default');
	});

	it('falls back to default on an empty string', () => {
		expect(parseBookSort('')).toBe('default');
	});

	it('falls back to default on an unrecognised value, silently', () => {
		expect(parseBookSort('popularity')).toBe('default');
	});

	it('is case-sensitive: `Title` is not `title`, and falls back', () => {
		expect(parseBookSort('Title')).toBe('default');
	});

	it('never throws, whatever it is handed', () => {
		expect(() => parseBookSort(['title', 'length'])).not.toThrow();
		expect(parseBookSort(7)).toBe('default');
	});
});

describe('sortBooks', () => {
	const books = [
		book({ id: 'zorro', title: 'Zorro', chunkCount: 20 }),
		book({ id: 'alpha', title: 'Álvarez', chunkCount: 5 }),
		book({ id: 'mid', title: 'Middlemarch', chunkCount: 12 })
	];

	it('default is a no-op — preserves the incoming order', () => {
		expect(sortBooks(books, 'default', 'en')).toEqual(books);
	});

	it('title sorts with a locale-aware collator, base sensitivity', () => {
		const sorted = sortBooks(books, 'title', 'en');
		expect(sorted.map((b) => b.id)).toEqual(['alpha', 'mid', 'zorro']);
	});

	it('title sort is accent-insensitive at base sensitivity (Álvarez sorts with A, not after Z)', () => {
		const sorted = sortBooks(books, 'title', 'en');
		expect(sorted[0].id).toBe('alpha');
	});

	it('length sorts ascending by chunkCount', () => {
		const sorted = sortBooks(books, 'length', 'en');
		expect(sorted.map((b) => b.id)).toEqual(['alpha', 'mid', 'zorro']);
	});

	it('does not mutate the input array', () => {
		const copy = [...books];
		sortBooks(books, 'title', 'en');
		expect(books).toEqual(copy);
	});

	it('returns a new array even for default (no-op means order, not identity)', () => {
		const sorted = sortBooks(books, 'default', 'en');
		expect(sorted).not.toBe(books);
	});

	it.each(BOOK_SORTS)('%s on an empty list is an empty list, not an error', (sort) => {
		expect(sortBooks([], sort, 'en')).toEqual([]);
	});

	it('title sort is stable: identical titles keep their incoming relative order', () => {
		const tied = [
			book({ id: 'first', title: 'Same Title', chunkCount: 1 }),
			book({ id: 'second', title: 'Same Title', chunkCount: 2 }),
			book({ id: 'third', title: 'Same Title', chunkCount: 3 })
		];
		expect(sortBooks(tied, 'title', 'en').map((b) => b.id)).toEqual(['first', 'second', 'third']);
	});

	it('length sort is stable: identical chunk counts keep their incoming relative order', () => {
		const tied = [
			book({ id: 'first', title: 'A', chunkCount: 4 }),
			book({ id: 'second', title: 'B', chunkCount: 4 }),
			book({ id: 'third', title: 'C', chunkCount: 4 })
		];
		expect(sortBooks(tied, 'length', 'en').map((b) => b.id)).toEqual(['first', 'second', 'third']);
	});
});
