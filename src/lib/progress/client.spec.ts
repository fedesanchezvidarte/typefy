import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/database.types';
import { recordChunkAttempt, type ChunkAttemptInput } from './client';

/**
 * Browser write-service tests (spec #12, Phase C). The injected Supabase client is
 * mocked — a unit test never touches a real database (testing-patterns).
 */
function mockSupabase(outcome: { error: unknown } | { reject: unknown }) {
	const inserts: unknown[] = [];
	const tables: unknown[] = [];
	const client = {
		from: (table: string) => {
			tables.push(table);
			return {
				insert: (payload: unknown) => {
					inserts.push(payload);
					return 'reject' in outcome
						? Promise.reject(outcome.reject)
						: Promise.resolve({ data: null, error: outcome.error });
				}
			};
		}
	};
	return { client: client as unknown as SupabaseClient<Database>, inserts, tables };
}

const attempt: ChunkAttemptInput = {
	userId: '11111111-1111-1111-1111-111111111111',
	chunkId: '33333333-3333-3333-3333-333333333333',
	bookId: '22222222-2222-2222-2222-222222222222',
	completed: true,
	grossWpm: 61.4321,
	accuracyRaw: 0.9737,
	elapsedMs: 42_123.7,
	startedAt: Date.UTC(2026, 6, 26, 12, 0, 0)
};

describe('recordChunkAttempt', () => {
	it('appends one row to chunk_attempts', async () => {
		const { client, tables, inserts } = mockSupabase({ error: null });

		const result = await recordChunkAttempt(client, attempt);

		expect(result).toEqual({ saved: true });
		expect(tables).toEqual(['chunk_attempts']);
		expect(inserts).toHaveLength(1);
	});

	it('sends exactly the eight columns the 2b column-level INSERT grant covers', async () => {
		const { client, inserts } = mockSupabase({ error: null });

		await recordChunkAttempt(client, attempt);

		expect(Object.keys(inserts[0] as object).sort()).toEqual([
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

	it('never sends created_at or id — the grant omits them and Postgres would refuse with 42501', async () => {
		const { client, inserts } = mockSupabase({ error: null });

		await recordChunkAttempt(client, attempt);

		const payload = inserts[0] as Record<string, unknown>;
		expect('created_at' in payload).toBe(false);
		expect('id' in payload).toBe(false);
	});

	it('maps the input onto the row columns', async () => {
		const { client, inserts } = mockSupabase({ error: null });

		await recordChunkAttempt(client, attempt);

		expect(inserts[0]).toMatchObject({
			user_id: attempt.userId,
			chunk_id: attempt.chunkId,
			book_id: attempt.bookId,
			completed: true
		});
	});

	it('converts startedAt (ms epoch) to an ISO timestamptz string', async () => {
		const { client, inserts } = mockSupabase({ error: null });

		await recordChunkAttempt(client, attempt);

		expect((inserts[0] as Record<string, unknown>).started_at).toBe('2026-07-26T12:00:00.000Z');
	});

	it('rounds elapsedMs to an integer (the column is integer) and passes the numerics through unrounded', async () => {
		const { client, inserts } = mockSupabase({ error: null });

		await recordChunkAttempt(client, attempt);

		const payload = inserts[0] as Record<string, unknown>;
		expect(payload.elapsed_ms).toBe(42_124);
		expect(payload.gross_wpm).toBe(61.4321);
		expect(payload.accuracy_raw).toBe(0.9737);
	});

	it('reports a PostgREST error as a save failure rather than throwing', async () => {
		const { client } = mockSupabase({ error: { code: '42501', message: 'permission denied' } });

		await expect(recordChunkAttempt(client, attempt)).resolves.toEqual({
			saved: false,
			reason: 'error'
		});
	});

	it('reports a rejected request (network failure) as a save failure rather than throwing', async () => {
		const { client } = mockSupabase({ reject: new Error('Failed to fetch') });

		await expect(recordChunkAttempt(client, attempt)).resolves.toEqual({
			saved: false,
			reason: 'error'
		});
	});

	it('issues exactly one insert on failure — no retry, no backoff, no queue', async () => {
		const failed = mockSupabase({ error: { message: 'nope' } });
		await recordChunkAttempt(failed.client, attempt);
		expect(failed.inserts).toHaveLength(1);

		const rejected = mockSupabase({ reject: new Error('offline') });
		await recordChunkAttempt(rejected.client, attempt);
		expect(rejected.inserts).toHaveLength(1);
	});
});
