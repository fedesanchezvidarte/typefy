import { describe, expect, it } from 'vitest';
import {
	MAX_WINDOW_LIMIT,
	PREFETCH_THRESHOLD,
	WINDOW_SIZE,
	clampWindow,
	seekWindow,
	shouldPrefetch,
	windowEnd
} from './window';

/**
 * Window bounds tests (spec #18 §1). The module is pure — no Supabase, no clock, no DOM —
 * so every clamp case is reachable without a mock. That is the whole reason the constants
 * live next to the clamp they parameterise rather than in a bare constants file.
 */

describe('constants', () => {
	/*
	 * Retuned for the page model (spec #32 §3.5). Pages under the dual budget run the real
	 * catalog's measured mean (1211 chars/page over the 12 catalog books, ~2.4x the pre-5b
	 * passage) rather than the pre-5b ~500-character passage, so the pre-5b 10/3 pair would
	 * deliver ~3x more text per window than intended.
	 */
	it('fixes the window at 4 chunks and the prefetch trigger at 1 remaining', () => {
		expect(WINDOW_SIZE).toBe(4);
		expect(PREFETCH_THRESHOLD).toBe(1);
	});

	it('keeps the refire gap strictly positive: a fresh window never re-triggers its own prefetch', () => {
		// loadedEnd - activeIndex === WINDOW_SIZE the instant a window lands (activeIndex sits
		// at its first chunk); that gap must stay > PREFETCH_THRESHOLD or the very next tick
		// fetches a second window before the reader has moved at all.
		expect(WINDOW_SIZE).toBeGreaterThan(PREFETCH_THRESHOLD);
	});

	it('caps a requested limit at the window size — the endpoint is not a whole-book download', () => {
		expect(MAX_WINDOW_LIMIT).toBe(WINDOW_SIZE);
	});
});

describe('clampWindow', () => {
	it('passes a fully in-range window through unchanged', () => {
		expect(clampWindow(0, 2, 100)).toEqual({ from: 0, limit: 2 });
		expect(clampWindow(37, 2, 100)).toEqual({ from: 37, limit: 2 });
	});

	it('clamps a negative from to 0 without touching the limit', () => {
		expect(clampWindow(-5, 2, 100)).toEqual({ from: 0, limit: 2 });
	});

	it('returns the remainder when the window overruns the last chunk', () => {
		// 98..100 requested (limit 3) of a 100-chunk book: only 98..99 exist.
		expect(clampWindow(98, 3, 100)).toEqual({ from: 98, limit: 2 });
	});

	it('returns exactly the remainder when from is the last chunk', () => {
		expect(clampWindow(99, 3, 100)).toEqual({ from: 99, limit: 1 });
	});

	it('yields an empty window when from equals chunkCount — a 200, not an error', () => {
		expect(clampWindow(100, 10, 100)).toEqual({ from: 100, limit: 0 });
	});

	it('yields an empty window when from is far beyond the last chunk', () => {
		expect(clampWindow(9999, 10, 100)).toEqual({ from: 9999, limit: 0 });
	});

	it('clamps a limit above MAX_WINDOW_LIMIT down to the maximum', () => {
		expect(clampWindow(0, 5000, 100)).toEqual({ from: 0, limit: MAX_WINDOW_LIMIT });
	});

	it('clamps the limit to the maximum BEFORE clamping to the remainder', () => {
		// Requesting 5000 from index 97 of 100 must not smuggle 3 chunks past the cap
		// by way of the remainder — both clamps apply, smallest wins.
		expect(clampWindow(97, 5000, 100)).toEqual({ from: 97, limit: 3 });
	});

	it('clamps a negative limit to 0 rather than producing a reversed range', () => {
		expect(clampWindow(10, -1, 100)).toEqual({ from: 10, limit: 0 });
	});

	it('passes a zero limit through as an empty window', () => {
		expect(clampWindow(10, 0, 100)).toEqual({ from: 10, limit: 0 });
	});

	it('yields an empty window for a book with no chunks', () => {
		expect(clampWindow(0, 10, 0)).toEqual({ from: 0, limit: 0 });
	});

	it('treats a negative chunkCount as an empty book rather than a reversed range', () => {
		expect(clampWindow(0, 10, -3)).toEqual({ from: 0, limit: 0 });
	});

	it('floors fractional bounds instead of producing a fractional range', () => {
		expect(clampWindow(2.9, 4.7, 100)).toEqual({ from: 2, limit: 4 });
	});

	it('falls back to an empty window at 0 for non-finite input — never throws', () => {
		expect(clampWindow(Number.NaN, 2, 100)).toEqual({ from: 0, limit: 2 });
		expect(clampWindow(0, Number.NaN, 100)).toEqual({ from: 0, limit: 0 });
		expect(clampWindow(0, 2, Number.NaN)).toEqual({ from: 0, limit: 0 });
		expect(clampWindow(Number.POSITIVE_INFINITY, 2, 100)).toEqual({ from: 0, limit: 2 });
	});
});

describe('windowEnd', () => {
	it('is the absolute index one past the last loaded chunk', () => {
		expect(windowEnd(0, 10)).toBe(10);
		expect(windowEnd(90, 10)).toBe(100);
	});

	it('equals from for an empty window', () => {
		expect(windowEnd(100, 0)).toBe(100);
	});
});

/*
 * The A' engine seek (spec #32 §10 D1): the window bounds for a deliberate jump. Unlike a
 * prefetch, which always starts exactly at `loadedEnd`, a seek anchors a fresh window AT the
 * target index — the caller is expected to REPLACE its loaded window with this range rather
 * than merge it in, which is the session-level half of the same feature (`session.spec.ts`'s
 * "applySessionEvent — seek").
 */
describe('seekWindow', () => {
	it('anchors the window at the seek target', () => {
		expect(seekWindow(400, 1000)).toEqual({ from: 400, limit: WINDOW_SIZE });
	});

	it('is exactly clampWindow(index, WINDOW_SIZE, chunkCount) — one clamp, not a second copy', () => {
		expect(seekWindow(97, 100)).toEqual(clampWindow(97, WINDOW_SIZE, 100));
		expect(seekWindow(0, 3)).toEqual(clampWindow(0, WINDOW_SIZE, 3));
	});

	it('never returns a window that runs past the end of the book', () => {
		const bounds = seekWindow(998, 1000);
		expect(bounds.from + bounds.limit).toBeLessThanOrEqual(1000);
	});

	it('yields an empty window for a seek past the end of the book, rather than throwing', () => {
		expect(seekWindow(5000, 1000)).toEqual({ from: 5000, limit: 0 });
	});
});

describe('shouldPrefetch', () => {
	const chunkCount = 100;
	const loadedEnd = 10;

	// Derived from PREFETCH_THRESHOLD rather than a hardcoded literal, so these cases keep
	// meaning whatever the constant is retuned to next (spec #32 §3.5 retuned it once already).
	const atThreshold = loadedEnd - PREFETCH_THRESHOLD;

	it('is false well short of the threshold', () => {
		expect(shouldPrefetch(0, loadedEnd, chunkCount)).toBe(false);
		if (atThreshold - 1 >= 0) {
			expect(shouldPrefetch(atThreshold - 1, loadedEnd, chunkCount)).toBe(false);
		}
	});

	it('fires at exactly PREFETCH_THRESHOLD chunks remaining', () => {
		expect(shouldPrefetch(atThreshold, loadedEnd, chunkCount)).toBe(true);
	});

	it('stays true for every index past the threshold', () => {
		for (let index = atThreshold; index < loadedEnd; index += 1) {
			expect(shouldPrefetch(index, loadedEnd, chunkCount)).toBe(true);
		}
	});

	it('is true when the active index has run past the loaded end (awaiting)', () => {
		expect(shouldPrefetch(loadedEnd, loadedEnd, chunkCount)).toBe(true);
	});

	it('is false when everything is already loaded, however few chunks remain', () => {
		expect(shouldPrefetch(99, 100, chunkCount)).toBe(false);
		expect(shouldPrefetch(97, 100, chunkCount)).toBe(false);
	});

	it('is false for a book shorter than one window — it never needs a second one', () => {
		expect(shouldPrefetch(0, 3, 3)).toBe(false);
		expect(shouldPrefetch(2, 3, 3)).toBe(false);
	});

	it('never asks for more than the book holds when loadedEnd overshoots chunkCount', () => {
		expect(shouldPrefetch(9, 12, 10)).toBe(false);
	});
});
