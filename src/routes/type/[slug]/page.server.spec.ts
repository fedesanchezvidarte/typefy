import { describe, expect, it } from 'vitest';
import { load, type TypingPageData } from './+page.server';
import { WINDOW_SIZE } from '$lib/reading/window';

/**
 * `/type/[slug]` load tests (spec #12 §3 Resume + §4 Display, rebased on spec #18's windowed
 * reads). The injected Supabase client is mocked — a real DB call must never reach a unit
 * test (testing-patterns).
 *
 * Two things the stub does deliberately:
 *
 * - It is keyed on the `from(...)` table and builds a FRESH builder per call, because the
 *   reads that share a `Promise.all` must be able to answer differently and neither may see
 *   the other's recorded state.
 * - The `chunks` builder **honours the range it is given**: it reads back the `gte`/`lt`
 *   bounds the service applied and returns exactly the rows in them, out of a synthetic book
 *   of `chunkCount` chunks. Returning a fixed array regardless would make every windowing
 *   assertion here vacuous — the point is that the load asks for the right range.
 *
 * Resume itself is now a `SECURITY DEFINER` SQL function, so what is provable here is that
 * the load CALLS it with the book's uuid and feeds its answer to `resolveStartIndex`. The
 * function's own behaviour (gaps, fully complete, unpublished) is pinned by the database
 * tests. The exhaustive `?passage=N` matrix lives in `src/lib/progress/resume.spec.ts`.
 */

interface QueryCall {
	method: string;
	args: unknown[];
}

type Result = { data: unknown; error: unknown };

/** Chunk uuids derived from the index, deliberately unlike the index itself. */
function chunkId(index: number): string {
	return `cccccccc-0000-0000-0000-${String(index).padStart(12, '0')}`;
}

function chunkRow(index: number) {
	return {
		id: chunkId(index),
		index,
		content: `Passage ${index + 1}.`,
		char_count: 11
	};
}

interface MockOptions {
	book?: Result;
	/** Length of the synthetic book the `chunks` table serves ranges out of. */
	chunkCount?: number;
	chunksError?: unknown;
	chunkProgress?: Result;
	bookProgress?: Result;
	/** The book's chapter rows (spec #45). Absent means a book with no derivable structure. */
	chapters?: Result;
	rpc?: Result;
}

function mockSupabase(options: MockOptions) {
	const calls: QueryCall[] = [];
	const chunkCount = options.chunkCount ?? DEFAULT_CHUNK_COUNT;

	function recorder(
		builder: Record<string, unknown>,
		method: string,
		onCall?: (args: unknown[]) => void
	) {
		return (...args: unknown[]) => {
			calls.push({ method, args });
			onCall?.(args);
			return builder;
		};
	}

	/** Answers the configured `{ data, error }` however it is filtered. */
	function staticBuilder(result: Result) {
		const builder: Record<string, unknown> = {};
		for (const method of ['select', 'eq', 'not', 'gte', 'lt', 'order', 'limit']) {
			builder[method] = recorder(builder, method);
		}
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

	/** Serves the rows in `[gte, lt)`, so a window assertion means something. */
	function chunksBuilder() {
		const range = { from: 0, to: chunkCount };
		const builder: Record<string, unknown> = {};
		for (const method of ['select', 'eq', 'order', 'limit', 'not']) {
			builder[method] = recorder(builder, method);
		}
		builder.gte = recorder(builder, 'gte', (args) => {
			if (args[0] === 'index') range.from = args[1] as number;
		});
		builder.lt = recorder(builder, 'lt', (args) => {
			if (args[0] === 'index') range.to = args[1] as number;
		});
		builder.then = (
			onFulfilled: (value: unknown) => unknown,
			onRejected?: (reason: unknown) => unknown
		) => {
			const rows = [];
			for (let index = Math.max(range.from, 0); index < Math.min(range.to, chunkCount); index++) {
				rows.push(chunkRow(index));
			}
			const result = options.chunksError
				? { data: null, error: options.chunksError }
				: { data: rows, error: null };
			return Promise.resolve(result).then(onFulfilled, onRejected);
		};
		return builder;
	}

	const client = {
		from: (table: string, ...rest: unknown[]) => {
			calls.push({ method: 'from', args: [table, ...rest] });
			if (table === 'chunks') {
				return chunksBuilder();
			}
			const results: Record<string, Result> = {
				books: options.book ?? { data: bookRow(chunkCount), error: null },
				chunk_progress: options.chunkProgress ?? { data: [], error: null },
				book_progress: options.bookProgress ?? { data: null, error: null },
				chapters: options.chapters ?? { data: [], error: null }
			};
			return staticBuilder(results[table] ?? { data: [], error: null });
		},
		rpc: (fn: string, args: unknown) => {
			calls.push({ method: 'rpc', args: [fn, args] });
			return Promise.resolve(options.rpc ?? { data: 0, error: null });
		}
	};

	const tablesQueried = () =>
		calls.filter((c) => c.method === 'from').map((c) => c.args[0] as string);
	const rpcCalls = () => calls.filter((c) => c.method === 'rpc');

	return { client, calls, tablesQueried, rpcCalls };
}

const USER = { id: '11111111-1111-1111-1111-111111111111' };
const BOOK_UUID = 'aaaaaaaa-0000-0000-0000-000000000001';
const SLUG = 'pride-and-prejudice';
const DEFAULT_CHUNK_COUNT = 5;

/** The metadata-only row `getBookSummaryBySlug` reads — no embedded chunks any more. */
function bookRow(chunkCount: number) {
	return {
		id: BOOK_UUID,
		slug: SLUG,
		title: 'Pride and Prejudice',
		author: 'Jane Austen',
		language: 'en',
		chunk_count: chunkCount,
		cover_url: null
	};
}

/** `chunk_progress` rows as the read service sees them, for the given chunk indices. */
function completedRows(indices: readonly number[]) {
	return indices.map((index) => ({ chunk_id: chunkId(index) }));
}

function loadEvent(
	options: MockOptions & {
		user?: { id: string } | null;
		slug?: string;
		passage?: string | null;
		/** The `typefy-mode` cookie's raw value; omitted means the cookie is absent. */
		modeCookie?: string;
	} = {}
) {
	const slug = options.slug ?? SLUG;
	const supabase = mockSupabase(options);

	// A real URL, so `url.searchParams` behaves exactly as SvelteKit hands it to the load
	// (including `?passage=` decoding to the empty string rather than null).
	const query = options.passage === undefined ? '' : `?passage=${options.passage}`;
	const url = new URL(`http://localhost/type/${slug}${query}`);

	const event = {
		params: { slug },
		url,
		// Only `get` is stubbed: the load READS the mode cookie and never writes one — the
		// toggle owns the write, client-side (spec #24 §10).
		cookies: {
			get: (name: string) => (name === 'typefy-mode' ? options.modeCookie : undefined)
		},
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

	it('issues no further query for an unknown slug — the 404 happens first', async () => {
		const { event, supabase } = loadEvent({ user: USER, book: { data: null, error: null } });

		await expect(load(event)).rejects.toMatchObject({ status: 404 });
		expect(supabase.tablesQueried()).toEqual(['books']);
		expect(supabase.rpcCalls()).toEqual([]);
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

	it('issues ZERO progress queries and never calls the resume RPC', async () => {
		const { event, supabase } = loadEvent({ user: null });

		await load(event);

		// Asserted positively against the recorded calls: an empty result is not proof.
		const tables = supabase.tablesQueried();
		// `chapters` joined the guest path in spec #45: it is world-readable through its parent
		// book's policy, so naming the chapter costs a guest a content read, never a progress one.
		expect(tables.sort()).toEqual(['books', 'chapters', 'chunks']);
		expect(tables).not.toContain('chunk_progress');
		expect(tables).not.toContain('book_progress');
		// The RPC is granted to `authenticated` only — a guest calling it gets an error, not 0.
		expect(supabase.rpcCalls()).toEqual([]);
	});

	it('still gets the first window of text', async () => {
		const { event } = loadEvent({ user: null });

		const data = await runLoad(event);

		expect(data.window.from).toBe(0);
		expect(data.window.chunks.map((chunk) => chunk.index)).toEqual(
			Array.from({ length: Math.min(WINDOW_SIZE, DEFAULT_CHUNK_COUNT) }, (_, i) => i)
		);
	});

	it('still honours ?passage=N for a guest', async () => {
		const { event, supabase } = loadEvent({ user: null, passage: '4' });

		const data = await runLoad(event);

		expect(data.startIndex).toBe(3);
		expect(data.window.from).toBe(3);
		expect(supabase.tablesQueried().sort()).toEqual(['books', 'chapters', 'chunks']);
	});

	it('returns the book as metadata only — the chunks live in the window', async () => {
		const { event } = loadEvent({ user: null });

		const data = await runLoad(event);

		expect(data.book.id).toBe(SLUG);
		expect(data.book.bookId).toBe(BOOK_UUID);
		expect(data.book.chunkCount).toBe(DEFAULT_CHUNK_COUNT);
		expect(data.book).not.toHaveProperty('chunks');
	});
});

describe('/type/[slug] load — resume for a signed-in user', () => {
	it('calls the resume function with the book uuid, never the slug', async () => {
		const { event, supabase } = loadEvent({ user: USER });

		await load(event);

		expect(supabase.rpcCalls()).toEqual([
			{ method: 'rpc', args: ['first_incomplete_chunk_index', { p_book_id: BOOK_UUID }] }
		]);
	});

	it('opens where the resume function says', async () => {
		const { event } = loadEvent({ user: USER, rpc: { data: 3, error: null } });

		const data = await runLoad(event);

		expect(data.startIndex).toBe(3);
	});

	it('opens a fully completed book at passage 1 — there is no "finished" state', async () => {
		const { event } = loadEvent({
			user: USER,
			rpc: { data: 0, error: null },
			chunkProgress: { data: completedRows([0, 1, 2, 3, 4]), error: null }
		});

		const data = await runLoad(event);

		expect(data.startIndex).toBe(0);
	});

	it('clamps a resume index that a shrunk book no longer holds', async () => {
		// `chunk_count` and the RPC are read in the same request but not the same statement;
		// a re-ingest between them must not open a session on a chunk that is gone.
		const { event } = loadEvent({ user: USER, chunkCount: 3, rpc: { data: 9, error: null } });

		const data = await runLoad(event);

		expect(data.startIndex).toBe(2);
	});

	it('reads both rollup tables exactly once, plus the window', async () => {
		const { event, supabase } = loadEvent({ user: USER });

		await load(event);

		expect(supabase.tablesQueried().slice(1).sort()).toEqual([
			'book_progress',
			'chapters',
			'chunk_progress',
			'chunks'
		]);
	});
});

describe('/type/[slug] load — the first window', () => {
	it('serves at most WINDOW_SIZE chunks however long the book is', async () => {
		const { event } = loadEvent({ user: USER, chunkCount: 500 });

		const data = await runLoad(event);

		expect(data.window.chunks).toHaveLength(WINDOW_SIZE);
		expect(data.window.chunks.at(-1)?.index).toBe(WINDOW_SIZE - 1);
	});

	it('echoes the book’s authoritative chunkCount, not the window length', async () => {
		const { event } = loadEvent({ user: USER, chunkCount: 500 });

		const data = await runLoad(event);

		expect(data.window.chunkCount).toBe(500);
	});

	it('opens AT the start index rather than at a grid-aligned origin', async () => {
		const { event } = loadEvent({ user: USER, chunkCount: 500, rpc: { data: 47, error: null } });

		const data = await runLoad(event);

		expect(data.window.from).toBe(47);
		expect(data.window.chunks.map((chunk) => chunk.index)).toEqual(
			Array.from({ length: WINDOW_SIZE }, (_, i) => 47 + i)
		);
	});

	it('loads the window containing N for a ?passage=N beyond the first window', async () => {
		const { event } = loadEvent({ user: USER, chunkCount: 500, passage: '120' });

		const data = await runLoad(event);

		expect(data.startIndex).toBe(119);
		expect(data.window.from).toBe(119);
		expect(data.window.chunks[0].index).toBe(119);
		expect(data.window.chunks).toHaveLength(WINDOW_SIZE);
	});

	it('serves a short tail without asking for chunks past the end', async () => {
		const { event } = loadEvent({ user: USER, chunkCount: 5, rpc: { data: 3, error: null } });

		const data = await runLoad(event);

		expect(data.window.chunks.map((chunk) => chunk.index)).toEqual([3, 4]);
	});

	it('serves an empty window when the book has no chunks at all', async () => {
		const { event } = loadEvent({ user: USER, chunkCount: 0 });

		const data = await runLoad(event);

		expect(data.startIndex).toBe(0);
		expect(data.window).toEqual({ from: 0, chunks: [], chunkCount: 0 });
	});
});

describe('/type/[slug] load — completedChunkIds', () => {
	it('contains only ids inside the window', async () => {
		const { event } = loadEvent({
			user: USER,
			chunkCount: 500,
			// 1 and 3 are in the first WINDOW_SIZE-chunk window; 42 and 300 are the same user's
			// progress elsewhere.
			chunkProgress: { data: completedRows([1, 3, 42, 300]), error: null }
		});

		const data = await runLoad(event);

		expect(data.completedChunkIds).toEqual([chunkId(1), chunkId(3)]);
	});

	it('is scoped to the window the session actually opened at', async () => {
		const { event } = loadEvent({
			user: USER,
			chunkCount: 500,
			passage: '101', // startIndex 100 → window 100..(100+WINDOW_SIZE)
			chunkProgress: {
				data: completedRows([0, 100, 100 + WINDOW_SIZE - 1, 100 + WINDOW_SIZE]),
				error: null
			}
		});

		const data = await runLoad(event);

		expect(data.completedChunkIds).toEqual([chunkId(100), chunkId(100 + WINDOW_SIZE - 1)]);
	});

	it('returns an array, not a Set, and survives a JSON round trip', async () => {
		const { event } = loadEvent({
			user: USER,
			chunkProgress: { data: completedRows([0, 2]), error: null }
		});

		const data = await runLoad(event);

		// A Set does not survive SvelteKit's load serialisation — it would arrive empty.
		expect(Array.isArray(data.completedChunkIds)).toBe(true);
		expect(JSON.parse(JSON.stringify(data)).completedChunkIds).toEqual([chunkId(0), chunkId(2)]);
	});
});

describe('/type/[slug] load — ?passage override', () => {
	it('lets ?passage=3 override a different computed index', async () => {
		const { event } = loadEvent({ user: USER, rpc: { data: 1, error: null }, passage: '3' });

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
		const { event } = loadEvent({ user: USER, rpc: { data: 1, error: null }, passage: value });

		const data = await runLoad(event);

		// No throw, no error status: a stale hand-edited link must still open the book.
		expect(data.startIndex).toBe(1);
		expect(data.book.id).toBe(SLUG);
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

/**
 * The mode cookie, read server-side (spec #24 §10). What matters here is that the value
 * reaches the payload at the FIRST paint — a client-only read would render a metrics row and
 * then visibly strip it on hydration — and that a guest and a signed-in user get the same
 * answer from the same cookie, with no profile column and no precedence rule.
 */
describe('/type/[slug] load — the mode cookie', () => {
	it('returns the cookie value', async () => {
		const { event } = loadEvent({ user: USER, modeCookie: 'zen' });

		expect((await runLoad(event)).mode).toBe('zen');
	});

	it('defaults to normal when there is no cookie — no cookie means no explicit choice', async () => {
		const { event } = loadEvent({ user: USER });

		expect((await runLoad(event)).mode).toBe('normal');
	});

	it('falls back to normal for an unrecognised value, silently', async () => {
		// The `?passage=N` spirit: a stale or hand-edited cookie must still open the book.
		const { event } = loadEvent({ user: USER, modeCookie: 'sprint' });

		expect((await runLoad(event)).mode).toBe('normal');
	});

	it('answers a guest identically, and still issues no progress query', async () => {
		const { event, supabase } = loadEvent({ user: null, modeCookie: 'zen' });

		const data = await runLoad(event);

		expect(data.mode).toBe('zen');
		expect(supabase.tablesQueried().sort()).toEqual(['books', 'chapters', 'chunks']);
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

	it('propagates a DB error from the window read', async () => {
		const { event } = loadEvent({ user: USER, chunksError: { message: 'read timeout' } });

		await expect(load(event)).rejects.toEqual({ message: 'read timeout' });
	});

	it('propagates an error from the resume RPC rather than silently starting at 0', async () => {
		const { event } = loadEvent({
			user: USER,
			rpc: { data: null, error: { message: 'permission denied for function' } }
		});

		await expect(load(event)).rejects.toEqual({ message: 'permission denied for function' });
	});
});

describe('/type/[slug] load — chapters and the header seed (spec #45)', () => {
	const chapters = {
		data: [
			{ index: 0, title: 'Chapter One', start_chunk_index: 0 },
			{ index: 1, title: 'Chapter Two', start_chunk_index: 3 }
		],
		error: null
	};

	it('returns the chapter list, index/title/start only', async () => {
		const { event } = loadEvent({ user: null, chapters });

		const data = await runLoad(event);

		expect(data.chapters).toEqual([
			{ index: 0, title: 'Chapter One', startChunkIndex: 0 },
			{ index: 1, title: 'Chapter Two', startChunkIndex: 3 }
		]);
	});

	it('seeds the header with the chapter the opening page falls in', async () => {
		const { event } = loadEvent({ user: null, chapters, passage: '4' }); // 0-based index 3

		const data = await runLoad(event);

		// Identity only since spec #50 — the page number, the percentage and the mode axis moved
		// into `TypingSession`'s own bottom row, which is server-rendered with `mode` from this
		// same load. An exact-shape assertion, so a field creeping back fails here.
		expect(data.typingHeader).toEqual({
			title: 'Pride and Prejudice',
			chapter: 'Chapter Two',
			slug: 'pride-and-prejudice'
		});
	});

	it('seeds no chapter for front matter, and none for a book with no chapters', async () => {
		const frontMatter = {
			data: [{ index: 0, title: 'Chapter One', start_chunk_index: 2 }],
			error: null
		};
		const { event } = loadEvent({ user: null, chapters: frontMatter });
		expect((await runLoad(event)).typingHeader.chapter).toBeNull();

		const { event: structureless } = loadEvent({ user: null });
		expect((await runLoad(structureless)).typingHeader.chapter).toBeNull();
	});

	/**
	 * The seed used to carry `pct` and `zen` so the header's figures and toggle painted correctly
	 * on the server. Spec #50 moved both under the page card, into a component this same load
	 * server-renders with `mode` — so the guarantee is kept by its owner rather than mirrored
	 * here. What the seed still owes the client is the link target.
	 */
	it('seeds the slug, so the header title can link back to the book', async () => {
		const { event } = loadEvent({ user: null, chapters });

		expect((await runLoad(event)).typingHeader.slug).toBe('pride-and-prejudice');
	});

	it('still hands the mode straight to the page, which is what renders the axis', async () => {
		const { event } = loadEvent({ user: null, modeCookie: 'zen' });
		expect((await runLoad(event)).mode).toBe('zen');

		const { event: normal } = loadEvent({ user: null });
		expect((await runLoad(normal)).mode).toBe('normal');
	});
});
