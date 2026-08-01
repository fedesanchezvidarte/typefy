import type { BookActivity, TypeableTextSummary } from '$lib/types';

/**
 * The continue-reading selection (spec #19 §5).
 *
 * **Why this is a pure function and not a query.** PostgREST cannot express
 * `chunks_completed < books.chunk_count` — a comparison between columns of two different
 * tables — and ordering and limiting in SQL *before* that exclusion would silently return
 * fewer than three whenever a recently finished book sat at the top. The load already holds
 * `chunk_count` for every book (from `listBooks`) and the rollup row for every book the user
 * has touched (from `getBookActivity`), so the correct shape is one query already being made
 * plus a selection over data already in hand. Extra round trips: zero.
 */

/** Three cards: one row above the grid, not a second grid. */
export const CONTINUE_READING_LIMIT = 3;

/**
 * The most recently active in-progress books, most recent first.
 *
 * `books` arrives **already language-filtered**, which is what makes "the section respects the
 * filter" structural — there is no second filter to keep in sync and the page cannot
 * contradict itself. A guest reaches this with an empty map (no progress query is issued at
 * all) and gets `[]`.
 *
 * Returns **references into `books`**, never copies: the same book legitimately renders twice
 * on the page, and devalue deduplicates referentially-identical objects, so the duplicate
 * costs payload bytes only once.
 */
export function selectContinueReading(
	books: readonly TypeableTextSummary[],
	activity: ReadonlyMap<string, BookActivity>,
	limit: number = CONTINUE_READING_LIMIT
): TypeableTextSummary[] {
	return books
		.filter((book) => {
			const progress = activity.get(book.bookId);
			if (!progress) {
				return false;
			}
			// `> 0` excludes a book merely opened (the trigger writes a row on the first
			// incomplete attempt); `<` excludes a completed one — and, by accident that is worth
			// a test, one whose count exceeds its length after an `--allow-shrink` re-ingest.
			return progress.chunksCompleted > 0 && progress.chunksCompleted < book.chunkCount;
		})
		.sort((a, b) => {
			// Nulls last: a rollup row the trigger never timestamped has no claim to the top.
			const left = activity.get(a.bookId)?.lastActiveAt ?? '';
			const right = activity.get(b.bookId)?.lastActiveAt ?? '';
			if (left !== right) {
				return right.localeCompare(left);
			}
			// Slug ascending, so two passages persisted in the same instant always render in the
			// same order rather than in whatever order the rows arrived.
			return a.id.localeCompare(b.id);
		})
		.slice(0, limit);
}
