import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/database.types';
import { getBookCompletionCount, getBookCompletionCounts, getCompletedChunkIds } from './progress';

/**
 * Service tests (spec #12, Phase C): the injected Supabase client is mocked — a real DB
 * call must never reach a unit test (testing-patterns). Same chainable, thenable query
 * builder as `books.spec.ts`, extended with `not` (the completion predicate).
 */
interface QueryCall {
	method: string;
	args: unknown[];
}

function mockSupabase(result: { data: unknown; error: unknown }) {
	const calls: QueryCall[] = [];
	const builder: Record<string, unknown> = {};
	const record =
		(method: string) =>
		(...args: unknown[]) => {
			calls.push({ method, args });
			return builder;
		};
	builder.select = record('select');
	builder.eq = record('eq');
	builder.not = record('not');
	builder.is = record('is');
	builder.order = record('order');
	builder.maybeSingle = (...args: unknown[]) => {
		calls.push({ method: 'maybeSingle', args });
		return Promise.resolve(result);
	};
	builder.then = (
		onFulfilled: (value: unknown) => unknown,
		onRejected?: (reason: unknown) => unknown
	) => Promise.resolve(result).then(onFulfilled, onRejected);
	const client = {
		from: (...args: unknown[]) => {
			calls.push({ method: 'from', args });
			return builder;
		}
	};
	return { client: client as unknown as SupabaseClient<Database>, calls };
}

const USER = '11111111-1111-1111-1111-111111111111';
const BOOK = '22222222-2222-2222-2222-222222222222';

describe('getCompletedChunkIds', () => {
	it('returns the completed chunk ids as a Set', async () => {
		const { client } = mockSupabase({
			data: [{ chunk_id: 'chunk-a' }, { chunk_id: 'chunk-b' }],
			error: null
		});

		const ids = await getCompletedChunkIds(client, USER, BOOK);

		expect([...ids].sort()).toEqual(['chunk-a', 'chunk-b']);
		expect(ids.has('chunk-a')).toBe(true);
	});

	it('returns an empty set when the user has no rows for the book', async () => {
		const { client } = mockSupabase({ data: [], error: null });
		expect((await getCompletedChunkIds(client, USER, BOOK)).size).toBe(0);
	});

	it('reads chunk_progress scoped to the user and book', async () => {
		const { client, calls } = mockSupabase({ data: [], error: null });

		await getCompletedChunkIds(client, USER, BOOK);

		expect(calls.find((c) => c.method === 'from')?.args).toEqual(['chunk_progress']);
		const eqs = calls.filter((c) => c.method === 'eq').map((c) => c.args);
		expect(eqs).toEqual([
			['user_id', USER],
			['book_id', BOOK]
		]);
	});

	it('tests completion with first_completed_at is not null, never row existence', async () => {
		const { client, calls } = mockSupabase({ data: [], error: null });

		await getCompletedChunkIds(client, USER, BOOK);

		// An incomplete attempt still creates a chunk_progress row (attempt_count > 0,
		// first_completed_at null), so the predicate is what makes the read correct.
		expect(calls.find((c) => c.method === 'not')?.args).toEqual(['first_completed_at', 'is', null]);
	});

	it('throws when the database returns an error (no silent fallback)', async () => {
		const { client } = mockSupabase({ data: null, error: { message: 'timeout' } });
		await expect(getCompletedChunkIds(client, USER, BOOK)).rejects.toEqual({ message: 'timeout' });
	});
});

describe('getBookCompletionCounts', () => {
	it('maps book_progress rows to a Map keyed by books.id', async () => {
		const { client } = mockSupabase({
			data: [
				{ book_id: 'book-a', chunks_completed: 3 },
				{ book_id: 'book-b', chunks_completed: 0 }
			],
			error: null
		});

		const counts = await getBookCompletionCounts(client, USER);

		expect(counts.get('book-a')).toBe(3);
		expect(counts.get('book-b')).toBe(0);
		expect(counts.size).toBe(2);
	});

	it('leaves untouched books out of the map (the caller renders 0)', async () => {
		const { client } = mockSupabase({
			data: [{ book_id: 'book-a', chunks_completed: 1 }],
			error: null
		});

		const counts = await getBookCompletionCounts(client, USER);

		expect(counts.has('book-never-opened')).toBe(false);
		expect(counts.get('book-never-opened')).toBeUndefined();
	});

	it('reads book_progress scoped to the user only', async () => {
		const { client, calls } = mockSupabase({ data: [], error: null });

		await getBookCompletionCounts(client, USER);

		expect(calls.find((c) => c.method === 'from')?.args).toEqual(['book_progress']);
		expect(calls.filter((c) => c.method === 'eq').map((c) => c.args)).toEqual([['user_id', USER]]);
	});

	it('throws when the database returns an error', async () => {
		const { client } = mockSupabase({ data: null, error: { message: 'connection refused' } });
		await expect(getBookCompletionCounts(client, USER)).rejects.toEqual({
			message: 'connection refused'
		});
	});
});

describe('getBookCompletionCount', () => {
	it('returns the persisted count for the book', async () => {
		const { client } = mockSupabase({ data: { chunks_completed: 7 }, error: null });
		expect(await getBookCompletionCount(client, USER, BOOK)).toBe(7);
	});

	it('returns 0 when no book_progress row exists yet', async () => {
		const { client } = mockSupabase({ data: null, error: null });
		expect(await getBookCompletionCount(client, USER, BOOK)).toBe(0);
	});

	it('reads a single book_progress row scoped to the user and book', async () => {
		const { client, calls } = mockSupabase({ data: null, error: null });

		await getBookCompletionCount(client, USER, BOOK);

		expect(calls.find((c) => c.method === 'from')?.args).toEqual(['book_progress']);
		expect(calls.filter((c) => c.method === 'eq').map((c) => c.args)).toEqual([
			['user_id', USER],
			['book_id', BOOK]
		]);
		expect(calls.some((c) => c.method === 'maybeSingle')).toBe(true);
	});

	it('throws when the database returns an error', async () => {
		const { client } = mockSupabase({ data: null, error: { message: 'timeout' } });
		await expect(getBookCompletionCount(client, USER, BOOK)).rejects.toEqual({
			message: 'timeout'
		});
	});
});
