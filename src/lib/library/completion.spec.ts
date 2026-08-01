import { describe, expect, it } from 'vitest';
import { completionPercent } from './completion.js';
import type { TypeableTextSummary } from '$lib/types';

function book(chunkCount: number): TypeableTextSummary {
	return {
		id: 'a-book',
		bookId: 'uuid-a-book',
		title: 'A Book',
		author: 'Anon',
		language: 'en',
		chunkCount,
		coverUrl: null
	};
}

describe('completionPercent', () => {
	it('is the share of the book’s passages completed, rounded', () => {
		expect(completionPercent(book(10), 5)).toBe(50);
		expect(completionPercent(book(3), 1)).toBe(33);
		expect(completionPercent(book(3), 2)).toBe(67);
	});

	it('is 0 for a book never attempted', () => {
		expect(completionPercent(book(10), 0)).toBe(0);
	});

	it('is 100 for a completed book', () => {
		expect(completionPercent(book(10), 10)).toBe(100);
	});

	it('returns 0 rather than NaN for a book seeded with no chunks', () => {
		// `books.chunk_count` defaults to 0, and dividing by it rendered "NaN%" in the template
		// this guard came from. It has never had a test until now.
		expect(completionPercent(book(0), 0)).toBe(0);
		expect(completionPercent(book(0), 4)).toBe(0);
	});
});
