import { describe, expect, it } from 'vitest';
import type { Chunk } from '$lib/types';
import { firstIncompleteIndex, resolveStartIndex } from './resume';

/**
 * Resume resolver tests (spec #12 §3, Phase D). The module is pure — no mocks, no
 * Supabase, no clock. Fixtures are built inline rather than imported from the DB
 * fixtures so each case states exactly the shape it depends on.
 */

/** Realistic-looking chunks uuid, distinct per index. */
function chunkId(index: number): string {
	return `c0000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

const BOOK_ID = 'b0000000-0000-4000-8000-000000000001';

/** `count` chunks, ordered by `index` exactly as `getBookBySlug` returns them. */
function makeChunks(count: number): Chunk[] {
	return Array.from({ length: count }, (_, index) => ({
		id: chunkId(index),
		textId: 'don-quijote',
		index,
		content: `Passage ${index + 1} content.`,
		charCount: 24
	}));
}

/** The completed-chunk-id set `getCompletedChunkIds` produces, by array position. */
function completed(...positions: number[]): ReadonlySet<string> {
	return new Set(positions.map(chunkId));
}

describe('firstIncompleteIndex', () => {
	it('returns 0 for a guest, whose completed set is empty', () => {
		expect(firstIncompleteIndex(makeChunks(11), new Set())).toBe(0);
	});

	it('returns 3 when passages 1-3 are complete', () => {
		expect(firstIncompleteIndex(makeChunks(11), completed(0, 1, 2))).toBe(3);
	});

	it('returns the gap: with 0 and 2 complete and 1 not, it returns 1', () => {
		expect(firstIncompleteIndex(makeChunks(11), completed(0, 2))).toBe(1);
	});

	it('returns 0 when only later passages are complete', () => {
		expect(firstIncompleteIndex(makeChunks(4), completed(1, 2, 3))).toBe(0);
	});

	it('returns 0 for a fully completed book — there is no "you have finished" state', () => {
		expect(firstIncompleteIndex(makeChunks(3), completed(0, 1, 2))).toBe(0);
	});

	it('returns 0 for an empty chunks array — never -1, never NaN', () => {
		const result = firstIncompleteIndex([], completed(0, 1));
		expect(result).toBe(0);
	});

	it('matches by chunk id, not by array position', () => {
		// The set holds ids from another book entirely: nothing matches, so the
		// answer must be 0 rather than "the set has 2 entries, so start at 2".
		const foreign = new Set(['ffffffff-0000-4000-8000-000000000000', BOOK_ID]);
		expect(firstIncompleteIndex(makeChunks(5), foreign)).toBe(0);
	});

	it('returns the array position, not the chunk.index field, when they disagree', () => {
		// Defensive: a caller that hands over a filtered slice still gets a position
		// that is valid against the array it passed.
		const chunks: Chunk[] = [
			{ id: chunkId(5), textId: 'don-quijote', index: 5, content: 'a', charCount: 1 },
			{ id: chunkId(6), textId: 'don-quijote', index: 6, content: 'b', charCount: 1 }
		];
		expect(firstIncompleteIndex(chunks, completed(5))).toBe(1);
	});

	it('ignores completed ids that are not in this book', () => {
		const set = new Set([chunkId(0), 'aaaaaaaa-0000-4000-8000-000000000000']);
		expect(firstIncompleteIndex(makeChunks(3), set)).toBe(1);
	});
});

describe('resolveStartIndex', () => {
	const chunks = makeChunks(11);
	const progress = completed(0, 1, 2); // computed index is 3

	it('falls back to the computed index when the param is absent (null)', () => {
		expect(resolveStartIndex(chunks, progress, null)).toBe(3);
	});

	it('falls back when the param is empty (?passage=)', () => {
		expect(resolveStartIndex(chunks, progress, '')).toBe(3);
	});

	it('converts a valid 1-based passage to a 0-based index: ?passage=3 opens index 2', () => {
		expect(resolveStartIndex(chunks, progress, '3')).toBe(2);
	});

	it('accepts the first passage: ?passage=1 opens index 0', () => {
		expect(resolveStartIndex(chunks, progress, '1')).toBe(0);
	});

	it('accepts the last passage: ?passage=11 of 11 opens index 10', () => {
		expect(resolveStartIndex(chunks, progress, '11')).toBe(10);
	});

	it('lets a valid override win even when it points at an already-completed passage', () => {
		expect(resolveStartIndex(chunks, progress, '1')).toBe(0);
	});

	it('lets a valid override win even when it equals the computed index', () => {
		expect(resolveStartIndex(chunks, progress, '4')).toBe(3);
	});

	it('falls back on a non-numeric param (?passage=abc)', () => {
		expect(resolveStartIndex(chunks, progress, 'abc')).toBe(3);
	});

	it('falls back on a numeric prefix with trailing characters (?passage=3abc)', () => {
		expect(resolveStartIndex(chunks, progress, '3abc')).toBe(3);
	});

	it('falls back on whitespace only (?passage=%20%20)', () => {
		expect(resolveStartIndex(chunks, progress, '  ')).toBe(3);
	});

	it('falls back on ?passage=NaN', () => {
		expect(resolveStartIndex(chunks, progress, 'NaN')).toBe(3);
	});

	it('falls back on ?passage=Infinity', () => {
		expect(resolveStartIndex(chunks, progress, 'Infinity')).toBe(3);
	});

	it('falls back on ?passage=-Infinity', () => {
		expect(resolveStartIndex(chunks, progress, '-Infinity')).toBe(3);
	});

	it('falls back on zero (?passage=0) — the param is 1-based', () => {
		expect(resolveStartIndex(chunks, progress, '0')).toBe(3);
	});

	it('falls back on a negative passage (?passage=-1)', () => {
		expect(resolveStartIndex(chunks, progress, '-1')).toBe(3);
	});

	it('falls back on a fractional passage (?passage=2.5)', () => {
		expect(resolveStartIndex(chunks, progress, '2.5')).toBe(3);
	});

	it('falls back on decimal notation of a whole number (?passage=2.0) — integer literals only', () => {
		expect(resolveStartIndex(chunks, progress, '2.0')).toBe(3);
	});

	it('falls back on exponent notation (?passage=1e2)', () => {
		expect(resolveStartIndex(chunks, progress, '1e2')).toBe(3);
	});

	it('falls back on hexadecimal notation (?passage=0x2)', () => {
		expect(resolveStartIndex(chunks, progress, '0x2')).toBe(3);
	});

	it('falls back on an explicit plus sign (?passage=+2)', () => {
		expect(resolveStartIndex(chunks, progress, '+2')).toBe(3);
	});

	it('falls back on a whitespace-padded integer (?passage=%203%20) — the param is not trimmed', () => {
		expect(resolveStartIndex(chunks, progress, ' 3 ')).toBe(3);
	});

	it('falls back on a passage beyond the book (?passage=999 with 11 chunks)', () => {
		expect(resolveStartIndex(chunks, progress, '999')).toBe(3);
	});

	it('falls back on the first passage past the end (?passage=12 with 11 chunks)', () => {
		expect(resolveStartIndex(chunks, progress, '12')).toBe(3);
	});

	it('returns 0 for an empty chunks array whatever the param says', () => {
		expect(resolveStartIndex([], progress, '1')).toBe(0);
		expect(resolveStartIndex([], progress, '999')).toBe(0);
		expect(resolveStartIndex([], progress, null)).toBe(0);
	});

	it('opens a guest at passage 1 with no param', () => {
		expect(resolveStartIndex(chunks, new Set(), null)).toBe(0);
	});

	it('honours ?passage=3 for a guest, who has no computed progress', () => {
		expect(resolveStartIndex(chunks, new Set(), '3')).toBe(2);
	});

	it('falls back to the gap when the param is invalid: 0 and 2 complete, 1 not', () => {
		expect(resolveStartIndex(chunks, completed(0, 2), 'abc')).toBe(1);
	});

	it('opens a fully completed book at passage 1 when the param is invalid', () => {
		const short = makeChunks(3);
		expect(resolveStartIndex(short, completed(0, 1, 2), '0')).toBe(0);
	});
});
