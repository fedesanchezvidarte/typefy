import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/database.types';
import {
	backfillChunkAttempt,
	BEST_MEASURED_CHARS_FLOOR,
	classifyWriteOutcome,
	recordChunkAttempt,
	type ChunkAttemptInput
} from './client';

/**
 * Browser write-service tests (spec #12 Phase C; widened by spec #15 Phase 3). The injected
 * Supabase client is mocked — a unit test never touches a real database (testing-patterns).
 */

interface WriteCall {
	table: string;
	method: 'insert' | 'upsert';
	payload: unknown;
	options: unknown;
}

/**
 * A mock whose resolved shape matches postgrest-js's real one: `status` sits alongside
 * `error` on the failure shape too, which is what makes it usable as the discriminator.
 */
function mockSupabase(outcome: { error?: unknown; status?: number } | { reject: unknown }) {
	const calls: WriteCall[] = [];
	function respond(table: string, method: WriteCall['method'], payload: unknown, options: unknown) {
		calls.push({ table, method, payload, options });
		if ('reject' in outcome) return Promise.reject(outcome.reject);
		const error = outcome.error ?? null;
		return Promise.resolve({
			data: null,
			error,
			count: null,
			status: outcome.status ?? (error ? 400 : 201),
			statusText: ''
		});
	}
	const client = {
		from: (table: string) => ({
			insert: (payload: unknown) => respond(table, 'insert', payload, undefined),
			upsert: (payload: unknown, options: unknown) => respond(table, 'upsert', payload, options)
		})
	};
	return { client: client as unknown as SupabaseClient<Database>, calls };
}

/** A wholly-Normal traversal: metrics present, and the measured span IS the wall clock. */
const attempt: ChunkAttemptInput = {
	userId: '11111111-1111-1111-1111-111111111111',
	chunkId: '33333333-3333-3333-3333-333333333333',
	bookId: '22222222-2222-2222-2222-222222222222',
	completed: true,
	grossWpm: 61.4321,
	accuracyRaw: 0.9737,
	elapsedMs: 42_123.7,
	startedAt: Date.UTC(2026, 6, 26, 12, 0, 0),
	mode: 'normal',
	measuredMs: 42_123.7,
	measuredChars: 431
};

/** A wholly-Zen traversal: nothing was measured, so nothing is asserted (spec #24 §4). */
const zenAttempt: ChunkAttemptInput = {
	...attempt,
	grossWpm: null,
	accuracyRaw: null,
	mode: 'zen',
	measuredMs: 0,
	measuredChars: 0
};

/** A mid-way switch: mode is `zen` and the metrics are NULL, but the span is real. */
const mixedAttempt: ChunkAttemptInput = {
	...attempt,
	grossWpm: null,
	accuracyRaw: null,
	mode: 'zen',
	measuredMs: 18_400.4,
	measuredChars: 212
};

const THE_ELEVEN_COLUMNS = [
	'accuracy_raw',
	'book_id',
	'chunk_id',
	'completed',
	'elapsed_ms',
	'gross_wpm',
	'measured_chars',
	'measured_ms',
	'mode',
	'started_at',
	'user_id'
];

describe('recordChunkAttempt', () => {
	it('appends one row to chunk_attempts', async () => {
		const { client, calls } = mockSupabase({ error: null });

		const result = await recordChunkAttempt(client, attempt);

		expect(result).toEqual({ saved: true });
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ table: 'chunk_attempts', method: 'insert' });
	});

	it('sends exactly the eleven columns the column-level INSERT grant covers', async () => {
		const { client, calls } = mockSupabase({ error: null });

		await recordChunkAttempt(client, attempt);

		expect(Object.keys(calls[0].payload as object).sort()).toEqual(THE_ELEVEN_COLUMNS);
	});

	it('never sends created_at or id — the grant omits them and Postgres would refuse with 42501', async () => {
		const { client, calls } = mockSupabase({ error: null });

		await recordChunkAttempt(client, attempt);

		const payload = calls[0].payload as Record<string, unknown>;
		expect('created_at' in payload).toBe(false);
		expect('id' in payload).toBe(false);
	});

	it('maps the input onto the row columns', async () => {
		const { client, calls } = mockSupabase({ error: null });

		await recordChunkAttempt(client, attempt);

		expect(calls[0].payload).toMatchObject({
			user_id: attempt.userId,
			chunk_id: attempt.chunkId,
			book_id: attempt.bookId,
			completed: true
		});
	});

	it('converts startedAt (ms epoch) to an ISO timestamptz string', async () => {
		const { client, calls } = mockSupabase({ error: null });

		await recordChunkAttempt(client, attempt);

		expect((calls[0].payload as Record<string, unknown>).started_at).toBe(
			'2026-07-26T12:00:00.000Z'
		);
	});

	it('rounds elapsedMs to an integer (the column is integer) and passes the numerics through unrounded', async () => {
		const { client, calls } = mockSupabase({ error: null });

		await recordChunkAttempt(client, attempt);

		const payload = calls[0].payload as Record<string, unknown>;
		expect(payload.elapsed_ms).toBe(42_124);
		expect(payload.gross_wpm).toBe(61.4321);
		expect(payload.accuracy_raw).toBe(0.9737);
	});

	it('rounds measuredMs and measuredChars too — both columns are integer', async () => {
		const { client, calls } = mockSupabase({ error: null });

		await recordChunkAttempt(client, mixedAttempt);

		const payload = calls[0].payload as Record<string, unknown>;
		expect(payload.measured_ms).toBe(18_400);
		expect(payload.measured_chars).toBe(212);
	});
});

/**
 * The three rows of spec #24 §4's table. They are asserted at the MAPPER, because this is
 * the last place the shape is under our control: after `toRow` the payload is PostgREST's.
 */
describe('recordChunkAttempt — the measurement axis (spec #24 §4, §5)', () => {
	it('writes a wholly-Normal traversal with non-null metrics and measured_ms = elapsed_ms', async () => {
		const { client, calls } = mockSupabase({ error: null });

		await recordChunkAttempt(client, attempt);

		expect(calls[0].payload).toMatchObject({
			mode: 'normal',
			gross_wpm: 61.4321,
			accuracy_raw: 0.9737,
			elapsed_ms: 42_124,
			measured_ms: 42_124,
			measured_chars: 431
		});
	});

	it('writes a wholly-Zen traversal as mode=zen, metrics NULL and measured_chars 0', async () => {
		const { client, calls } = mockSupabase({ error: null });

		await recordChunkAttempt(client, zenAttempt);

		expect(calls[0].payload).toMatchObject({
			mode: 'zen',
			gross_wpm: null,
			accuracy_raw: null,
			measured_ms: 0,
			measured_chars: 0
		});
	});

	it('writes a mid-way switch as mode=zen with NULL metrics but a real, non-zero span', async () => {
		const { client, calls } = mockSupabase({ error: null });

		await recordChunkAttempt(client, mixedAttempt);

		const payload = calls[0].payload as Record<string, number | null>;
		expect(payload.mode).toBe('zen');
		expect(payload.gross_wpm).toBeNull();
		expect(payload.accuracy_raw).toBeNull();
		expect(payload.measured_ms as number).toBeGreaterThan(0);
		expect(payload.measured_chars as number).toBeGreaterThan(0);
	});

	it('never emits measured_ms above elapsed_ms — the invariant the DB CHECK also enforces', async () => {
		// Including the rounding boundary: round() is monotonic non-decreasing, so an input
		// pair that satisfies the invariant in floats still satisfies it as integers.
		const inputs: ChunkAttemptInput[] = [
			attempt,
			zenAttempt,
			mixedAttempt,
			{ ...attempt, elapsedMs: 1_000.4, measuredMs: 1_000.4 },
			{ ...attempt, elapsedMs: 1_000.5, measuredMs: 1_000.4 },
			{ ...attempt, elapsedMs: 0, measuredMs: 0 }
		];

		for (const input of inputs) {
			const { client, calls } = mockSupabase({ error: null });
			await recordChunkAttempt(client, input);
			const payload = calls[0].payload as Record<string, number>;
			expect(payload.measured_ms).toBeLessThanOrEqual(payload.elapsed_ms);
		}
	});
});

describe('BEST_MEASURED_CHARS_FLOOR', () => {
	it('is 100 measured characters — the twin of the literal inside the rollup function', () => {
		expect(BEST_MEASURED_CHARS_FLOOR).toBe(100);
	});

	it('reports an RLS or grant refusal as a PERMANENT failure rather than throwing', async () => {
		const { client } = mockSupabase({
			status: 403,
			error: { code: '42501', message: 'permission denied for table chunk_attempts' }
		});

		await expect(recordChunkAttempt(client, attempt)).resolves.toEqual({
			saved: false,
			reason: 'permanent'
		});
	});

	it('reports a network failure as a TRANSIENT failure — postgrest-js returns status 0, it does not throw', async () => {
		const { client } = mockSupabase({
			status: 0,
			error: { code: '', message: 'TypeError: Failed to fetch' }
		});

		await expect(recordChunkAttempt(client, attempt)).resolves.toEqual({
			saved: false,
			reason: 'transient'
		});
	});

	it('reports a rejected request as transient — the client constructor or a custom fetch can still throw', async () => {
		const { client } = mockSupabase({ reject: new Error('Failed to fetch') });

		await expect(recordChunkAttempt(client, attempt)).resolves.toEqual({
			saved: false,
			reason: 'transient'
		});
	});

	it('issues exactly one insert on failure — no retry, no backoff, no queue', async () => {
		const failed = mockSupabase({ status: 500, error: { message: 'nope' } });
		await recordChunkAttempt(failed.client, attempt);
		expect(failed.calls).toHaveLength(1);

		const rejected = mockSupabase({ reject: new Error('offline') });
		await recordChunkAttempt(rejected.client, attempt);
		expect(rejected.calls).toHaveLength(1);
	});
});

describe('classifyWriteOutcome', () => {
	it('treats no error as saved, whatever the status', () => {
		expect(classifyWriteOutcome(201, null)).toEqual({ saved: true });
		expect(classifyWriteOutcome(200, null)).toEqual({ saved: true });
	});

	it.each([
		['postgrest-js network/abort sentinel', 0, {}],
		['500 internal error', 500, {}],
		['502 bad gateway', 502, {}],
		['503 unavailable', 503, {}],
		['504 gateway timeout', 504, {}],
		['408 request timeout', 408, {}],
		['429 rate limited', 429, {}]
	])('classifies %s as transient', (_label, status, error) => {
		expect(classifyWriteOutcome(status, error)).toEqual({ saved: false, reason: 'transient' });
	});

	it('classifies 401 with PGRST301 (expired JWT) as transient — spec #15 §11', () => {
		expect(classifyWriteOutcome(401, { code: 'PGRST301', message: 'JWT expired' })).toEqual({
			saved: false,
			reason: 'transient'
		});
	});

	it('classifies 401 with PGRST303 (absent JWT) as transient — spec #15 §11', () => {
		expect(classifyWriteOutcome(401, { code: 'PGRST303', message: 'no JWT' })).toEqual({
			saved: false,
			reason: 'transient'
		});
	});

	it('classifies the JWT codes as transient even if the status is missing or unexpected', () => {
		// The status is the primary discriminator, but a code the library already spells out
		// must not be overruled by a status a mock, a proxy or a future version got wrong.
		expect(classifyWriteOutcome(Number.NaN, { code: 'PGRST301' })).toEqual({
			saved: false,
			reason: 'transient'
		});
	});

	it.each([
		['403 RLS violation', 403, { message: 'new row violates row-level security policy' }],
		['403 grant refusal', 403, { code: '42501', message: 'permission denied' }],
		['400 bad request', 400, { code: 'PGRST102', message: 'malformed' }],
		['404 unknown relation', 404, { code: 'PGRST205', message: 'not found' }],
		['409 unique violation', 409, { code: '23505', message: 'duplicate key' }],
		['409 foreign key violation', 409, { code: '23503', message: 'fk violation' }],
		['422 unprocessable', 422, { code: '22P02', message: 'invalid input syntax' }]
	])('classifies %s as permanent', (_label, status, error) => {
		expect(classifyWriteOutcome(status, error)).toEqual({ saved: false, reason: 'permanent' });
	});

	it('classifies an unknown status defensively as transient — an entry is kept, never silently discarded', () => {
		expect(classifyWriteOutcome(undefined as unknown as number, { message: '?' })).toEqual({
			saved: false,
			reason: 'transient'
		});
	});
});

describe('backfillChunkAttempt', () => {
	it('upserts with ON CONFLICT DO NOTHING on the (user_id, chunk_id, started_at) target', async () => {
		const { client, calls } = mockSupabase({ error: null });

		await backfillChunkAttempt(client, attempt);

		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ table: 'chunk_attempts', method: 'upsert' });
		expect(calls[0].options).toEqual({
			onConflict: 'user_id,chunk_id,started_at',
			ignoreDuplicates: true
		});
	});

	it('sends the same eleven columns as the live write, and never created_at or id', async () => {
		const { client, calls } = mockSupabase({ error: null });

		await backfillChunkAttempt(client, attempt);

		expect(Object.keys(calls[0].payload as object).sort()).toEqual(THE_ELEVEN_COLUMNS);
	});

	it('carries the mode and the span through the drain path unchanged', async () => {
		const { client, calls } = mockSupabase({ error: null });

		await backfillChunkAttempt(client, mixedAttempt);

		expect(calls[0].payload).toMatchObject({
			mode: 'zen',
			gross_wpm: null,
			accuracy_raw: null,
			measured_ms: 18_400,
			measured_chars: 212
		});
	});

	it('maps the payload identically to the live write — one mapper, one payload shape', async () => {
		const live = mockSupabase({ error: null });
		const backfill = mockSupabase({ error: null });

		await recordChunkAttempt(live.client, attempt);
		await backfillChunkAttempt(backfill.client, attempt);

		expect(backfill.calls[0].payload).toEqual(live.calls[0].payload);
	});

	it('reports a duplicate-ignored write as success — the row is already there, which is the goal', async () => {
		// `ignoreDuplicates: true` makes PostgREST emit ON CONFLICT DO NOTHING, so a
		// conflict comes back as a plain 201 with no error and no rows affected.
		const { client } = mockSupabase({ error: null, status: 201 });

		await expect(backfillChunkAttempt(client, attempt)).resolves.toEqual({ saved: true });
	});

	it('classifies its failures by the same taxonomy as the live write', async () => {
		const transient = mockSupabase({ status: 0, error: { message: 'TypeError: Failed to fetch' } });
		await expect(backfillChunkAttempt(transient.client, attempt)).resolves.toEqual({
			saved: false,
			reason: 'transient'
		});

		const permanent = mockSupabase({ status: 403, error: { code: '42501', message: 'denied' } });
		await expect(backfillChunkAttempt(permanent.client, attempt)).resolves.toEqual({
			saved: false,
			reason: 'permanent'
		});
	});

	it('never throws on a rejected request', async () => {
		const { client } = mockSupabase({ reject: new Error('offline') });

		await expect(backfillChunkAttempt(client, attempt)).resolves.toEqual({
			saved: false,
			reason: 'transient'
		});
	});
});
