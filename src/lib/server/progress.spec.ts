import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/database.types';
import {
	getBookActivity,
	getBookCompletionCount,
	getCompletedChunkIds,
	getCompletedChunkIndexes,
	resetBookProgress
} from './progress';

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

describe('getBookActivity', () => {
	it('maps book_progress rows to a Map keyed by books.id', async () => {
		const { client } = mockSupabase({
			data: [
				{ book_id: 'book-a', chunks_completed: 3, last_active_at: '2026-07-20T10:00:00Z' },
				{ book_id: 'book-b', chunks_completed: 0, last_active_at: '2026-07-01T10:00:00Z' }
			],
			error: null
		});

		const activity = await getBookActivity(client, USER);

		expect(activity.get('book-a')).toEqual({
			chunksCompleted: 3,
			lastActiveAt: '2026-07-20T10:00:00Z'
		});
		expect(activity.get('book-b')?.chunksCompleted).toBe(0);
		expect(activity.size).toBe(2);
	});

	it('keys the map by the uuid, never by the slug', async () => {
		const { client } = mockSupabase({
			data: [
				{
					book_id: '22222222-2222-2222-2222-222222222222',
					chunks_completed: 1,
					last_active_at: null
				}
			],
			error: null
		});

		const activity = await getBookActivity(client, USER);

		expect(activity.has(BOOK)).toBe(true);
		expect(activity.has('pride-and-prejudice')).toBe(false);
	});

	it('carries a null last_active_at through rather than inventing a timestamp', async () => {
		// The rollup trigger may not have timestamped the row; the selection sorts nulls last
		// and needs to be able to see one.
		const { client } = mockSupabase({
			data: [{ book_id: 'book-a', chunks_completed: 2, last_active_at: null }],
			error: null
		});

		expect((await getBookActivity(client, USER)).get('book-a')?.lastActiveAt).toBeNull();
	});

	it('leaves untouched books out of the map (the caller renders 0)', async () => {
		const { client } = mockSupabase({
			data: [{ book_id: 'book-a', chunks_completed: 1, last_active_at: null }],
			error: null
		});

		const activity = await getBookActivity(client, USER);

		expect(activity.has('book-never-opened')).toBe(false);
		expect(activity.get('book-never-opened')).toBeUndefined();
	});

	it('reads book_progress scoped to the user only, in ONE query', async () => {
		const { client, calls } = mockSupabase({ data: [], error: null });

		await getBookActivity(client, USER);

		expect(calls.filter((c) => c.method === 'from')).toHaveLength(1);
		expect(calls.find((c) => c.method === 'from')?.args).toEqual(['book_progress']);
		expect(calls.filter((c) => c.method === 'eq').map((c) => c.args)).toEqual([['user_id', USER]]);
	});

	it('selects the timestamp alongside the count — a wider row, not a second round trip', async () => {
		const { client, calls } = mockSupabase({ data: [], error: null });

		await getBookActivity(client, USER);

		const columns = String(calls.find((c) => c.method === 'select')?.args[0])
			.split(',')
			.map((column) => column.trim());
		expect(columns).toEqual(['book_id', 'chunks_completed', 'last_active_at']);
	});

	it('does not order or limit in the query', async () => {
		// Ordering and limiting before the completed-book exclusion would silently return fewer
		// than three, and the exclusion needs books.chunk_count — which is not in this table.
		const { client, calls } = mockSupabase({ data: [], error: null });

		await getBookActivity(client, USER);

		expect(calls.some((c) => c.method === 'order' || c.method === 'limit')).toBe(false);
	});

	it('throws when the database returns an error', async () => {
		const { client } = mockSupabase({ data: null, error: { message: 'connection refused' } });
		await expect(getBookActivity(client, USER)).rejects.toEqual({
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

/**
 * A mock whose `.range()` serves successive PAGES, so pagination is exercised rather than
 * assumed. Each entry is one `{ data, error }` the next `.range()` call resolves to.
 */
function mockPagedSupabase(pages: { data: unknown; error: unknown }[]) {
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
	builder.order = record('order');
	let page = 0;
	builder.range = (...args: unknown[]) => {
		calls.push({ method: 'range', args });
		const result = pages[page] ?? { data: [], error: null };
		page += 1;
		return {
			then: (onFulfilled: (value: unknown) => unknown, onRejected?: (r: unknown) => unknown) =>
				Promise.resolve(result).then(onFulfilled, onRejected)
		};
	};
	const client = {
		from: (...args: unknown[]) => {
			calls.push({ method: 'from', args });
			return builder;
		}
	};
	return { client: client as unknown as SupabaseClient<Database>, calls };
}

/** `n` rows of embedded `chunks(index)`, starting at `from`. */
function chunkRows(from: number, n: number) {
	return Array.from({ length: n }, (_, i) => ({ chunks: { index: from + i } }));
}

describe('getCompletedChunkIndexes', () => {
	it('returns the completed chunk indices', async () => {
		const { client } = mockPagedSupabase([{ data: chunkRows(0, 3), error: null }]);
		expect(await getCompletedChunkIndexes(client, USER, BOOK)).toEqual([0, 1, 2]);
	});

	it('returns an empty array when the user has completed nothing', async () => {
		const { client } = mockPagedSupabase([{ data: [], error: null }]);
		expect(await getCompletedChunkIndexes(client, USER, BOOK)).toEqual([]);
	});

	it('reads chunk_progress with chunks(index) embedded, scoped and completion-filtered', async () => {
		const { client, calls } = mockPagedSupabase([{ data: [], error: null }]);

		await getCompletedChunkIndexes(client, USER, BOOK);

		expect(calls.find((c) => c.method === 'from')?.args).toEqual(['chunk_progress']);
		expect(calls.find((c) => c.method === 'select')?.args[0]).toBe('chunks(index)');
		expect(calls.filter((c) => c.method === 'eq').map((c) => c.args)).toEqual([
			['user_id', USER],
			['book_id', BOOK]
		]);
		// Row existence is NOT completion — the trigger writes a row on every attempt.
		expect(calls.find((c) => c.method === 'not')?.args).toEqual(['first_completed_at', 'is', null]);
	});

	it('orders by chunk_id, the stable key .range() can partition on', async () => {
		const { client, calls } = mockPagedSupabase([{ data: [], error: null }]);
		await getCompletedChunkIndexes(client, USER, BOOK);
		expect(calls.find((c) => c.method === 'order')?.args[0]).toBe('chunk_id');
	});

	it('paginates past the 1,000-row cap instead of silently under-reporting', async () => {
		// supabase/config.toml sets max_rows = 1000 and don-quijote runs ~2,000 pages. An
		// unpaginated read returns 1,000 rows with no error and every chapter past the
		// truncation point reads as untouched.
		const { client, calls } = mockPagedSupabase([
			{ data: chunkRows(0, 1000), error: null },
			{ data: chunkRows(1000, 1000), error: null },
			{ data: chunkRows(2000, 40), error: null }
		]);

		const indexes = await getCompletedChunkIndexes(client, USER, BOOK);

		expect(indexes).toHaveLength(2040);
		expect(indexes[2039]).toBe(2039);
		expect(calls.filter((c) => c.method === 'range').map((c) => c.args)).toEqual([
			[0, 999],
			[1000, 1999],
			[2000, 2999]
		]);
	});

	it('stops after a short page rather than issuing a needless final request', async () => {
		const { client, calls } = mockPagedSupabase([{ data: chunkRows(0, 12), error: null }]);
		await getCompletedChunkIndexes(client, USER, BOOK);
		expect(calls.filter((c) => c.method === 'range')).toHaveLength(1);
	});

	it('issues exactly one more request when the last full page ends the set', async () => {
		const { client, calls } = mockPagedSupabase([
			{ data: chunkRows(0, 1000), error: null },
			{ data: [], error: null }
		]);
		expect(await getCompletedChunkIndexes(client, USER, BOOK)).toHaveLength(1000);
		expect(calls.filter((c) => c.method === 'range')).toHaveLength(2);
	});

	it('throws on a mid-pagination error rather than returning a partial read', async () => {
		// A partial read must never be reported as progress — that renders a wrong bar
		// instead of an error, which is this file's standing doctrine.
		const { client } = mockPagedSupabase([
			{ data: chunkRows(0, 1000), error: null },
			{ data: null, error: { message: 'timeout' } }
		]);
		await expect(getCompletedChunkIndexes(client, USER, BOOK)).rejects.toEqual({
			message: 'timeout'
		});
	});

	it('throws when the first page errors', async () => {
		const { client } = mockPagedSupabase([{ data: null, error: { message: 'timeout' } }]);
		await expect(getCompletedChunkIndexes(client, USER, BOOK)).rejects.toEqual({
			message: 'timeout'
		});
	});

	it('skips a row whose embedded chunk is missing rather than emitting a hole', async () => {
		const { client } = mockPagedSupabase([
			{ data: [{ chunks: { index: 4 } }, { chunks: null }, { chunks: { index: 9 } }], error: null }
		]);
		expect(await getCompletedChunkIndexes(client, USER, BOOK)).toEqual([4, 9]);
	});
});

/**
 * The reset (spec #51) — the module's only write, and the application's only destructive path.
 *
 * `rpc` is its own seam: `resetBookProgress` never touches the query builder, because every
 * rule lives in the SQL function. What these prove is the contract the route depends on —
 * which function, which argument, and that a failure is not swallowed.
 */
function mockRpc(result: { error: unknown }) {
	const calls: QueryCall[] = [];
	const client = {
		rpc: (...args: unknown[]) => {
			calls.push({ method: 'rpc', args });
			return Promise.resolve({ data: null, ...result });
		},
		from: () => {
			throw new Error('resetBookProgress must go through the RPC, never a table write');
		}
	};
	return { client: client as unknown as SupabaseClient<Database>, calls };
}

describe('resetBookProgress', () => {
	it('calls the reset RPC with the book id', async () => {
		const { client, calls } = mockRpc({ error: null });

		await resetBookProgress(client, BOOK);

		expect(calls).toEqual([{ method: 'rpc', args: ['reset_book_progress', { p_book_id: BOOK }] }]);
	});

	/**
	 * The guarantee that makes a destructive function safe to expose to `authenticated`: the
	 * RPC reads `auth.uid()` internally, so there is no user id to pass and therefore no user
	 * id to get wrong. A signature that accepted one would have to be reviewed for whether it
	 * could reset somebody else's progress.
	 */
	it('sends no user id — the RPC resolves the caller itself', async () => {
		const { client, calls } = mockRpc({ error: null });

		await resetBookProgress(client, BOOK);

		expect(JSON.stringify(calls)).not.toContain(USER);
		expect(Object.keys(calls[0].args[1] as object)).toEqual(['p_book_id']);
	});

	it('throws rather than reporting a reset that did not happen', async () => {
		const { client } = mockRpc({ error: { message: 'permission denied' } });

		await expect(resetBookProgress(client, BOOK)).rejects.toMatchObject({
			message: 'permission denied'
		});
	});
});
