import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/database.types';
import type { BookActivity } from '$lib/types';

/**
 * Progress read service (spec #12, ADR-0010): plain single-table reads against the two
 * rollup tables the `chunk_attempts` trigger maintains. Never reads the attempt history —
 * that is the whole point of the rollups.
 *
 * Per `lib-patterns` the `SupabaseClient` is injected as the first parameter, and `userId`
 * is passed explicitly rather than read inside the service, so each function stays a pure
 * function of its inputs and is unit-testable with a mock. RLS scopes the rows regardless;
 * the explicit filter is what makes the query indexed, not what makes it safe.
 *
 * Errors are thrown, matching `books.ts` — there is deliberately no silent fallback to
 * "no progress", which would render a wrong progress bar instead of an error.
 */

type Client = SupabaseClient<Database>;

/**
 * Chunk ids this user has completed at least once in the given book — the set the resume
 * resolver consumes.
 *
 * The completion test is `first_completed_at is not null`, **never the mere existence of a
 * `chunk_progress` row**: the trigger creates a row on every attempt, completed or not, so
 * an abandoned passage leaves a row with `attempt_count > 0` and `first_completed_at` null.
 * Treating row existence as completion would resume the user past passages they never
 * finished.
 */
export async function getCompletedChunkIds(
	client: Client,
	userId: string,
	bookId: string
): Promise<ReadonlySet<string>> {
	const { data, error } = await client
		.from('chunk_progress')
		.select('chunk_id')
		.eq('user_id', userId)
		.eq('book_id', bookId)
		.not('first_completed_at', 'is', null);
	if (error) {
		throw error;
	}
	return new Set(data.map((row) => row.chunk_id));
}

/**
 * Book-lifetime activity for every book this user has touched, keyed by `books.id`
 * (`TypeableTextSummary.bookId`, **never** the slug). Books absent from the map have no
 * `book_progress` row at all — the caller renders 0 rather than treating absence as an error.
 *
 * A book the user has only attempted without completing anything is present with
 * `chunksCompleted: 0`, since the trigger writes that on the first incomplete attempt. Both
 * cases collapse to the same rendered 0, which is why the map needs no third state.
 *
 * `last_active_at` rides along (spec #19 §5) so the library can order its continue-reading
 * section: it is **the same single query**, one column wider, not a second round trip. The
 * ordering and the completed-book exclusion deliberately do NOT happen here — the exclusion
 * needs `books.chunk_count`, which PostgREST cannot compare against across tables, and
 * ordering before the exclusion would silently return fewer books than asked for. That
 * selection is `selectContinueReading`, over data the load already holds.
 */
export async function getBookActivity(
	client: Client,
	userId: string
): Promise<ReadonlyMap<string, BookActivity>> {
	const { data, error } = await client
		.from('book_progress')
		.select('book_id, chunks_completed, last_active_at')
		.eq('user_id', userId);
	if (error) {
		throw error;
	}
	return new Map(
		data.map((row) => [
			row.book_id,
			{ chunksCompleted: row.chunks_completed, lastActiveAt: row.last_active_at }
		])
	);
}

/**
 * One book's completion count, for the typing screen's meta line. An absent row means the
 * user has never attempted this book, which is 0 — not an error and not a missing value.
 */
export async function getBookCompletionCount(
	client: Client,
	userId: string,
	bookId: string
): Promise<number> {
	const { data, error } = await client
		.from('book_progress')
		.select('chunks_completed')
		.eq('user_id', userId)
		.eq('book_id', bookId)
		.maybeSingle();
	if (error) {
		throw error;
	}
	return data?.chunks_completed ?? 0;
}
