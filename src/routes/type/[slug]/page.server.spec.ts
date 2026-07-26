import { describe, expect, it } from 'vitest';
import { load, type TypingPageData } from './+page.server';

/**
 * `/type/[slug]` load tests (spec #12, §3 Resume + §4 Display). The injected Supabase
 * client is mocked — a real DB call must never reach a unit test (testing-patterns).
 *
 * The two progress reads run concurrently under one `Promise.all`, so the stub is keyed
 * on the `from(...)` table and builds a FRESH builder per call: `chunk_progress` and
 * `book_progress` must be able to answer differently, and neither may see the other's
 * recorded state.
 *
 * The exhaustive `?passage=N` matrix lives in `src/lib/progress/resume.spec.ts`. What is
 * proved here is only that the route CONSUMES the param — no pre-validation, no 400 —
 * and that a guest issues no progress query at all.
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

	const tablesQueried = () =>
		calls.filter((c) => c.method === 'from').map((c) => c.args[0] as string);

	return { client, calls, tablesQueried };
}

const USER = { id: '11111111-1111-1111-1111-111111111111' };
const BOOK_UUID = 'aaaaaaaa-0000-0000-0000-000000000001';
const SLUG = 'pride-and-prejudice';

/** Chunk uuids at array positions 0..4, deliberately unrelated to their index. */
const CHUNK_IDS = [
	'cccccccc-0000-0000-0000-00000000000a',
	'cccccccc-0000-0000-0000-00000000000b',
	'cccccccc-0000-0000-0000-00000000000c',
	'cccccccc-0000-0000-0000-00000000000d',
	'cccccccc-0000-0000-0000-00000000000e'
];

const BOOK_ROW = {
	id: BOOK_UUID,
	slug: SLUG,
	title: 'Pride and Prejudice',
	author: 'Jane Austen',
	language: 'en',
	chunk_count: CHUNK_IDS.length,
	cover_url: null,
	chunks: CHUNK_IDS.map((id, index) => ({
		id,
		index,
		content: `Passage ${index + 1}.`,
		char_count: 11
	}))
};

/** `chunk_progress` rows as the read service sees them, for the given array positions. */
function completedRows(positions: readonly number[]) {
	return positions.map((position) => ({ chunk_id: CHUNK_IDS[position] }));
}

function loadEvent(
	options: {
		user?: { id: string } | null;
		slug?: string;
		passage?: string | null;
		book?: Result;
		chunkProgress?: Result;
		bookProgress?: Result;
	} = {}
) {
	const slug = options.slug ?? SLUG;
	const supabase = mockSupabase({
		books: options.book ?? { data: BOOK_ROW, error: null },
		chunk_progress: options.chunkProgress ?? { data: [], error: null },
		book_progress: options.bookProgress ?? { data: null, error: null }
	});

	// A real URL, so `url.searchParams` behaves exactly as SvelteKit hands it to the load
	// (including `?passage=` decoding to the empty string rather than null).
	const query = options.passage === undefined ? '' : `?passage=${options.passage}`;
	const url = new URL(`http://localhost/type/${slug}${query}`);

	const event = {
		params: { slug },
		url,
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
 * either throws (404, DB error) or returns the object — so the narrowing happens once
 * here rather than being repeated at every assertion.
 */
async function runLoad(event: Parameters<typeof load>[0]): Promise<TypingPageData> {
	return await load(event);
}

describe('/type/[slug] load — unknown slug', () => {
	it('throws a 404 when no book has that slug', async () => {
		const { event } = loadEvent({ user: USER, book: { data: null, error: null } });

		await expect(load(event)).rejects.toMatchObject({ status: 404 });
	});

	it('issues no progress query for an unknown slug — the 404 happens first', async () => {
		const { event, supabase } = loadEvent({ user: USER, book: { data: null, error: null } });

		await expect(load(event)).rejects.toMatchObject({ status: 404 });
		expect(supabase.tablesQueried()).toEqual(['books']);
	});
});

describe('/type/[slug] load — guest', () => {
	it('starts at passage 1 with no progress', async () => {
		const { event } = loadEvent({ user: null });

		const data = await runLoad(event);

		expect(data.startIndex).toBe(0);
		expect(data.completedChunkIds).toEqual([]);
		expect(data.chunksCompleted).toBe(0);
	});

	it('issues ZERO progress queries (spec #12 acceptance criterion)', async () => {
		const { event, supabase } = loadEvent({ user: null });

		await load(event);

		// Asserted positively against the recorded calls: an empty result is not proof.
		const tables = supabase.tablesQueried();
		expect(tables).toEqual(['books']);
		expect(tables).not.toContain('chunk_progress');
		expect(tables).not.toContain('book_progress');
	});

	it('still honours ?passage=N for a guest', async () => {
		const { event, supabase } = loadEvent({ user: null, passage: '4' });

		const data = await runLoad(event);

		expect(data.startIndex).toBe(3);
		expect(supabase.tablesQueried()).toEqual(['books']);
	});

	it('returns the book itself', async () => {
		const { event } = loadEvent({ user: null });

		const data = await runLoad(event);

		expect(data.book.id).toBe(SLUG);
		expect(data.book.bookId).toBe(BOOK_UUID);
		expect(data.book.chunks).toHaveLength(5);
	});
});

describe('/type/[slug] load — resume for a signed-in user', () => {
	it('opens at passage 4 when passages 1-3 are complete', async () => {
		const { event } = loadEvent({
			user: USER,
			chunkProgress: { data: completedRows([0, 1, 2]), error: null }
		});

		const data = await runLoad(event);

		expect(data.startIndex).toBe(3);
	});

	it('opens at the gap when passages 1 and 3 are complete but 2 is not', async () => {
		const { event } = loadEvent({
			user: USER,
			chunkProgress: { data: completedRows([0, 2]), error: null }
		});

		const data = await runLoad(event);

		expect(data.startIndex).toBe(1);
	});

	it('opens a fully completed book at passage 1', async () => {
		const { event } = loadEvent({
			user: USER,
			chunkProgress: { data: completedRows([0, 1, 2, 3, 4]), error: null }
		});

		const data = await runLoad(event);

		// There is no "you have finished" state in this spec.
		expect(data.startIndex).toBe(0);
	});

	it('opens at passage 1 when nothing is complete', async () => {
		const { event } = loadEvent({ user: USER, chunkProgress: { data: [], error: null } });

		const data = await runLoad(event);

		expect(data.startIndex).toBe(0);
	});

	it('reads both rollup tables exactly once', async () => {
		const { event, supabase } = loadEvent({ user: USER });

		await load(event);

		expect(supabase.tablesQueried().slice(1).sort()).toEqual(['book_progress', 'chunk_progress']);
	});
});

describe('/type/[slug] load — ?passage override', () => {
	it('lets ?passage=3 override a different computed index', async () => {
		const { event } = loadEvent({
			user: USER,
			// Gap at position 1, so the computed index is 1 — NOT the override's 2.
			chunkProgress: { data: completedRows([0, 2]), error: null },
			passage: '3'
		});

		const data = await runLoad(event);

		expect(data.startIndex).toBe(2);
	});

	it('lets ?passage override even a fully completed book', async () => {
		const { event } = loadEvent({
			user: USER,
			chunkProgress: { data: completedRows([0, 1, 2, 3, 4]), error: null },
			passage: '5'
		});

		const data = await runLoad(event);

		expect(data.startIndex).toBe(4);
	});

	// The exhaustive validity matrix lives in resume.spec.ts. Here the point is only that
	// the route does not pre-validate the param: every bad value opens the book normally.
	const INVALID = [
		['zero', '0'],
		['beyond the chunk count', '999'],
		['non-numeric', 'abc'],
		['empty', '']
	] as const;

	it.each(INVALID)('falls back to the computed index for a %s passage param', async (_, value) => {
		const { event } = loadEvent({
			user: USER,
			// Computed index is 1 (gap at position 1).
			chunkProgress: { data: completedRows([0, 2]), error: null },
			passage: value
		});

		const data = await runLoad(event);

		// No throw, no error status: a stale hand-edited link must still open the book.
		expect(data.startIndex).toBe(1);
		expect(data.book.id).toBe(SLUG);
	});
});

describe('/type/[slug] load — serialisable payload', () => {
	it('returns completedChunkIds as an array, not a Set', async () => {
		const { event } = loadEvent({
			user: USER,
			chunkProgress: { data: completedRows([0, 2]), error: null }
		});

		const data = await runLoad(event);

		// A Set does not survive SvelteKit's load serialisation — it would arrive empty.
		expect(Array.isArray(data.completedChunkIds)).toBe(true);
		expect(data.completedChunkIds instanceof Set).toBe(false);
		expect([...data.completedChunkIds].sort()).toEqual([CHUNK_IDS[0], CHUNK_IDS[2]].sort());
	});

	it('survives a JSON round trip with its ids intact', async () => {
		const { event } = loadEvent({
			user: USER,
			chunkProgress: { data: completedRows([1]), error: null }
		});

		const data = await runLoad(event);

		expect(JSON.parse(JSON.stringify(data)).completedChunkIds).toEqual([CHUNK_IDS[1]]);
	});
});

describe('/type/[slug] load — chunksCompleted', () => {
	it('reflects the persisted book_progress count', async () => {
		const { event } = loadEvent({
			user: USER,
			bookProgress: { data: { chunks_completed: 3 }, error: null }
		});

		const data = await runLoad(event);

		expect(data.chunksCompleted).toBe(3);
	});

	it('is 0 when the user has no book_progress row yet', async () => {
		const { event } = loadEvent({ user: USER, bookProgress: { data: null, error: null } });

		const data = await runLoad(event);

		expect(data.chunksCompleted).toBe(0);
	});
});

describe('/type/[slug] load — errors', () => {
	it('propagates a DB error from the completed-chunks read', async () => {
		const { event } = loadEvent({
			user: USER,
			chunkProgress: { data: null, error: { message: 'timeout' } }
		});

		await expect(load(event)).rejects.toEqual({ message: 'timeout' });
	});

	it('propagates a DB error from the book_progress read', async () => {
		const { event } = loadEvent({
			user: USER,
			bookProgress: { data: null, error: { message: 'connection refused' } }
		});

		await expect(load(event)).rejects.toEqual({ message: 'connection refused' });
	});

	it('propagates a DB error from the book read', async () => {
		const { event } = loadEvent({
			user: USER,
			book: { data: null, error: { message: 'connection refused' } }
		});

		await expect(load(event)).rejects.toEqual({ message: 'connection refused' });
	});
});
