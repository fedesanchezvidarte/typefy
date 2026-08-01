import { describe, expect, it } from 'vitest';
import { resolveStartIndex } from './resume';

/**
 * Resume resolver tests (spec #12 §3, spec #18 §2). The module is pure — no mocks, no
 * Supabase, no clock, and since `firstIncompleteIndex` moved into SQL, not even a chunk
 * array: this is a numbers-only module now.
 *
 * The `resolveStartIndex` cases below are the original suite carried over verbatim in
 * meaning — every rule about `?passage=N` is unchanged. Only the two inputs changed shape:
 * `chunks` became `chunkCount` (11 chunks → 11) and the completed-id `Set` became the
 * index the database already computed (0, 1, 2 complete → 3).
 *
 * `firstIncompleteIndex`'s 8 cases are gone with the function. Their subject matter — gaps
 * count, fully-complete → 0, foreign ids do not shift the answer — is pinned in
 * `e2e/resume-rpc.e2e.ts` against the real `first_incomplete_chunk_index`, which landed in
 * Phase 2 BEFORE this deletion so the rule was never unpinned.
 */

describe('resolveStartIndex', () => {
	const chunkCount = 11;
	const computed = 3; // what first_incomplete_chunk_index returns with 0, 1 and 2 complete

	it('falls back to the computed index when the param is absent (null)', () => {
		expect(resolveStartIndex(null, chunkCount, computed)).toBe(3);
	});

	it('falls back when the param is empty (?passage=)', () => {
		expect(resolveStartIndex('', chunkCount, computed)).toBe(3);
	});

	it('converts a valid 1-based passage to a 0-based index: ?passage=3 opens index 2', () => {
		expect(resolveStartIndex('3', chunkCount, computed)).toBe(2);
	});

	it('accepts the first passage: ?passage=1 opens index 0', () => {
		expect(resolveStartIndex('1', chunkCount, computed)).toBe(0);
	});

	it('accepts the last passage: ?passage=11 of 11 opens index 10', () => {
		expect(resolveStartIndex('11', chunkCount, computed)).toBe(10);
	});

	it('lets a valid override win even when it points at an already-completed passage', () => {
		expect(resolveStartIndex('1', chunkCount, computed)).toBe(0);
	});

	it('lets a valid override win even when it equals the computed index', () => {
		expect(resolveStartIndex('4', chunkCount, computed)).toBe(3);
	});

	it('falls back on a non-numeric param (?passage=abc)', () => {
		expect(resolveStartIndex('abc', chunkCount, computed)).toBe(3);
	});

	it('falls back on a numeric prefix with trailing characters (?passage=3abc)', () => {
		expect(resolveStartIndex('3abc', chunkCount, computed)).toBe(3);
	});

	it('falls back on whitespace only (?passage=%20%20)', () => {
		expect(resolveStartIndex('  ', chunkCount, computed)).toBe(3);
	});

	it('falls back on ?passage=NaN', () => {
		expect(resolveStartIndex('NaN', chunkCount, computed)).toBe(3);
	});

	it('falls back on ?passage=Infinity', () => {
		expect(resolveStartIndex('Infinity', chunkCount, computed)).toBe(3);
	});

	it('falls back on ?passage=-Infinity', () => {
		expect(resolveStartIndex('-Infinity', chunkCount, computed)).toBe(3);
	});

	it('falls back on zero (?passage=0) — the param is 1-based', () => {
		expect(resolveStartIndex('0', chunkCount, computed)).toBe(3);
	});

	it('falls back on a negative passage (?passage=-1)', () => {
		expect(resolveStartIndex('-1', chunkCount, computed)).toBe(3);
	});

	it('falls back on a fractional passage (?passage=2.5)', () => {
		expect(resolveStartIndex('2.5', chunkCount, computed)).toBe(3);
	});

	it('falls back on decimal notation of a whole number (?passage=2.0) — integer literals only', () => {
		expect(resolveStartIndex('2.0', chunkCount, computed)).toBe(3);
	});

	it('falls back on exponent notation (?passage=1e2)', () => {
		expect(resolveStartIndex('1e2', chunkCount, computed)).toBe(3);
	});

	it('falls back on hexadecimal notation (?passage=0x2)', () => {
		expect(resolveStartIndex('0x2', chunkCount, computed)).toBe(3);
	});

	it('falls back on an explicit plus sign (?passage=+2)', () => {
		expect(resolveStartIndex('+2', chunkCount, computed)).toBe(3);
	});

	it('falls back on a whitespace-padded integer (?passage=%203%20) — the param is not trimmed', () => {
		expect(resolveStartIndex(' 3 ', chunkCount, computed)).toBe(3);
	});

	it('falls back on a passage beyond the book (?passage=999 with 11 chunks)', () => {
		expect(resolveStartIndex('999', chunkCount, computed)).toBe(3);
	});

	it('falls back on the first passage past the end (?passage=12 with 11 chunks)', () => {
		expect(resolveStartIndex('12', chunkCount, computed)).toBe(3);
	});

	it('bounds the override by chunkCount, which is books.chunk_count — not how much is loaded', () => {
		// The point of the whole feature: passage 900 of a 2,000-chunk book is valid even
		// though only ten chunks will ever be in hand at once.
		expect(resolveStartIndex('900', 2000, 0)).toBe(899);
	});

	it('returns 0 for a book with no chunks whatever the param says', () => {
		expect(resolveStartIndex('1', 0, 0)).toBe(0);
		expect(resolveStartIndex('999', 0, 0)).toBe(0);
		expect(resolveStartIndex(null, 0, 0)).toBe(0);
	});

	it('opens a guest at passage 1 with no param — their computed index is always 0', () => {
		expect(resolveStartIndex(null, chunkCount, 0)).toBe(0);
	});

	it('honours ?passage=3 for a guest, who has no computed progress', () => {
		expect(resolveStartIndex('3', chunkCount, 0)).toBe(2);
	});

	it('falls back to the gap the database computed when the param is invalid', () => {
		expect(resolveStartIndex('abc', chunkCount, 1)).toBe(1);
	});

	it('opens a fully completed book at passage 1 when the param is invalid', () => {
		// first_incomplete_chunk_index returns 0 for a fully completed book — there is no
		// "you have finished" state (CONTEXT.md, Resume).
		expect(resolveStartIndex('0', 3, 0)).toBe(0);
	});
});

describe('resolveStartIndex — defending the computed index across the RPC boundary', () => {
	it('clamps a computed index beyond the last chunk to the last chunk', () => {
		// A shrinking re-ingest between the RPC call and the window read would otherwise
		// open a session on a chunk that no longer exists.
		expect(resolveStartIndex(null, 5, 99)).toBe(4);
	});

	it('clamps a negative computed index to 0', () => {
		expect(resolveStartIndex(null, 5, -1)).toBe(0);
	});

	it('floors a fractional computed index', () => {
		expect(resolveStartIndex(null, 5, 2.9)).toBe(2);
	});

	it('falls back to 0 for a non-finite computed index rather than opening on NaN', () => {
		expect(resolveStartIndex(null, 5, Number.NaN)).toBe(0);
		expect(resolveStartIndex(null, 5, Number.POSITIVE_INFINITY)).toBe(0);
	});

	it('returns 0 for an empty book even when the computed index is not 0', () => {
		expect(resolveStartIndex(null, 0, 7)).toBe(0);
	});

	it('tolerates a non-finite chunkCount by refusing every override and returning 0', () => {
		expect(resolveStartIndex('3', Number.NaN, 2)).toBe(0);
	});
});
