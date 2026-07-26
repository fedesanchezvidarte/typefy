import type { Chunk } from '$lib/types';

/**
 * Resume resolution (spec #12 §3, ADR-0010): where a book opens.
 *
 * Pure by construction — no IO, no Supabase, no clock (`lib-patterns` two-tier rule).
 * The caller does the reading: `getCompletedChunkIds` produces the completed-id set and
 * `getBookBySlug` produces the chunks, already ordered by `index`.
 */

/** A passage param is valid only as a base-10 integer literal: digits, nothing else. */
const INTEGER_LITERAL = /^\d+$/;

/**
 * Lowest index whose chunk this user has not yet completed. Gaps count: with 0 and 2
 * complete and 1 not, this returns 1. A fully completed book returns 0 — there is no
 * "you have finished" state in this spec.
 *
 * Chunks are matched by `chunk.id` (the `chunks` table uuid) against the set, never by
 * counting how many entries the set holds — completions from other books, or in a
 * different order, must not shift the answer.
 *
 * The returned number is the **array position**, and the caller is expected to supply
 * chunks ordered by `index` (which `getBookBySlug` guarantees). Returning the position
 * rather than the `index` field keeps the result valid against the array that was
 * actually passed, even if the two ever diverge.
 *
 * An empty `chunks` array returns 0 defensively — never -1, never NaN.
 */
export function firstIncompleteIndex(
	chunks: readonly Chunk[],
	completedChunkIds: ReadonlySet<string>
): number {
	const position = chunks.findIndex((chunk) => !completedChunkIds.has(chunk.id));
	return position === -1 ? 0 : position;
}

/**
 * The index a session starts at. `passageParam` is the raw `?passage` value, 1-BASED,
 * matching the meta line's `current={session.activeIndex + 1}`. A valid integer in
 * 1..chunks.length wins; ANYTHING else — null, empty, non-numeric, zero, negative,
 * fractional, out of range — silently falls back to firstIncompleteIndex. Never throws,
 * never signals an error: a stale hand-edited link must still open the book.
 *
 * Valid means a base-10 **integer literal** and nothing else: `'2.0'`, `'1e2'`, `'0x2'`,
 * `'+2'` and `' 3 '` are all rejected. Bare `Number()` would accept most of those, so the
 * check is an explicit `/^\d+$/` on the raw string before parsing.
 *
 * A valid override wins even when it points at an already-completed passage, and even
 * when it happens to equal the computed index.
 */
export function resolveStartIndex(
	chunks: readonly Chunk[],
	completedChunkIds: ReadonlySet<string>,
	passageParam: string | null
): number {
	if (passageParam !== null && INTEGER_LITERAL.test(passageParam)) {
		const passage = Number.parseInt(passageParam, 10);
		if (passage >= 1 && passage <= chunks.length) {
			return passage - 1;
		}
	}
	return firstIncompleteIndex(chunks, completedChunkIds);
}
