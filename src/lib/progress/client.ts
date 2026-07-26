import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/database.types';

/**
 * Browser write service (spec #12, ADR-0012): appends one immutable `chunk_attempts` row
 * per completed passage, under the existing RLS insert policy.
 *
 * Per `lib-patterns` the client is injected as the first parameter — this module never
 * constructs one (`$lib/supabase/browser` is the single sanctioned constructor), which is
 * what makes it unit-testable with a mock.
 */

/** One completed traversal, as the browser asserts it. Metrics are client-asserted (ADR-0012). */
export interface ChunkAttemptInput {
	userId: string;
	chunkId: string;
	bookId: string;
	completed: boolean;
	grossWpm: number;
	accuracyRaw: number;
	elapsedMs: number;
	/** The attempt's FIRST KEYSTROKE, ms epoch. Informational only — no rollup rule reads it. */
	startedAt: number;
}

/**
 * Appends exactly ONE `chunk_attempts` row. One attempt, no retry, no backoff, no queue
 * (spec §1). Never throws: a save failure is data the caller counts for the session summary,
 * not an exception that could interrupt typing (spec §6).
 *
 * **The payload is exactly eight columns and must stay that way.** The 2b migration dropped
 * the table-level `INSERT` grant on `chunk_attempts` and re-granted per column, omitting
 * `created_at` and `id` so both fall to their defaults — that is what makes "every rollup
 * timestamp comes from the server clock" enforceable rather than merely intended. Adding
 * either key here gets the whole insert refused with Postgres `42501`.
 *
 * Boundary conversions: `started_at` is `timestamptz`, so the ms epoch becomes an ISO string;
 * `elapsed_ms` is `integer`, so it is rounded; `gross_wpm` / `accuracy_raw` are `numeric` and
 * pass through unrounded.
 */
export async function recordChunkAttempt(
	client: SupabaseClient<Database>,
	attempt: ChunkAttemptInput
): Promise<{ saved: true } | { saved: false; reason: 'error' }> {
	try {
		const { error } = await client.from('chunk_attempts').insert({
			user_id: attempt.userId,
			chunk_id: attempt.chunkId,
			book_id: attempt.bookId,
			completed: attempt.completed,
			gross_wpm: attempt.grossWpm,
			accuracy_raw: attempt.accuracyRaw,
			elapsed_ms: Math.round(attempt.elapsedMs),
			started_at: new Date(attempt.startedAt).toISOString()
		});
		return error ? { saved: false, reason: 'error' } : { saved: true };
	} catch {
		// A rejected request — offline, DNS failure, an aborted fetch — is the same
		// outcome as a refused insert: one attempt was made and it did not save.
		return { saved: false, reason: 'error' };
	}
}
