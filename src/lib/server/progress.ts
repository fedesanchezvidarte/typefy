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
 * How many completed rows are requested per round trip. Must not exceed PostgREST's
 * `max_rows` (`supabase/config.toml`, 1000) — a page larger than the cap would be silently
 * truncated to it, and the short-page test below would then end pagination early.
 */
const COMPLETED_PAGE_SIZE = 1000;

/** One `chunk_progress` row with its chunk's index embedded. */
type CompletedIndexRow = { chunks: { index: number } | null };

/**
 * The **indices** of the chunks this user has completed in the given book — what
 * `buildChapterProgress` buckets into chapters.
 *
 * **Why indices rather than {@link getCompletedChunkIds}.** That function returns chunk uuids,
 * which say nothing about position; bucketing by chapter needs `chunks.index`. Mapping uuids
 * to indices would mean a second read of the whole `chunks` table — the embedded
 * `chunks(index)` gets it in one, over the same FK PostgREST already knows about.
 *
 * The completion test is `first_completed_at is not null`, never row existence, for the reason
 * {@link getCompletedChunkIds} spells out: the trigger writes a row on every attempt.
 *
 * **Why pagination is not optional.** `supabase/config.toml` sets `max_rows = 1000` and
 * don-quijote runs to roughly 2,000 pages. An unpaginated read would silently return 1,000
 * rows — no error anywhere — and every chapter past the truncation point would render as
 * untouched. This is the exact class `scripts/ingest.ts`'s `readExistingContent` already
 * defends against, and this mirrors its `.range()` loop.
 *
 * `.order('chunk_id')` is what makes `.range()` a real partition: `chunk_progress` has no
 * index column of its own to order by, and `chunk_id` is a component of its primary key, so
 * it is stable. The consequence is that **the returned indices are NOT sorted by index** —
 * `buildChapterProgress` buckets by lookup rather than by a merge walk precisely because of
 * this. Do not "tidy up" by sorting here; that would hide the contract, not honour it.
 *
 * A partial-read error throws, matching this file's doctrine: a truncated read must never be
 * reported as progress, because a wrong progress bar is worse than an error.
 *
 * **Named trigger to revisit:** if a completed set routinely exceeds ~3,000 pages, or this
 * load shows up in profiling, move the fold into a `SECURITY DEFINER` RPC.
 */
export async function getCompletedChunkIndexes(
	client: Client,
	userId: string,
	bookId: string
): Promise<number[]> {
	const indexes: number[] = [];
	let offset = 0;
	for (;;) {
		const { data, error } = await client
			.from('chunk_progress')
			.select('chunks(index)')
			.eq('user_id', userId)
			.eq('book_id', bookId)
			.not('first_completed_at', 'is', null)
			.order('chunk_id')
			.range(offset, offset + COMPLETED_PAGE_SIZE - 1);
		if (error) {
			throw error;
		}
		const page = (data ?? []) as unknown as CompletedIndexRow[];
		for (const row of page) {
			// A row whose embedded chunk is absent is skipped rather than emitted as a hole:
			// no index is knowable for it, and `0` would be attributed to chapter one.
			if (row.chunks) {
				indexes.push(row.chunks.index);
			}
		}
		if (page.length < COMPLETED_PAGE_SIZE) {
			return indexes;
		}
		offset += COMPLETED_PAGE_SIZE;
	}
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

/**
 * Reset one book's progress for one user (spec #51) — the **only write** in this module, and
 * the only destructive path in the application.
 *
 * A thin wrapper over the `reset_book_progress` RPC, and thin on purpose: every rule lives in
 * the SQL function, which deletes both rollup rows for the book and records the reset in
 * `progress_resets`, all in one transaction. `chunk_attempts` is never touched — the typing
 * history survives, and the rollups stay derivable from the attempts whose `started_at`
 * follows the reset.
 *
 * **No `userId` parameter, unlike every read above.** The RPC reads `auth.uid()` internally,
 * so the caller cannot name a user — which is what makes a destructive function safe to expose
 * to `authenticated`. Passing a user id here would create the illusion that this function
 * could reset somebody else's progress, and a reviewer would have to check that it does not.
 *
 * Errors are thrown, matching the reads: a reset that silently failed would leave the user
 * looking at a progress bar they just asked to clear.
 */
export async function resetBookProgress(client: Client, bookId: string): Promise<void> {
	const { error } = await client.rpc('reset_book_progress', { p_book_id: bookId });
	if (error) {
		throw error;
	}
}
