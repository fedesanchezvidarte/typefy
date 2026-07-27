import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/database.types';
import { readAll, type AttemptStorage, type BufferedChunkAttempt } from './buffer';
import { drainAttemptBuffer } from './drain';

/**
 * Drain tests (spec #15 §4, TDD per ADR-0009). Both dependencies are injected and both are
 * fake: a mocked Supabase client and an in-memory storage port.
 *
 * The attribution invariant is the load-bearing security property of this feature — RLS
 * cannot enforce it, because a guest-authored entry satisfies `user_id = auth.uid()` under
 * ANY signed-in user. `drain.ts` is the only thing standing there, so it is tested as a
 * rule rather than described as a comment.
 */

interface WriteOutcome {
	error?: unknown;
	status?: number;
}

function mockSupabase(results: WriteOutcome[] = []) {
	const upserts: Record<string, unknown>[] = [];
	let call = 0;
	const client = {
		from: () => ({
			upsert: (payload: Record<string, unknown>) => {
				upserts.push(payload);
				const result = results[call++] ?? { error: null };
				const error = result.error ?? null;
				return Promise.resolve({
					data: null,
					error,
					count: null,
					status: result.status ?? (error ? 400 : 201),
					statusText: ''
				});
			}
		})
	};
	return { client: client as unknown as SupabaseClient<Database>, upserts };
}

function fakeStorage(entries: BufferedChunkAttempt[]): AttemptStorage {
	let value: string | null = JSON.stringify(entries);
	return {
		read: () => value,
		write: (next: string) => {
			value = next;
		},
		clear: () => {
			value = null;
		}
	};
}

const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';
const NOW = 1_700_000_100_000;

function entry(over: Partial<BufferedChunkAttempt> = {}): BufferedChunkAttempt {
	return {
		userId: null,
		chunkId: 'chunk-default',
		bookId: '44444444-4444-4444-4444-444444444444',
		completed: true,
		grossWpm: 61.4321,
		accuracyRaw: 0.9737,
		elapsedMs: 42_124,
		startedAt: NOW - 60_000,
		bufferedAt: NOW - 10_000,
		...over
	};
}

const TRANSIENT: WriteOutcome = { status: 0, error: { message: 'TypeError: Failed to fetch' } };
const PERMANENT: WriteOutcome = { status: 403, error: { code: '42501', message: 'denied' } };
const OK: WriteOutcome = { error: null };

describe('drainAttemptBuffer — order and removal', () => {
	it('writes eligible entries oldest first by bufferedAt, sequentially', async () => {
		const storage = fakeStorage([
			entry({ chunkId: 'c3', bufferedAt: NOW - 3_000 }),
			entry({ chunkId: 'c1', bufferedAt: NOW - 9_000 }),
			entry({ chunkId: 'c2', bufferedAt: NOW - 6_000 })
		]);
		const { client, upserts } = mockSupabase();

		const result = await drainAttemptBuffer(client, storage, USER_A, NOW);

		expect(upserts.map((row) => row.chunk_id)).toEqual(['c1', 'c2', 'c3']);
		expect(result).toEqual({ written: 3, discarded: 0, remaining: 0 });
	});

	it('removes an entry only after its write is acknowledged', async () => {
		const storage = fakeStorage([entry({ chunkId: 'c1' })]);
		const { client } = mockSupabase([OK]);

		await drainAttemptBuffer(client, storage, USER_A, NOW);

		expect(readAll(storage, NOW)).toEqual([]);
	});

	it('counts a duplicate-ignored write as success and removes its entry', async () => {
		// ON CONFLICT DO NOTHING comes back as a plain success with no rows affected; the
		// row is already there, which is the whole goal.
		const storage = fakeStorage([entry({ chunkId: 'c1' })]);
		const { client } = mockSupabase([OK]);

		const result = await drainAttemptBuffer(client, storage, USER_A, NOW);

		expect(result.written).toBe(1);
		expect(readAll(storage, NOW)).toEqual([]);
	});

	it('never sends bufferedAt to the database — it exists for FIFO and TTL only', async () => {
		const storage = fakeStorage([entry({ chunkId: 'c1' })]);
		const { client, upserts } = mockSupabase();

		await drainAttemptBuffer(client, storage, USER_A, NOW);

		expect('bufferedAt' in upserts[0]).toBe(false);
		expect('buffered_at' in upserts[0]).toBe(false);
		expect(Object.keys(upserts[0]).sort()).toEqual([
			'accuracy_raw',
			'book_id',
			'chunk_id',
			'completed',
			'elapsed_ms',
			'gross_wpm',
			'started_at',
			'user_id'
		]);
	});

	it('preserves the genuine first-keystroke startedAt rather than stamping the drain moment', async () => {
		const startedAt = Date.UTC(2026, 6, 26, 12, 0, 0);
		const storage = fakeStorage([entry({ chunkId: 'c1', startedAt })]);
		const { client, upserts } = mockSupabase();

		await drainAttemptBuffer(client, storage, USER_A, NOW);

		expect(upserts[0].started_at).toBe('2026-07-26T12:00:00.000Z');
	});

	it('writes nothing and reports zeros for an empty buffer', async () => {
		const { client, upserts } = mockSupabase();

		const result = await drainAttemptBuffer(client, fakeStorage([]), USER_A, NOW);

		expect(upserts).toEqual([]);
		expect(result).toEqual({ written: 0, discarded: 0, remaining: 0 });
	});

	it('writes nothing when the storage binding is absent', async () => {
		const { client, upserts } = mockSupabase();

		const result = await drainAttemptBuffer(client, null, USER_A, NOW);

		expect(upserts).toEqual([]);
		expect(result).toEqual({ written: 0, discarded: 0, remaining: 0 });
	});

	it('never drains a TTL-expired entry', async () => {
		const storage = fakeStorage([
			entry({ chunkId: 'expired', bufferedAt: NOW - 31 * 24 * 60 * 60 * 1000 })
		]);
		const { client, upserts } = mockSupabase();

		const result = await drainAttemptBuffer(client, storage, USER_A, NOW);

		expect(upserts).toEqual([]);
		expect(result.remaining).toBe(0);
	});
});

describe('drainAttemptBuffer — the attribution invariant', () => {
	it('writes a guest-authored entry with user_id stamped from the DRAINING session', async () => {
		const storage = fakeStorage([entry({ userId: null, chunkId: 'c1' })]);
		const { client, upserts } = mockSupabase();

		await drainAttemptBuffer(client, storage, USER_A, NOW);

		expect(upserts[0].user_id).toBe(USER_A);
	});

	it('writes a signed-in-authored entry belonging to the draining user', async () => {
		const storage = fakeStorage([entry({ userId: USER_A, chunkId: 'c1' })]);
		const { client, upserts } = mockSupabase();

		const result = await drainAttemptBuffer(client, storage, USER_A, NOW);

		expect(upserts[0].user_id).toBe(USER_A);
		expect(result.written).toBe(1);
	});

	it("NEVER writes another user's entry — user B cannot inherit user A's failed writes", async () => {
		const storage = fakeStorage([entry({ userId: USER_A, chunkId: 'a-only' })]);
		const { client, upserts } = mockSupabase();

		await drainAttemptBuffer(client, storage, USER_B, NOW);

		expect(upserts).toEqual([]);
	});

	it("leaves another user's entry in place — it is skipped, not discarded", async () => {
		const foreign = entry({ userId: USER_A, chunkId: 'a-only' });
		const storage = fakeStorage([foreign]);
		const { client } = mockSupabase();

		const result = await drainAttemptBuffer(client, storage, USER_B, NOW);

		expect(readAll(storage, NOW)).toEqual([foreign]);
		expect(result).toEqual({ written: 0, discarded: 0, remaining: 1 });
	});

	it("skipping another user's entry does not halt the drain — later eligible entries still land", async () => {
		const foreign = entry({ userId: USER_A, chunkId: 'a-only', bufferedAt: NOW - 9_000 });
		const storage = fakeStorage([
			foreign,
			entry({ userId: null, chunkId: 'guest', bufferedAt: NOW - 6_000 }),
			entry({ userId: USER_B, chunkId: 'b-own', bufferedAt: NOW - 3_000 })
		]);
		const { client, upserts } = mockSupabase();

		const result = await drainAttemptBuffer(client, storage, USER_B, NOW);

		expect(upserts.map((row) => row.chunk_id)).toEqual(['guest', 'b-own']);
		expect(upserts.every((row) => row.user_id === USER_B)).toBe(true);
		expect(result).toEqual({ written: 2, discarded: 0, remaining: 1 });
		expect(readAll(storage, NOW)).toEqual([foreign]);
	});
});

describe('drainAttemptBuffer — failure handling', () => {
	it('removes a permanently refused entry — it can never succeed', async () => {
		const storage = fakeStorage([entry({ chunkId: 'c1' })]);
		const { client } = mockSupabase([PERMANENT]);

		const result = await drainAttemptBuffer(client, storage, USER_A, NOW);

		expect(result).toEqual({ written: 0, discarded: 1, remaining: 0 });
		expect(readAll(storage, NOW)).toEqual([]);
	});

	it('continues past a permanent failure — one bad row must not strand the rest', async () => {
		const storage = fakeStorage([
			entry({ chunkId: 'bad', bufferedAt: NOW - 9_000 }),
			entry({ chunkId: 'good', bufferedAt: NOW - 6_000 })
		]);
		const { client, upserts } = mockSupabase([PERMANENT, OK]);

		const result = await drainAttemptBuffer(client, storage, USER_A, NOW);

		expect(upserts.map((row) => row.chunk_id)).toEqual(['bad', 'good']);
		expect(result).toEqual({ written: 1, discarded: 1, remaining: 0 });
	});

	it('keeps a transiently failed entry AND halts the drain', async () => {
		const storage = fakeStorage([
			entry({ chunkId: 'c1', bufferedAt: NOW - 9_000 }),
			entry({ chunkId: 'c2', bufferedAt: NOW - 6_000 }),
			entry({ chunkId: 'c3', bufferedAt: NOW - 3_000 })
		]);
		const { client, upserts } = mockSupabase([OK, TRANSIENT, OK]);

		const result = await drainAttemptBuffer(client, storage, USER_A, NOW);

		// c2 failed transiently: it is not removed, and c3 is never attempted.
		expect(upserts.map((row) => row.chunk_id)).toEqual(['c1', 'c2']);
		expect(result).toEqual({ written: 1, discarded: 0, remaining: 2 });
		expect(readAll(storage, NOW).map((e) => e.chunkId)).toEqual(['c2', 'c3']);
	});

	it('counts a foreign entry it never reached toward remaining when it halts', async () => {
		const storage = fakeStorage([
			entry({ userId: null, chunkId: 'c1', bufferedAt: NOW - 9_000 }),
			entry({ userId: USER_B, chunkId: 'foreign', bufferedAt: NOW - 6_000 }),
			entry({ userId: null, chunkId: 'c3', bufferedAt: NOW - 3_000 })
		]);
		const { client } = mockSupabase([TRANSIENT]);

		const result = await drainAttemptBuffer(client, storage, USER_A, NOW);

		expect(result).toEqual({ written: 0, discarded: 0, remaining: 3 });
		expect(readAll(storage, NOW)).toHaveLength(3);
	});

	it('treats an expired JWT as transient, so the offline→online retry survives it', async () => {
		const storage = fakeStorage([entry({ chunkId: 'c1' })]);
		const { client } = mockSupabase([{ status: 401, error: { code: 'PGRST301' } }]);

		const result = await drainAttemptBuffer(client, storage, USER_A, NOW);

		expect(result).toEqual({ written: 0, discarded: 0, remaining: 1 });
		expect(readAll(storage, NOW)).toHaveLength(1);
	});

	it('never throws, even when the client itself rejects', async () => {
		const storage = fakeStorage([entry({ chunkId: 'c1' })]);
		const client = {
			from: () => ({ upsert: () => Promise.reject(new Error('offline')) })
		} as unknown as SupabaseClient<Database>;

		const result = await drainAttemptBuffer(client, storage, USER_A, NOW);

		expect(result).toEqual({ written: 0, discarded: 0, remaining: 1 });
	});
});
