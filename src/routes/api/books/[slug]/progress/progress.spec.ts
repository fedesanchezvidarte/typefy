import { describe, expect, it } from 'vitest';
import { GET } from './+server';
import { MAX_WINDOW_LIMIT } from '$lib/reading/window';

/**
 * `GET /api/books/[slug]/progress` tests (spec #18 §4). The Supabase client is mocked — no
 * real database call reaches a unit test (testing-patterns).
 *
 * Two properties this file exists to pin, beyond the shapes:
 *
 * - **A guest issues no progress query.** Asserted positively against the recorded tables,
 *   because an empty `completedChunkIds` is not proof that nothing was read.
 * - **The response never leaves the window.** Completed ids for the rest of the book are the
 *   same user's data, but they are not this window's answer and would grow without bound.
 */

const SLUG = 'pride-and-prejudice';
const BOOK_UUID = 'aaaaaaaa-0000-0000-0000-000000000001';
const USER = { id: '11111111-1111-1111-1111-111111111111' };
const DEFAULT_CHUNK_COUNT = 25;

function chunkId(index: number): string {
	return `cccccccc-0000-0000-0000-${String(index).padStart(12, '0')}`;
}

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

interface MockOptions {
	/** `null` data models BOTH an unknown slug and an unpublished book: RLS hides them alike. */
	book?: { data: unknown; error: unknown };
	chunkCount?: number;
	/** Chunk indices this user has completed, anywhere in the book. */
	completed?: readonly number[];
	/** A failure on the per-user progress read specifically. */
	progressError?: unknown;
}

function mockSupabase(options: MockOptions) {
	const tables: string[] = [];
	const chunkCount = options.chunkCount ?? DEFAULT_CHUNK_COUNT;

	function booksBuilder() {
		const builder: Record<string, unknown> = {};
		for (const method of ['select', 'eq', 'order', 'limit']) {
			builder[method] = () => builder;
		}
		builder.maybeSingle = () =>
			Promise.resolve(options.book ?? { data: bookRow(chunkCount), error: null });
		return builder;
	}

	function chunksBuilder() {
		const range = { from: 0, to: chunkCount };
		const builder: Record<string, unknown> = {};
		for (const method of ['select', 'eq', 'order', 'limit']) {
			builder[method] = () => builder;
		}
		builder.gte = (column: string, value: number) => {
			if (column === 'index') range.from = value;
			return builder;
		};
		builder.lt = (column: string, value: number) => {
			if (column === 'index') range.to = value;
			return builder;
		};
		builder.then = (
			onFulfilled: (value: unknown) => unknown,
			onRejected?: (reason: unknown) => unknown
		) => {
			const rows = [];
			for (let index = Math.max(range.from, 0); index < Math.min(range.to, chunkCount); index++) {
				rows.push({ id: chunkId(index), index, content: `Passage ${index + 1}.`, char_count: 11 });
			}
			return Promise.resolve({ data: rows, error: null }).then(onFulfilled, onRejected);
		};
		return builder;
	}

	function progressBuilder() {
		const builder: Record<string, unknown> = {};
		for (const method of ['select', 'eq', 'not', 'order', 'limit']) {
			builder[method] = () => builder;
		}
		builder.then = (
			onFulfilled: (value: unknown) => unknown,
			onRejected?: (reason: unknown) => unknown
		) =>
			Promise.resolve(
				options.progressError
					? { data: null, error: options.progressError }
					: {
							data: (options.completed ?? []).map((index) => ({ chunk_id: chunkId(index) })),
							error: null
						}
			).then(onFulfilled, onRejected);
		return builder;
	}

	const client = {
		from: (table: string) => {
			tables.push(table);
			if (table === 'chunks') return chunksBuilder();
			if (table === 'chunk_progress') return progressBuilder();
			return booksBuilder();
		}
	};

	return { client, tables };
}

function requestEvent(
	options: MockOptions & {
		slug?: string;
		query?: string;
		user?: { id: string } | null;
	} = {}
) {
	const slug = options.slug ?? SLUG;
	const query = options.query ?? '?from=0&limit=10';
	const supabase = mockSupabase(options);

	const event = {
		params: { slug },
		url: new URL(`http://localhost/api/books/${slug}/progress${query}`),
		locals: {
			supabase: supabase.client,
			safeGetSession: async () => ({
				session: options.user ? { user: options.user } : null,
				user: options.user ?? null
			})
		}
	};
	// Only the fields the handler touches are stubbed; the cast keeps the test honest about
	// the handler's own event type rather than widening to a hand-built RequestEvent.
	return { event: event as unknown as Parameters<typeof GET>[0], supabase };
}

async function body(response: Response) {
	return (await response.json()) as { from: number; limit: number; completedChunkIds: string[] };
}

describe('GET /api/books/[slug]/progress — a guest', () => {
	it('answers 200 with an empty list', async () => {
		const { event } = requestEvent({ user: null });

		const response = await GET(event);

		expect(response.status).toBe(200);
		expect(await body(response)).toEqual({ from: 0, limit: 10, completedChunkIds: [] });
	});

	it('issues no progress query — asserted against the recorded reads', async () => {
		const { event, supabase } = requestEvent({ user: null, completed: [0, 1] });

		await GET(event);

		expect(supabase.tables).toEqual(['books']);
		expect(supabase.tables).not.toContain('chunk_progress');
	});
});

describe('GET /api/books/[slug]/progress — a signed-in user', () => {
	it('returns the completed ids inside the window, in index order', async () => {
		const { event } = requestEvent({ user: USER, query: '?from=0&limit=5', completed: [3, 1] });

		expect((await body(await GET(event))).completedChunkIds).toEqual([chunkId(1), chunkId(3)]);
	});

	it('never returns an id outside the window', async () => {
		const { event } = requestEvent({
			user: USER,
			query: '?from=10&limit=5',
			completed: [0, 9, 10, 14, 15, 24]
		});

		expect((await body(await GET(event))).completedChunkIds).toEqual([chunkId(10), chunkId(14)]);
	});

	it('returns an empty list when nothing in the window is complete', async () => {
		const { event } = requestEvent({ user: USER, query: '?from=0&limit=5', completed: [20] });

		expect((await body(await GET(event))).completedChunkIds).toEqual([]);
	});

	it('echoes the CLAMPED range, so the client can tell what it was answered about', async () => {
		const { event } = requestEvent({ user: USER, query: '?from=0&limit=500' });

		const payload = await body(await GET(event));

		expect(payload).toMatchObject({ from: 0, limit: MAX_WINDOW_LIMIT });
	});

	it('answers 200 with an empty list, and no query, when from is past the end', async () => {
		const { event, supabase } = requestEvent({
			user: USER,
			query: '?from=99&limit=10',
			completed: [0, 1]
		});

		const response = await GET(event);

		expect(response.status).toBe(200);
		expect(await body(response)).toEqual({ from: 99, limit: 0, completedChunkIds: [] });
		expect(supabase.tables).toEqual(['books']);
	});
});

describe('GET /api/books/[slug]/progress — unknown and unpublished books', () => {
	it('answers 404 when no book has that slug', async () => {
		const { event } = requestEvent({ user: USER, book: { data: null, error: null } });

		expect((await GET(event)).status).toBe(404);
	});

	it('answers an unpublished book identically to an unknown slug, for a guest too', async () => {
		// A caller must not be able to learn a book exists by asking the progress route what
		// it cannot ask the chunks route.
		const unknown = await GET(
			requestEvent({ user: null, book: { data: null, error: null } }).event
		);
		const unpublished = await GET(
			requestEvent({ user: USER, slug: 'not-yet-published', book: { data: null, error: null } })
				.event
		);

		expect(unpublished.status).toBe(unknown.status);
		expect(await unpublished.json()).toEqual(await unknown.json());
	});
});

describe('GET /api/books/[slug]/progress — parameter validation', () => {
	// The same matrix the chunks endpoint enforces: both must reject identically.
	const INVALID = [
		['a missing from', '?limit=10'],
		['a missing limit', '?from=0'],
		['both missing', ''],
		['an empty limit', '?from=0&limit='],
		['a negative from', '?from=-1&limit=10'],
		['a zero limit', '?from=0&limit=0'],
		['a non-numeric from', '?from=abc&limit=10'],
		['a fractional limit', '?from=0&limit=2.0'],
		['a hexadecimal from', '?from=0x2&limit=10']
	] as const;

	it.each(INVALID)('answers 400 for %s', async (_, query) => {
		const { event } = requestEvent({ user: USER, query });

		expect((await GET(event)).status).toBe(400);
	});

	it('never reads the database for a malformed range', async () => {
		const { event, supabase } = requestEvent({ user: USER, query: '?from=abc&limit=10' });

		await GET(event);

		expect(supabase.tables).toEqual([]);
	});
});

describe('GET /api/books/[slug]/progress — caching', () => {
	it('is private and unstorable for a signed-in user', async () => {
		const { event } = requestEvent({ user: USER });

		const response = await GET(event);

		expect(response.headers.get('cache-control')).toBe('private, no-store');
	});

	it('is private and unstorable for a guest too', async () => {
		const { event } = requestEvent({ user: null });

		expect((await GET(event)).headers.get('cache-control')).toBe('private, no-store');
	});

	it('carries no ETag — no-store forbids storage, so there is nothing to revalidate', async () => {
		const { event } = requestEvent({ user: USER });

		expect((await GET(event)).headers.get('etag')).toBeNull();
	});

	it('never stores a 400 or a 404 either', async () => {
		const bad = await GET(requestEvent({ user: USER, query: '?from=abc&limit=1' }).event);
		const missing = await GET(
			requestEvent({ user: USER, book: { data: null, error: null } }).event
		);

		expect(bad.headers.get('cache-control')).toBe('no-store');
		expect(missing.headers.get('cache-control')).toBe('no-store');
	});
});

/**
 * The error path. A failure here is cosmetic to the CLIENT — `TypingSession` swallows a bad
 * response and some completion markers stay missing until the next load — but that is the
 * client's decision to make, and it can only make it if the endpoint tells the truth. An
 * error answered as `completedChunkIds: []` would be indistinguishable from "you have
 * completed nothing here", which is a different and wrong statement.
 */
describe('GET /api/books/[slug]/progress — a failing database', () => {
	it('propagates a failure reading the book instead of answering 404', async () => {
		const { event } = requestEvent({
			user: USER,
			book: { data: null, error: { message: 'connection terminated' } }
		});

		await expect(GET(event)).rejects.toMatchObject({ message: 'connection terminated' });
	});

	it('propagates a failure reading progress instead of reporting nothing completed', async () => {
		const { event } = requestEvent({
			user: USER,
			completed: [0, 1],
			progressError: { message: 'statement timeout' }
		});

		await expect(GET(event)).rejects.toMatchObject({ message: 'statement timeout' });
	});

	it('never reaches the progress read for a guest, however broken it is', async () => {
		// The guest gate sits above both reads, so a database failing on `chunk_progress`
		// cannot turn a guest's 200 into a 500.
		const { event, supabase } = requestEvent({
			user: null,
			progressError: { message: 'statement timeout' }
		});

		const response = await GET(event);

		expect(response.status).toBe(200);
		expect(await body(response)).toEqual({ from: 0, limit: 10, completedChunkIds: [] });
		expect(supabase.tables).not.toContain('chunk_progress');
	});
});
