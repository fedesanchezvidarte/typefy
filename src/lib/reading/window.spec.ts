import { describe, expect, it } from 'vitest';
import {
	MAX_WINDOW_LIMIT,
	PREFETCH_THRESHOLD,
	WINDOW_SIZE,
	clampWindow,
	shouldPrefetch,
	windowEnd
} from './window';

/**
 * Window bounds tests (spec #18 §1). The module is pure — no Supabase, no clock, no DOM —
 * so every clamp case is reachable without a mock. That is the whole reason the constants
 * live next to the clamp they parameterise rather than in a bare constants file.
 */

describe('constants', () => {
	it('fixes the window at 10 chunks and the prefetch trigger at 3 remaining', () => {
		expect(WINDOW_SIZE).toBe(10);
		expect(PREFETCH_THRESHOLD).toBe(3);
	});

	it('caps a requested limit at the window size — the endpoint is not a whole-book download', () => {
		expect(MAX_WINDOW_LIMIT).toBe(WINDOW_SIZE);
	});
});

describe('clampWindow', () => {
	it('passes a fully in-range window through unchanged', () => {
		expect(clampWindow(0, 10, 100)).toEqual({ from: 0, limit: 10 });
		expect(clampWindow(37, 10, 100)).toEqual({ from: 37, limit: 10 });
	});

	it('clamps a negative from to 0 without touching the limit', () => {
		expect(clampWindow(-5, 10, 100)).toEqual({ from: 0, limit: 10 });
	});

	it('returns the remainder when the window overruns the last chunk', () => {
		// 95..104 requested of a 100-chunk book: only 95..99 exist.
		expect(clampWindow(95, 10, 100)).toEqual({ from: 95, limit: 5 });
	});

	it('returns exactly the remainder when from is the last chunk', () => {
		expect(clampWindow(99, 10, 100)).toEqual({ from: 99, limit: 1 });
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
		expect(clampWindow(Number.NaN, 10, 100)).toEqual({ from: 0, limit: 10 });
		expect(clampWindow(0, Number.NaN, 100)).toEqual({ from: 0, limit: 0 });
		expect(clampWindow(0, 10, Number.NaN)).toEqual({ from: 0, limit: 0 });
		expect(clampWindow(Number.POSITIVE_INFINITY, 10, 100)).toEqual({ from: 0, limit: 10 });
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

describe('shouldPrefetch', () => {
	const chunkCount = 100;

	it('is false in the middle of a window, far from its end', () => {
		expect(shouldPrefetch(0, 10, chunkCount)).toBe(false);
		expect(shouldPrefetch(6, 10, chunkCount)).toBe(false);
	});

	it('fires at exactly PREFETCH_THRESHOLD chunks remaining', () => {
		// loadedEnd 10, activeIndex 7 → 3 remaining (7, 8, 9).
		expect(shouldPrefetch(7, 10, chunkCount)).toBe(true);
	});

	it('stays true for every index past the threshold', () => {
		expect(shouldPrefetch(8, 10, chunkCount)).toBe(true);
		expect(shouldPrefetch(9, 10, chunkCount)).toBe(true);
	});

	it('is true when the active index has run past the loaded end (awaiting)', () => {
		expect(shouldPrefetch(10, 10, chunkCount)).toBe(true);
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
