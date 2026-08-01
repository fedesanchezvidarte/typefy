import { describe, expect, it } from 'vitest';
import { CONTINUE_READING_LIMIT, selectContinueReading } from './continue-reading.js';
import type { BookActivity, TypeableTextSummary } from '$lib/types';

/**
 * The continue-reading selection (spec #19 §5). Pure: the books arrive ALREADY
 * language-filtered and the activity map is the rollup read the load already makes, so this
 * spec needs no Supabase and no clock.
 */

function book(slug: string, chunkCount = 10): TypeableTextSummary {
	return {
		id: slug,
		bookId: `uuid-${slug}`,
		title: slug,
		author: 'Anon',
		language: 'en',
		chunkCount,
		coverUrl: null
	};
}

function activity(entries: Record<string, [number, string | null]>): Map<string, BookActivity> {
	return new Map(
		Object.entries(entries).map(([slug, [chunksCompleted, lastActiveAt]]) => [
			`uuid-${slug}`,
			{ chunksCompleted, lastActiveAt }
		])
	);
}

const slugs = (books: readonly TypeableTextSummary[]) => books.map((b) => b.id);

describe('selectContinueReading', () => {
	it('keeps a book that is started but not finished', () => {
		const books = [book('a')];
		const selected = selectContinueReading(books, activity({ a: [3, '2026-07-01T10:00:00Z'] }));
		expect(slugs(selected)).toEqual(['a']);
	});

	it('excludes a book with no activity row at all', () => {
		expect(selectContinueReading([book('a')], new Map())).toEqual([]);
	});

	it('excludes a book that has been opened but never completed a passage', () => {
		// The trigger writes chunks_completed = 0 on the first incomplete attempt, so the row
		// exists; "opened" is not "in progress".
		expect(
			selectContinueReading([book('a')], activity({ a: [0, '2026-07-01T10:00:00Z'] }))
		).toEqual([]);
	});

	it('excludes a completed book — offering a 100% book as "continue" is a false claim', () => {
		const books = [book('a', 10)];
		expect(selectContinueReading(books, activity({ a: [10, '2026-07-01T10:00:00Z'] }))).toEqual([]);
	});

	it('excludes a book whose count exceeds its chunk count, as after an --allow-shrink re-ingest', () => {
		const books = [book('a', 10)];
		expect(selectContinueReading(books, activity({ a: [12, '2026-07-01T10:00:00Z'] }))).toEqual([]);
	});

	it('orders by last activity, most recent first', () => {
		const books = [book('old'), book('newest'), book('middle')];
		const selected = selectContinueReading(
			books,
			activity({
				old: [1, '2026-06-01T00:00:00Z'],
				newest: [1, '2026-07-20T00:00:00Z'],
				middle: [1, '2026-07-01T00:00:00Z']
			})
		);
		expect(slugs(selected)).toEqual(['newest', 'middle', 'old']);
	});

	it('sorts rows with no timestamp last', () => {
		const books = [book('untimed'), book('timed')];
		const selected = selectContinueReading(
			books,
			activity({ untimed: [1, null], timed: [1, '2026-01-01T00:00:00Z'] })
		);
		expect(slugs(selected)).toEqual(['timed', 'untimed']);
	});

	it('breaks a tie by slug ascending, so the order is deterministic', () => {
		const at = '2026-07-01T00:00:00Z';
		const books = [book('zebra'), book('apple'), book('mango')];
		const selected = selectContinueReading(
			books,
			activity({ zebra: [1, at], apple: [1, at], mango: [1, at] })
		);
		expect(slugs(selected)).toEqual(['apple', 'mango', 'zebra']);
	});

	it('breaks a tie between two untimed rows by slug too', () => {
		const books = [book('zebra'), book('apple')];
		const selected = selectContinueReading(books, activity({ zebra: [1, null], apple: [1, null] }));
		expect(slugs(selected)).toEqual(['apple', 'zebra']);
	});

	it('takes at most three books by default', () => {
		const books = ['a', 'b', 'c', 'd', 'e'].map((slug) => book(slug));
		const entries = Object.fromEntries(
			['a', 'b', 'c', 'd', 'e'].map((slug, index) => [
				slug,
				[1, `2026-07-0${index + 1}T00:00:00Z`] as [number, string]
			])
		);
		const selected = selectContinueReading(books, activity(entries));
		expect(selected).toHaveLength(CONTINUE_READING_LIMIT);
		expect(slugs(selected)).toEqual(['e', 'd', 'c']);
	});

	it('honours an explicit limit', () => {
		const books = [book('a'), book('b')];
		const selected = selectContinueReading(
			books,
			activity({ a: [1, '2026-07-02T00:00:00Z'], b: [1, '2026-07-01T00:00:00Z'] }),
			1
		);
		expect(slugs(selected)).toEqual(['a']);
	});

	it('returns fewer than the limit rather than padding', () => {
		expect(selectContinueReading([book('a')], activity({ a: [1, null] }))).toHaveLength(1);
	});

	it('returns nothing for a guest, whose activity map is empty', () => {
		expect(selectContinueReading([book('a'), book('b')], new Map())).toEqual([]);
	});

	it('cannot contradict the language filter, because it selects from the filtered list', () => {
		// The es book is absent from `books` (the load filtered it out), so it cannot appear
		// here even though the user is mid-way through it.
		const books = [book('en-book')];
		const selected = selectContinueReading(
			books,
			activity({ 'en-book': [1, '2026-07-01T00:00:00Z'], 'es-book': [1, '2026-07-09T00:00:00Z'] })
		);
		expect(slugs(selected)).toEqual(['en-book']);
	});

	it('returns references into `books`, not copies, so devalue dedupes the duplicated cards', () => {
		const books = [book('a')];
		const selected = selectContinueReading(books, activity({ a: [1, '2026-07-01T00:00:00Z'] }));
		expect(selected[0]).toBe(books[0]);
	});

	it('does not mutate or reorder the books it was given', () => {
		const books = [book('a'), book('b')];
		const before = [...books];
		selectContinueReading(
			books,
			activity({ a: [1, '2026-07-01T00:00:00Z'], b: [1, '2026-07-09T00:00:00Z'] })
		);
		expect(books).toEqual(before);
	});
});
