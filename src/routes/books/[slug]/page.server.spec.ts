import { describe, expect, it, vi } from 'vitest';

/**
 * `/books/[slug]` load tests (spec #34). The injected Supabase client is mocked — a real DB
 * call must never reach a unit test (testing-patterns) — and it is keyed on the `from(...)`
 * table with a FRESH builder per call, because the two progress reads share a `Promise.all`
 * and neither may see the other's recorded state. Both points are lifted straight from
 * `src/routes/type/[slug]/page.server.spec.ts`, whose posture this mirrors.
 *
 * `getLocale` is mocked rather than driven through a real Paraglide URL: the locale is the
 * axis the per-locale summary resolves on, and the test must be able to state it outright
 * instead of depending on whatever ambient locale the generated runtime happens to hold.
 * `$lib/paraglide/*` is a build artifact, so a test that leans on its state is testing the
 * artifact.
 *
 * What is deliberately NOT re-tested here: the attribution arithmetic (page ranges, unsorted
 * bucketing, the empty-chapter case) belongs to `src/lib/library/chapter-progress.spec.ts`,
 * and the malformed-jsonb matrix to `src/lib/library/summary.spec.ts`. What this file proves
 * is that the ROUTE wires them to the right inputs and issues the right queries.
 */

const { getLocale } = vi.hoisted(() => ({ getLocale: vi.fn(() => 'en') }));
vi.mock('$lib/paraglide/runtime', () => ({ getLocale }));

// `vi.mock` is hoisted above this import, so the load sees the stubbed runtime.
import { load, type BookDetailPageData } from './+page.server';

interface QueryCall {
	method: string;
	args: unknown[];
}

type Result = { data: unknown; error: unknown };

const USER = { id: '11111111-1111-1111-1111-111111111111' };
const BOOK_UUID = 'aaaaaaaa-0000-0000-0000-000000000001';
const SLUG = 'don-quijote';
const DEFAULT_CHUNK_COUNT = 10;

/** The two chapters most cases use: [0,4) and [4,chunkCount). */
const CHAPTERS = [
	{ index: 0, title: 'Chapter I', start_chunk_index: 0 },
	{ index: 1, title: 'Chapter II', start_chunk_index: 4 }
];

interface BookRowOptions {
	chunkCount?: number;
	year?: number | null;
	summary?: unknown;
	chapters?: { index: number; title: string; start_chunk_index: number }[];
}

function bookRow(options: BookRowOptions = {}) {
	return {
		id: BOOK_UUID,
		slug: SLUG,
		title: 'Don Quijote de la Mancha',
		author: 'Miguel de Cervantes',
		language: 'es',
		chunk_count: options.chunkCount ?? DEFAULT_CHUNK_COUNT,
		cover_url: null,
		year: options.year === undefined ? 1605 : options.year,
		summary: options.summary ?? {},
		chapters: options.chapters ?? CHAPTERS
	};
}

interface MockOptions extends BookRowOptions {
	book?: Result;
	/** Chunk indices the user has completed, in whatever order the service would see them. */
	completed?: readonly number[];
	completedError?: unknown;
	bookProgress?: Result;
}

function mockSupabase(options: MockOptions) {
	const calls: QueryCall[] = [];

	function recorder(builder: Record<string, unknown>, method: string) {
		return (...args: unknown[]) => {
			calls.push({ method, args });
			return builder;
		};
	}

	/** Answers the configured `{ data, error }` however it is filtered. */
	function staticBuilder(result: Result) {
		const builder: Record<string, unknown> = {};
		for (const method of ['select', 'eq', 'not', 'order', 'limit', 'range']) {
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

	/**
	 * Honours the `.range(from, to)` the service paginates with, so the read terminates on a
	 * short page exactly as it does against PostgREST. A builder that ignored the range would
	 * loop forever the moment a case configured a full page of completions.
	 */
	function chunkProgressBuilder() {
		const completed = options.completed ?? [];
		const range = { from: 0, to: completed.length };
		const builder: Record<string, unknown> = {};
		for (const method of ['select', 'eq', 'not', 'order', 'limit']) {
			builder[method] = recorder(builder, method);
		}
		builder.range = (...args: unknown[]) => {
			calls.push({ method: 'range', args });
			range.from = args[0] as number;
			range.to = args[1] as number;
			return builder;
		};
		builder.then = (
			onFulfilled: (value: unknown) => unknown,
			onRejected?: (reason: unknown) => unknown
		) => {
			const rows = completed
				.slice(range.from, range.to + 1)
				.map((index) => ({ chunks: { index } }));
			const result = options.completedError
				? { data: null, error: options.completedError }
				: { data: rows, error: null };
			return Promise.resolve(result).then(onFulfilled, onRejected);
		};
		return builder;
	}

	const client = {
		from: (table: string, ...rest: unknown[]) => {
			calls.push({ method: 'from', args: [table, ...rest] });
			if (table === 'chunk_progress') {
				return chunkProgressBuilder();
			}
			const results: Record<string, Result> = {
				books: options.book ?? { data: bookRow(options), error: null },
				book_progress: options.bookProgress ?? { data: null, error: null }
			};
			return staticBuilder(results[table] ?? { data: [], error: null });
		},
		rpc: (fn: string, args: unknown) => {
			calls.push({ method: 'rpc', args: [fn, args] });
			return Promise.resolve({ data: null, error: null });
		}
	};

	const tablesQueried = () =>
		calls.filter((c) => c.method === 'from').map((c) => c.args[0] as string);
	const rpcCalls = () => calls.filter((c) => c.method === 'rpc');
	const selects = () => calls.filter((c) => c.method === 'select').map((c) => c.args[0] as string);

	return { client, calls, tablesQueried, rpcCalls, selects };
}

function loadEvent(
	options: MockOptions & { user?: { id: string } | null; slug?: string; locale?: 'en' | 'es' } = {}
) {
	const slug = options.slug ?? SLUG;
	getLocale.mockReturnValue(options.locale ?? 'en');
	const supabase = mockSupabase(options);

	const event = {
		params: { slug },
		url: new URL(`http://localhost/books/${slug}`),
		locals: {
			supabase: supabase.client,
			safeGetSession: async () => ({
				session: options.user ? { user: options.user } : null,
				user: options.user ?? null
			})
		}
	};
	// Only the fields the load touches are stubbed; the cast keeps the test honest about the
	// load's own event type rather than widening to a hand-built ServerLoadEvent.
	return { event: event as unknown as Parameters<typeof load>[0], supabase };
}

/**
 * `PageServerLoad` is declared as returning `data | void`, so awaiting it yields a union
 * TypeScript will not let the assertions index into. This load always returns data — it
 * either throws (404, DB error) or returns the object — so the narrowing happens once here.
 */
async function runLoad(event: Parameters<typeof load>[0]): Promise<BookDetailPageData> {
	return await load(event);
}

describe('/books/[slug] load — unknown or unpublished slug', () => {
	it('throws a 404 when the detail read finds nothing', async () => {
		const { event } = loadEvent({ user: USER, book: { data: null, error: null } });

		await expect(load(event)).rejects.toMatchObject({ status: 404 });
	});

	it('issues no further query — the 404 happens before the session is even read', async () => {
		// An unpublished book is invisible to RLS, so it arrives here as exactly the same
		// `null` an unknown slug does. Collapsing the two is the requirement.
		const { event, supabase } = loadEvent({ user: USER, book: { data: null, error: null } });

		await expect(load(event)).rejects.toMatchObject({ status: 404 });
		expect(supabase.tablesQueried()).toEqual(['books']);
	});
});

describe('/books/[slug] load — the detail read', () => {
	it('reads the book once, with its chapters embedded', async () => {
		const { event, supabase } = loadEvent({ user: null });

		const data = await runLoad(event);

		expect(supabase.tablesQueried()).toEqual(['books']);
		expect(supabase.selects()[0]).toContain('chapters(');
		expect(data.book.id).toBe(SLUG);
		expect(data.book.bookId).toBe(BOOK_UUID);
		expect(data.book.year).toBe(1605);
	});

	it('carries OUR page count, from books.chunk_count', async () => {
		const { event } = loadEvent({ user: null, chunkCount: 2410 });

		expect((await runLoad(event)).book.chunkCount).toBe(2410);
	});

	it('propagates a DB error from the detail read rather than 404ing', async () => {
		const { event } = loadEvent({
			user: USER,
			book: { data: null, error: { message: 'connection refused' } }
		});

		await expect(load(event)).rejects.toEqual({ message: 'connection refused' });
	});
});

describe('/books/[slug] load — the summary, resolved server-side', () => {
	it('resolves the current locale’s override', async () => {
		const { event } = loadEvent({
			user: null,
			locale: 'es',
			summary: { default: 'An English blurb.', es: 'Una reseña en español.' }
		});

		expect((await runLoad(event)).summary).toBe('Una reseña en español.');
	});

	it('serves the same book’s default blurb under the other locale', async () => {
		// The axis is the UI locale, not the book's content language: the same Spanish book
		// shows the unverified-language default under EN.
		const { event } = loadEvent({
			user: null,
			locale: 'en',
			summary: { default: 'An English blurb.', es: 'Una reseña en español.' }
		});

		expect((await runLoad(event)).summary).toBe('An English blurb.');
	});

	it('is null for a book with no summary at all — the panel is omitted, not emptied', async () => {
		const { event } = loadEvent({ user: null, summary: {} });

		expect((await runLoad(event)).summary).toBeNull();
	});

	it('is null rather than a 500 for a malformed summary column', async () => {
		const { event } = loadEvent({ user: null, summary: 'not an object' });

		expect((await runLoad(event)).summary).toBeNull();
	});
});

describe('/books/[slug] load — guest', () => {
	it('issues ZERO progress queries', async () => {
		const { event, supabase } = loadEvent({ user: null });

		await load(event);

		// Asserted positively against the recorded calls: an empty result is not proof.
		const tables = supabase.tablesQueried();
		expect(tables).toEqual(['books']);
		expect(tables).not.toContain('chunk_progress');
		expect(tables).not.toContain('book_progress');
		expect(supabase.rpcCalls()).toEqual([]);
	});

	it('still gets every chapter with its real page range, at zero completions', async () => {
		const { event } = loadEvent({ user: null });

		const data = await runLoad(event);

		expect(data.chapters).toEqual([
			expect.objectContaining({ title: 'Chapter I', firstPage: 1, lastPage: 4, pageCount: 4 }),
			expect.objectContaining({ title: 'Chapter II', firstPage: 5, lastPage: 10, pageCount: 6 })
		]);
		expect(data.chapters.map((chapter) => chapter.pagesCompleted)).toEqual([0, 0]);
		expect(data.chunksCompleted).toBe(0);
	});
});

describe('/books/[slug] load — signed in', () => {
	it('reads both progress sources exactly once, beside the book', async () => {
		const { event, supabase } = loadEvent({ user: USER });

		await load(event);

		expect(supabase.tablesQueried().slice(1).sort()).toEqual(['book_progress', 'chunk_progress']);
	});

	it('folds completed indices into their chapters', async () => {
		const { event } = loadEvent({ user: USER, completed: [0, 1, 5] });

		const data = await runLoad(event);

		expect(data.chapters.map((chapter) => chapter.pagesCompleted)).toEqual([2, 1]);
	});

	it('folds indices that arrive UNSORTED — the service orders by chunk_id, not by index', async () => {
		const { event } = loadEvent({ user: USER, completed: [7, 1, 9, 0, 4] });

		const data = await runLoad(event);

		expect(data.chapters.map((chapter) => chapter.pagesCompleted)).toEqual([2, 3]);
	});

	it('reports the rollup count as chunksCompleted, not the folded total', async () => {
		// The overall bar's numerator comes from `book_progress`, which is the authority; the
		// indices exist only to attribute pages to chapters.
		const { event } = loadEvent({
			user: USER,
			completed: [0, 1],
			bookProgress: { data: { chunks_completed: 2 }, error: null }
		});

		expect((await runLoad(event)).chunksCompleted).toBe(2);
	});

	it('is 0 when the user has no book_progress row yet', async () => {
		const { event } = loadEvent({ user: USER, bookProgress: { data: null, error: null } });

		expect((await runLoad(event)).chunksCompleted).toBe(0);
	});

	it('propagates a DB error from the completed-index read', async () => {
		const { event } = loadEvent({ user: USER, completedError: { message: 'timeout' } });

		await expect(load(event)).rejects.toEqual({ message: 'timeout' });
	});

	it('propagates a DB error from the book_progress read', async () => {
		const { event } = loadEvent({
			user: USER,
			bookProgress: { data: null, error: { message: 'connection refused' } }
		});

		await expect(load(event)).rejects.toEqual({ message: 'connection refused' });
	});
});

describe('/books/[slug] load — a book with no chapter structure', () => {
	it('returns an empty chapter list rather than a synthetic one', async () => {
		// The legal spec #33 "no structure" state: ingestion found no headings. The screen
		// renders no chapter list at all, so the load must not invent one.
		const { event } = loadEvent({ user: USER, chapters: [], completed: [0, 1] });

		const data = await runLoad(event);

		expect(data.chapters).toEqual([]);
		// Progress still exists for the book as a whole — only its attribution is unavailable.
		expect(data.book.chapters).toEqual([]);
	});
});
