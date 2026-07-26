import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/database.types';
import { readAll, remove, type AttemptStorage, type BufferedChunkAttempt } from './buffer';
import { backfillChunkAttempt } from './client';

/**
 * The drain (spec #15 §4): flushes buffered completed chunk attempts into `chunk_attempts`
 * once a valid session exists — after a guest signs in, after the app reopens with a
 * session, and after connectivity returns.
 *
 * **Pure over injected dependencies.** The client, the storage port and the clock all
 * arrive as parameters (`lib-patterns`); this module constructs none of them and imports
 * `@supabase/supabase-js` type-only. The dynamic-import boundary and the single-flight
 * promise live in `drain-once.ts`, and `$app/*` never enters `src/lib/` at all — which is
 * what keeps this module unit-testable against a mock and a three-line fake.
 *
 * Never throws. Nothing here may interrupt typing.
 */

export interface DrainResult {
	/** Acknowledged by the database — inserted OR duplicate-ignored. Both are success. */
	written: number;
	/** Removed as permanently unwritable: an RLS refusal, a dead `chunk_id`, a bad row. */
	discarded: number;
	/** Still in the buffer afterwards: another user's entries, plus everything a transient halt left behind. */
	remaining: number;
}

/**
 * **The attribution invariant.** An entry is eligible for a drain running as `userId` when
 * it is guest-authored (`entry.userId === null`, so it belongs to whoever signs in next on
 * this browser) or when it is that same user's own.
 *
 * This is the load-bearing security property of the whole feature, and it is enforced
 * here because it CANNOT be enforced by the database: RLS only checks
 * `user_id = auth.uid()`, and a guest-authored entry satisfies that under any signed-in
 * user by construction. Application code is the only thing standing between user B on a
 * shared browser and user A's failed writes (ADR-0012 amendment).
 */
function isEligible(entry: BufferedChunkAttempt, userId: string): boolean {
	return entry.userId === null || entry.userId === userId;
}

/**
 * Replays the buffer into `chunk_attempts` as `userId`, oldest first and sequentially.
 *
 * Oldest-first is the honest order — it replays in typing order — and it makes
 * `last_attempt_at` land on the genuinely-latest attempt. Sequential rather than parallel
 * because a transient failure must be able to halt the remainder, which a `Promise.all`
 * could not do.
 *
 * Per entry:
 * 1. **Not eligible** → skip and leave in place. Never written, never dropped, does not
 *    halt the drain; a foreign entry is simply not this session's business.
 * 2. **Success** (including a duplicate ignored by `ON CONFLICT DO NOTHING`) → remove.
 * 3. **Permanent** → remove and count as discarded. It can never succeed, and keeping it
 *    would strand every entry behind it for the next 30 days. Expect a burst of these
 *    after a re-ingestion changes `chunks.id` — a dead `chunk_id` is a foreign-key
 *    violation, which is permanent, which is correct.
 * 4. **Transient** → keep and **halt**. The failure is almost always connectivity or a
 *    token mid-refresh, so the entries behind it would fail identically; the next trigger
 *    picks the queue back up where it stopped.
 *
 * `user_id` is always stamped from the DRAINING session, never read off the entry — for a
 * guest-authored entry there is nothing else it could be, and for an owned one the
 * invariant above has already proved the two are equal.
 */
export async function drainAttemptBuffer(
	client: SupabaseClient<Database>,
	storage: AttemptStorage | null,
	userId: string,
	now: number
): Promise<DrainResult> {
	const entries = readAll(storage, now);
	let written = 0;
	let discarded = 0;
	let remaining = 0;

	for (const [position, entry] of entries.entries()) {
		if (!isEligible(entry, userId)) {
			remaining += 1;
			continue;
		}

		// `bufferedAt` is dropped by destructuring rather than deleted, so it can never
		// reach the payload; `userId` is overwritten in the same step.
		const { bufferedAt: _bufferedAt, ...attempt } = entry;
		void _bufferedAt;
		const outcome = await backfillChunkAttempt(client, { ...attempt, userId });

		if (outcome.saved) {
			remove(storage, entry, now);
			written += 1;
			continue;
		}
		if (outcome.reason === 'permanent') {
			remove(storage, entry, now);
			discarded += 1;
			continue;
		}

		// Transient: this entry and everything after it stay for the next trigger.
		remaining += entries.length - position;
		break;
	}

	return { written, discarded, remaining };
}
