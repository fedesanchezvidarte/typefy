import { describe, expect, it } from 'vitest';
import type { TypeableTextSummary } from '$lib/types';
import { load, type LibraryPageData } from './+page.server';

/**
 * `/type` load tests (spec #12, §4 Display). The injected Supabase client is mocked —
 * a real DB call must never reach a unit test (testing-patterns). Same chainable,
 * thenable query-builder stub as `src/lib/server/progress.spec.ts`, keyed on the
 * `from(...)` table so one load can serve `books` and `book_progress` different rows.
 *
 * The load itself is not re-testing `listBooks` / `getBookCompletionCounts` (those have
 * their own service specs); it is testing the wiring: the map's KEY (the uuid, never the
 * slug), and above all that a GUEST ISSUES NO PROGRESS QUERY — a stated acceptance
 * criterion, asserted positively against the recorded `from` calls rather than inferred
 * from an empty result.
 */

interface QueryCall {
	method: string;
	args: unknown[];
}

type Result = { data: unknown; error: unknown };

function mockSupabase(resultsByTable: Record<string, Result>) {
	const calls: QueryCall[] = [];

	function builderFor(table: string) {
		const result = resultsByTable[table] ?? { data: [], error: null };
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
		builder.limit = record('limit');
		builder.maybeSingle = (...args: unknown[]) => {
			calls.push({ method: 'maybeSingle', args });
			return Promise.resolve(result);
		};
		builder.then = (
			onFulfilled: (value: unknown) => unknown,
			onRejected?: (reason: unknown) => unknown
		) => Promise.resolve(result).then(onFulfilled, onRejected);
		return builder;
	}

	const client = {
		from: (table: string, ...rest: unknown[]) => {
			calls.push({ method: 'from', args: [table, ...rest] });
			return builderFor(table);
		}
	};

	/** Every table this load actually queried, in call order. */
	const tablesQueried = () =>
		calls.filter((c) => c.method === 'from').map((c) => c.args[0] as string);

	return { client, calls, tablesQueried };
}

const USER = { id: '11111111-1111-1111-1111-111111111111' };

const PRIDE_UUID = 'aaaaaaaa-0000-0000-0000-000000000001';
const QUIJOTE_UUID = 'aaaaaaaa-0000-0000-0000-000000000002';
const UNTOUCHED_UUID = 'aaaaaaaa-0000-0000-0000-000000000003';

const BOOK_ROWS = [
	{
		id: PRIDE_UUID,
		slug: 'pride-and-prejudice',
		title: 'Pride and Prejudice',
		author: 'Jane Austen',
		language: 'en',
		chunk_count: 6,
		cover_url: null
	},
	{
		id: QUIJOTE_UUID,
		slug: 'don-quijote',
		title: 'Don Quijote',
		author: 'Miguel de Cervantes',
		language: 'es',
		chunk_count: 4,
		cover_url: null
	},
	{
		id: UNTOUCHED_UUID,
		slug: 'never-opened',
		title: 'Never Opened',
		author: 'Nobody',
		language: 'en',
		chunk_count: 3,
		cover_url: null
	}
];

function loadEvent(
	options: {
		user?: { id: string } | null;
		books?: Result;
		bookProgress?: Result;
	} = {}
) {
	const supabase = mockSupabase({
		books: options.books ?? { data: BOOK_ROWS, error: null },
		book_progress: options.bookProgress ?? { data: [], error: null }
	});
	const event = {
		locals: {
			supabase: supabase.client,
			safeGetSession: async () => ({
				session: options.user ? { user: options.user } : null,
				user: options.user ?? null
			})
		}
	};
	// Only the fields the load touches are stubbed; the cast keeps the test honest about
	// the load's own event type rather than widening to a hand-built ServerLoadEvent.
	return { event: event as unknown as Parameters<typeof load>[0], supabase };
}

/**
 * `PageServerLoad` is declared as returning `data | void`, so awaiting it yields a union
 * TypeScript will not let the assertions index into. This load always returns data — it
 * either throws or returns the object — so the narrowing happens once here rather than
 * being repeated at every assertion.
 */
async function runLoad(event: Parameters<typeof load>[0]): Promise<LibraryPageData> {
	return await load(event);
}

describe('/type load — books', () => {
	it('returns every seeded book for a signed-in user', async () => {
		const { event } = loadEvent({ user: USER });

		const data = await runLoad(event);

		expect(data.books.map((book: TypeableTextSummary) => book.id)).toEqual([
			'pride-and-prejudice',
			'don-quijote',
			'never-opened'
		]);
	});

	it('returns the books for a guest too — only progress is withheld', async () => {
		const { event } = loadEvent({ user: null });

		const data = await runLoad(event);

		expect(data.books).toHaveLength(3);
	});
});

describe('/type load — progressByBook for a signed-in user', () => {
	it('keys the map by books.id (the uuid), never by the slug', async () => {
		const { event } = loadEvent({
			user: USER,
			bookProgress: {
				data: [{ book_id: PRIDE_UUID, chunks_completed: 3 }],
				error: null
			}
		});

		const data = await runLoad(event);

		expect(data.progressByBook[PRIDE_UUID]).toBe(3);
		// The slug is the URL key, not the database key — indexing by it must miss.
		expect(data.progressByBook['pride-and-prejudice']).toBeUndefined();
	});

	it('carries the counts from getBookCompletionCounts for every rolled-up book', async () => {
		const { event } = loadEvent({
			user: USER,
			bookProgress: {
				data: [
					{ book_id: PRIDE_UUID, chunks_completed: 3 },
					{ book_id: QUIJOTE_UUID, chunks_completed: 4 }
				],
				error: null
			}
		});

		const data = await runLoad(event);

		expect(data.progressByBook).toEqual({
			[PRIDE_UUID]: 3,
			[QUIJOTE_UUID]: 4
		});
	});

	it('leaves a never-attempted book out of the map entirely', async () => {
		const { event } = loadEvent({
			user: USER,
			bookProgress: {
				data: [{ book_id: PRIDE_UUID, chunks_completed: 3 }],
				error: null
			}
		});

		const data = await runLoad(event);

		// No book_progress row exists; absence is not an error, the page renders 0.
		expect(UNTOUCHED_UUID in data.progressByBook).toBe(false);
	});

	it('keeps an attempted-but-nothing-completed book in the map with 0', async () => {
		const { event } = loadEvent({
			user: USER,
			bookProgress: {
				data: [
					{ book_id: PRIDE_UUID, chunks_completed: 3 },
					{ book_id: QUIJOTE_UUID, chunks_completed: 0 }
				],
				error: null
			}
		});

		const data = await runLoad(event);

		// A distinct DB state from "absent": the trigger wrote a row on an incomplete
		// attempt. The load passes both through faithfully; the page renders both as 0.
		expect(QUIJOTE_UUID in data.progressByBook).toBe(true);
		expect(data.progressByBook[QUIJOTE_UUID]).toBe(0);
	});

	it('returns an empty map when the user has no rollup rows at all', async () => {
		const { event } = loadEvent({ user: USER, bookProgress: { data: [], error: null } });

		const data = await runLoad(event);

		expect(data.progressByBook).toEqual({});
	});

	it('queries book_progress exactly once for a signed-in user', async () => {
		const { event, supabase } = loadEvent({ user: USER });

		await load(event);

		expect(supabase.tablesQueried()).toEqual(['books', 'book_progress']);
	});
});

describe('/type load — guest', () => {
	it('issues ZERO progress queries (spec #12 acceptance criterion)', async () => {
		const { event, supabase } = loadEvent({ user: null });

		await load(event);

		// Asserted positively against the recorded calls: it is not enough that the
		// returned map is empty — no request may be made at all.
		const tables = supabase.tablesQueried();
		expect(tables).toEqual(['books']);
		expect(tables).not.toContain('book_progress');
		expect(tables).not.toContain('chunk_progress');
		expect(tables).not.toContain('chunk_attempts');
	});

	it('does not even reach a select on a progress table', async () => {
		const { event, supabase } = loadEvent({ user: null });

		await load(event);

		// The early return happens before any builder is created for a rollup table,
		// so the only recorded query chain belongs to listBooks.
		expect(supabase.calls.filter((c) => c.method === 'from')).toHaveLength(1);
	});

	it('returns an empty progressByBook', async () => {
		const { event } = loadEvent({ user: null });

		const data = await runLoad(event);

		expect(data.progressByBook).toEqual({});
	});
});

describe('/type load — errors', () => {
	it('propagates a DB error from the progress read (no silent fallback to zero progress)', async () => {
		const { event } = loadEvent({
			user: USER,
			bookProgress: { data: null, error: { message: 'connection refused' } }
		});

		// A swallowed error would render every bar at 0%, which is a wrong answer
		// dressed as a real one.
		await expect(load(event)).rejects.toEqual({ message: 'connection refused' });
	});

	it('propagates a DB error from the books read', async () => {
		const { event } = loadEvent({
			user: USER,
			books: { data: null, error: { message: 'timeout' } }
		});

		await expect(load(event)).rejects.toEqual({ message: 'timeout' });
	});
});
