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

/**
 * Chunks delivered per window (spec #32 §3.5, retuned for the page model).
 *
 * A page is ~2.4x the pre-5b passage: the restructured chunker was run read-only over the
 * actual 12 catalog source texts (measured, not the spec's ~1250-character estimate) and
 * produced a mean of **1211 characters/page** (median 1260, min 100, max 2746, n=4130 pages
 * across the catalog). The pre-5b pair (10 chunks / ~500 chars) delivered ~5.0 KB of text per
 * window; keeping the SAME window size under the new page length would have delivered ~3x
 * that. `WINDOW_SIZE = 4` keeps the wire cost in the same band:
 *
 * - text: `4 x 1211 = 4844` chars ≈ 4.7 KB (pre-5b: `10 x ~500 = 5000` chars ≈ 4.9 KB).
 * - envelope: ~120 B/chunk JSON overhead x 4 = 480 B (pre-5b: x10 = 1200 B) — FEWER, larger
 *   chunks means less per-window overhead, so the wire total actually drops slightly:
 *   ~5.2 KB total vs pre-5b's ~6.2 KB.
 */
export const WINDOW_SIZE = 4;

/**
 * Prefetch the next window once the active chunk is this close to the loaded end.
 *
 * One page of runway is `1211` characters — at 40 WPM (≈200 chars/min) that is ≈6.1 minutes
 * of cover before the reader could possibly outrun a fetch; at 80 WPM, ≈3.0 minutes. Both are
 * far more than a request needs, and both are close to the pre-5b figures (≈7.5 / ≈3.8 min at
 * 3 x ~500 chars), so the runway band is preserved even though the runway is now one page
 * rather than three.
 *
 * **The refire check** (easy to miss, so verified by test): `shouldPrefetch` fires when
 * `loadedEnd - activeIndex <= PREFETCH_THRESHOLD`. A window that just landed puts that gap at
 * exactly `WINDOW_SIZE` (the reader is at the window's first chunk); it must stay strictly
 * greater than `PREFETCH_THRESHOLD` or the very next render re-fires the SAME prefetch before
 * the reader has moved — the session would then hold two windows for no reason. At `4 / 1` the
 * gap is `4 > 1`, preserving the pre-5b ratio's intent (`10 / 3` was `10 > 3`).
 */
export const PREFETCH_THRESHOLD = 1;

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

/**
 * The window bounds for a deliberate jump (spec #32 §10 D1, "the A' engine seek"): a page
 * navigator moving to page 12, or straight to page 400.
 *
 * Unlike a prefetch — which always starts at `loadedEnd`, the boundary of what is already
 * loaded — a seek has no such boundary to extend: it anchors a FRESH window at the target
 * index itself, so the reader lands exactly where they asked to and can keep reading forward
 * from there. That is the only difference from an ordinary window request; the bounds
 * arithmetic is `clampWindow` unchanged; this function exists so the anchor policy — "at the
 * target," not "at the loaded end" — has one name and one definition rather than being
 * re-derived at every call site.
 *
 * **The other half of "replace, not merge" lives in `session.ts`.** This function only says
 * WHICH chunks to fetch; it says nothing about what happens to the chunks already held. A
 * caller that fed this window into `applyWindowLoaded` in the ordinary way would still MERGE
 * it onto the existing map — session.ts is where the seek's `window-loaded` response is
 * recognised as a replacement instead, via `seekPending`.
 */
export function seekWindow(index: number, chunkCount: number): WindowBounds {
	return clampWindow(index, WINDOW_SIZE, chunkCount);
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
