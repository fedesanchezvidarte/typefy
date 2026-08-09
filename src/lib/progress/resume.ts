/**
 * Resume resolution (spec #12 §3, spec #18 §2, ADR-0010): where a book opens.
 *
 * Pure by construction — no IO, no Supabase, no clock (`lib-patterns` two-tier rule). Since
 * `firstIncompleteIndex` moved into the `first_incomplete_chunk_index` SQL function, this
 * module takes only numbers: it has no dependency on `$lib/types` at all, which is the
 * point — windowed reads never produce the whole chunk array the old scan required.
 *
 * The caller does the reading: the RPC produces `computedStartIndex` and
 * `getBookSummaryBySlug` produces `chunkCount` (`books.chunk_count` — the text's real
 * length, never how much of it is loaded).
 */

/** A page param is valid only as a base-10 integer literal: digits, nothing else. */
const INTEGER_LITERAL = /^\d+$/;

/** Floors a value into a non-negative integer; non-finite input becomes 0. */
function toCount(value: number): number {
	return Number.isFinite(value) ? Math.max(Math.floor(value), 0) : 0;
}

/**
 * The index a session starts at. `pageParam` is the raw override value, 1-BASED, matching
 * the meta line's `current={session.activeIndex + 1}`. A valid integer in `1..chunkCount`
 * wins; ANYTHING else — null, empty, non-numeric, zero, negative, fractional, out of range
 * — silently falls back to `computedStartIndex`. Never throws, never signals an error: a
 * stale hand-edited link must still open the book.
 *
 * Spec #32: `?page=N` is the canonical query param; `?passage=N` is still accepted for
 * back-compat. Resolving which of the two raw strings wins is the CALLER's job
 * (`url.searchParams.get('page') ?? url.searchParams.get('passage')`, in
 * `+page.server.ts`) — this function only ever sees one already-chosen string, so its own
 * logic is byte-identical to before the rename; only the parameter's name changed to say
 * what it actually is now.
 *
 * Valid means a base-10 **integer literal** and nothing else: `'2.0'`, `'1e2'`, `'0x2'`,
 * `'+2'` and `' 3 '` are all rejected. Bare `Number()` would accept most of those, so the
 * check is an explicit `/^\d+$/` on the raw string before parsing.
 *
 * A valid override wins even when it points at an already-completed page, and even when it
 * happens to equal the computed index.
 *
 * `computedStartIndex` is clamped into `0..max(chunkCount - 1, 0)` rather than trusted. It
 * crosses an RPC boundary now, and a `chunk_count` that shrank under a re-ingest between
 * the two reads would otherwise open a session on a chunk that no longer exists — so it is
 * defended like any other input.
 */
export function resolveStartIndex(
	pageParam: string | null,
	chunkCount: number,
	computedStartIndex: number
): number {
	const count = toCount(chunkCount);
	const lastIndex = Math.max(count - 1, 0);

	if (pageParam !== null && INTEGER_LITERAL.test(pageParam)) {
		const page = Number.parseInt(pageParam, 10);
		if (page >= 1 && page <= count) {
			return page - 1;
		}
	}
	return Math.min(toCount(computedStartIndex), lastIndex);
}
