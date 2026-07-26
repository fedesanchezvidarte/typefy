import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/database.types';

/**
 * Browser write service (spec #12, ADR-0012): appends one immutable `chunk_attempts` row
 * per completed passage, under the existing RLS insert policy.
 *
 * Per `lib-patterns` the client is injected as the first parameter — this module never
 * constructs one (`$lib/supabase/browser` is the single sanctioned constructor), which is
 * what makes it unit-testable with a mock.
 *
 * Spec #15 widens it in two ways: the failure result now distinguishes **transient** from
 * **permanent**, because a drain cannot decide whether to keep or discard a buffered entry
 * without that distinction; and `backfillChunkAttempt` adds the drain's write path.
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
 * The outcome of one write.
 *
 * The split is the drain's decision procedure, not a diagnostic nicety: **transient** means
 * a later attempt can succeed, so the entry is buffered and kept; **permanent** means it
 * never can, so the entry is never buffered and an already-buffered one is discarded.
 */
export type ChunkAttemptOutcome =
	| { saved: true }
	// Retry can succeed → buffer it, and keep it buffered until it does.
	| { saved: false; reason: 'transient' }
	// Retry cannot succeed → never buffer it, and discard it if it already is.
	| { saved: false; reason: 'permanent' };

/**
 * PostgREST's codes for an expired or absent JWT.
 *
 * **These are deliberately TRANSIENT, which is the one place the taxonomy departs from
 * "4xx is permanent"** (spec §11). An expired token is the exact condition this feature
 * exists to survive, and `@supabase/ssr`'s refresh timer fails while offline — so the
 * first drain after reconnect can legitimately beat the refresh. Classifying it permanent
 * would discard the entry on precisely the case it was buffered for.
 */
const JWT_ERROR_CODES = new Set(['PGRST301', 'PGRST303']);

/**
 * Statuses a later attempt can survive. `0` is postgrest-js's sentinel for a fetch-level
 * failure (offline, DNS, `AbortError`) — the library catches those internally and returns
 * them as a response, so they never reach us as a rejection. `408`/`429` are timeout and
 * rate limit; `401` is the JWT case above.
 */
const TRANSIENT_STATUSES = new Set([0, 401, 408, 429]);

/**
 * The concrete discriminator: PostgREST's **HTTP status**, which is present on the failure
 * shape too (`{ error, data, count, status, statusText }`), with the JWT error *code* as a
 * second, independent check.
 *
 * Status is used rather than pattern-matching `error.message`, because messages are
 * human-facing prose that changes between PostgREST releases and locales — an RLS refusal
 * reads "new row violates row-level security policy", a grant refusal reads "permission
 * denied for table chunk_attempts", and both are simply 403. The code check is kept
 * alongside it so a JWT failure is still classified correctly if the status is absent or
 * unexpected (a proxy, a future library version, a hand-rolled fetch).
 *
 * Unknown or missing statuses fall to **transient**, because the two errors are not
 * symmetric: misclassifying a permanent failure as transient costs one halted drain that
 * the next trigger retries, while misclassifying a transient one as permanent silently
 * destroys a completed attempt.
 *
 * Exported for its own unit test; not called outside this module.
 */
export function classifyWriteOutcome(status: number, error: unknown): ChunkAttemptOutcome {
	if (error === null || error === undefined) return { saved: true };

	const code = (error as { code?: unknown }).code;
	if (typeof code === 'string' && JWT_ERROR_CODES.has(code)) {
		return { saved: false, reason: 'transient' };
	}

	if (!Number.isFinite(status)) return { saved: false, reason: 'transient' };
	if (TRANSIENT_STATUSES.has(status) || status >= 500) {
		return { saved: false, reason: 'transient' };
	}

	// Everything else — 403 RLS or grant refusal, 400, 404, 409 unique or foreign-key
	// violation, 422 — cannot be fixed by trying again with the same row.
	return { saved: false, reason: 'permanent' };
}

/**
 * The row payload, in one place so the live write and the backfill can never drift apart.
 *
 * **It is exactly eight columns and must stay that way.** The 2b migration dropped the
 * table-level `INSERT` grant on `chunk_attempts` and re-granted per column, omitting
 * `created_at` and `id` so both fall to their defaults — that is what makes "every rollup
 * timestamp comes from the server clock" enforceable rather than merely intended. Adding
 * either key here gets the whole write refused with Postgres `42501`.
 *
 * Boundary conversions: `started_at` is `timestamptz`, so the ms epoch becomes an ISO
 * string; `elapsed_ms` is `integer`, so it is rounded; `gross_wpm` / `accuracy_raw` are
 * `numeric` and pass through unrounded.
 */
function toRow(attempt: ChunkAttemptInput) {
	return {
		user_id: attempt.userId,
		chunk_id: attempt.chunkId,
		book_id: attempt.bookId,
		completed: attempt.completed,
		gross_wpm: attempt.grossWpm,
		accuracy_raw: attempt.accuracyRaw,
		elapsed_ms: Math.round(attempt.elapsedMs),
		started_at: new Date(attempt.startedAt).toISOString()
	};
}

/**
 * Appends exactly ONE `chunk_attempts` row. One attempt, no retry, no backoff (spec #12
 * §1) — the attempt buffer is now the only retry mechanism in the system, and postgrest-js
 * does not add one either (its `RETRYABLE_METHODS` is `GET`/`HEAD`/`OPTIONS`; this is a
 * POST). Never throws: a save failure is data the caller counts for the session summary,
 * not an exception that could interrupt typing (spec #12 §6).
 */
export async function recordChunkAttempt(
	client: SupabaseClient<Database>,
	attempt: ChunkAttemptInput
): Promise<ChunkAttemptOutcome> {
	try {
		const { error, status } = await client.from('chunk_attempts').insert(toRow(attempt));
		return classifyWriteOutcome(status, error);
	} catch (thrown) {
		// postgrest-js turns fetch rejections into `status: 0` responses, so this is now a
		// narrow path: a `getBrowserSupabase()` throw, or a custom fetch that rejects.
		// Transient by the same asymmetry argument as an unknown status.
		void thrown;
		return { saved: false, reason: 'transient' };
	}
}

/**
 * The drain's write: the same eight columns and the same mapper as the live write, sent as
 * an upsert so a repeated drain is a no-op at the database rather than by care.
 *
 * **`ignoreDuplicates: true` is mandatory, not stylistic.** It makes PostgREST emit
 * `INSERT … ON CONFLICT DO NOTHING`, which Postgres serves with the `INSERT` privilege
 * alone. A true upsert (`DO UPDATE`) would need `UPDATE` — which `chunk_attempts`
 * deliberately has neither a grant nor an RLS policy for (ADR-0010's structural
 * append-only guarantee), so it would be refused at runtime with `42501`.
 *
 * A conflict therefore counts as **success**: under `return=minimal` (no `.select()` is
 * chained, so none is requested) the client cannot distinguish "inserted" from "ignored",
 * and it does not need to — either way the row is there, and the entry can be removed.
 *
 * `user_id` must be stamped by the CALLER from the draining session, never taken from the
 * buffered entry — see the attribution invariant in `drain.ts`.
 */
export async function backfillChunkAttempt(
	client: SupabaseClient<Database>,
	attempt: ChunkAttemptInput
): Promise<ChunkAttemptOutcome> {
	try {
		const { error, status } = await client.from('chunk_attempts').upsert(toRow(attempt), {
			onConflict: 'user_id,chunk_id,started_at',
			ignoreDuplicates: true
		});
		return classifyWriteOutcome(status, error);
	} catch (thrown) {
		void thrown;
		return { saved: false, reason: 'transient' };
	}
}
