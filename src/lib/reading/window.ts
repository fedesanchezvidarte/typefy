/**
 * What a window IS (spec #18, ADR-0006 amendment): the two constants and the pure clamp
 * that turns a requested range into a range the text actually holds.
 *
 * Pure by construction — no Supabase, no clock, no DOM (`lib-patterns` two-tier rule).
 *
 * The constants live here rather than in a bare `constants.ts` because they exist only to
 * parameterise this clamp. A two-line constants module that four callers import while the
 * logic it governs sits elsewhere invites exactly the drift that hurts: a literal `10` in
 * the endpoint's clamp and a literal `10` in the component's next-window request that differ
 * by one produces a window the endpoint silently truncates and a prefetch that never covers
 * the gap — visible only on a long book over a slow connection. One module, one number,
 * one clamp.
 *
 * Deliberately NOT imported by `src/lib/server/books.ts`: the service takes bounds as
 * arguments and is a mechanism; the policy lives here. That is what keeps `getChunkWindow`
 * unit-testable against arbitrary ranges.
 */

/** Chunks delivered per window. ~500 chars each, so ~5 KB of text per request. */
export const WINDOW_SIZE = 10;

/**
 * Prefetch the next window once the active chunk is this close to the loaded end. Three
 * passages is roughly a minute of typing — enough cover for a slow request, short enough
 * that a session does not hold windows it will never reach.
 */
export const PREFETCH_THRESHOLD = 3;

/**
 * The largest `limit` the chunks endpoint will serve. Equal to `WINDOW_SIZE` on purpose:
 * this is what stops the public endpoint being turned into a whole-book download, which
 * would reintroduce the PostgREST row-limit truncation this feature exists to remove.
 */
export const MAX_WINDOW_LIMIT = WINDOW_SIZE;

/** A clamped, absolute range of chunk indices: `[from, from + limit)`. */
export interface WindowBounds {
	from: number;
	limit: number;
}

/** Floors a value into a non-negative integer; non-finite input becomes 0. */
function toCount(value: number): number {
	return Number.isFinite(value) ? Math.max(Math.floor(value), 0) : 0;
}

/**
 * Clamps a requested range into the text. Never throws — every out-of-range input has a
 * defined answer, because the callers are an HTTP endpoint and a page load, and neither
 * has anything better to do with an exception than serve a 500.
 *
 * `from` is clamped to non-negative but is NOT pulled back inside the book: a request past
 * the end is echoed honestly with `limit: 0`, so the response says "the book exists, that
 * range of it does not" rather than silently serving a different range than was asked for.
 *
 * Both clamps on `limit` apply and the smaller wins: `MAX_WINDOW_LIMIT` first, then the
 * remainder to the end of the text.
 */
export function clampWindow(from: number, limit: number, chunkCount: number): WindowBounds {
	const start = toCount(from);
	const count = toCount(chunkCount);
	const remaining = Math.max(count - start, 0);
	return {
		from: start,
		limit: Math.min(toCount(limit), MAX_WINDOW_LIMIT, remaining)
	};
}

/** Absolute index one past the last loaded chunk — the exclusive end of a window. */
export function windowEnd(from: number, count: number): number {
	return from + count;
}

/**
 * True when the active chunk is within `PREFETCH_THRESHOLD` of the loaded end AND the text
 * holds more than is loaded. The second condition is what keeps a book shorter than one
 * window — and the last window of any book — from asking for a window that does not exist.
 *
 * `activeIndex >= loadedEnd` (the awaiting case) satisfies the first condition, so the same
 * predicate covers both "prefetch ahead" and "fetch what we are already blocked on".
 */
export function shouldPrefetch(
	activeIndex: number,
	loadedEnd: number,
	chunkCount: number
): boolean {
	return loadedEnd < chunkCount && loadedEnd - activeIndex <= PREFETCH_THRESHOLD;
}
