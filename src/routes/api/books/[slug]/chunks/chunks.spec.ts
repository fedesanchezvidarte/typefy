import { describe, expect, it, vi } from 'vitest';
import { GET } from './+server';
import { MAX_WINDOW_LIMIT } from '$lib/reading/window';

/**
 * `GET /api/books/[slug]/chunks` tests (spec #18 §4). The Supabase client is mocked — no
 * real database call reaches a unit test (testing-patterns).
 *
 * The `chunks` stub honours the `gte`/`lt` bounds the service applies, out of a synthetic
 * book of `chunkCount` chunks, so a clamp assertion here means the handler asked for the
 * right range rather than that the stub happened to hold that many rows.
 *
 * `safeGetSession` is stubbed as a spy that is asserted **never called**: consulting the
 * session on a `public, s-maxage` response is the cache-poisoning shape this endpoint's
 * design exists to rule out.
 */

const CACHE_CONTROL = 'public, max-age=0, s-maxage=300, stale-while-revalidate=86400';
const SLUG = 'pride-and-prejudice';
const BOOK_UUID = 'aaaaaaaa-0000-0000-0000-000000000001';
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
	/** Overrides a chunk's text, to prove the ETag tracks content. */
	contentFor?: (index: number) => string;
	/** A failure on the CHUNK read specifically — the book was found, its text was not. */
	chunksError?: unknown;
}

function mockSupabase(options: MockOptions) {
	const tables: string[] = [];
	const chunkCount = options.chunkCount ?? DEFAULT_CHUNK_COUNT;
	const content = options.contentFor ?? ((index: number) => `Passage ${index + 1}.`);

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
			if (options.chunksError) {
				return Promise.resolve({ data: null, error: options.chunksError }).then(
					onFulfilled,
					onRejected
				);
			}
			const rows = [];
			for (let index = Math.max(range.from, 0); index < Math.min(range.to, chunkCount); index++) {
				rows.push({ id: chunkId(index), index, content: content(index), char_count: 11 });
			}
			return Promise.resolve({ data: rows, error: null }).then(onFulfilled, onRejected);
		};
		return builder;
	}

	const client = {
		from: (table: string) => {
			tables.push(table);
			return table === 'chunks' ? chunksBuilder() : booksBuilder();
		}
	};

	return { client, tables };
}

function requestEvent(
	options: MockOptions & { slug?: string; query?: string; headers?: Record<string, string> } = {}
) {
	const slug = options.slug ?? SLUG;
	const query = options.query ?? '?from=0&limit=10';
	const supabase = mockSupabase(options);
	const safeGetSession = vi.fn(async () => ({ session: null, user: null }));

	const event = {
		params: { slug },
		url: new URL(`http://localhost/api/books/${slug}/chunks${query}`),
		request: new Request(`http://localhost/api/books/${slug}/chunks${query}`, {
			headers: options.headers ?? {}
		}),
		locals: { supabase: supabase.client, safeGetSession }
	};
	// Only the fields the handler touches are stubbed; the cast keeps the test honest about
	// the handler's own event type rather than widening to a hand-built RequestEvent.
	return { event: event as unknown as Parameters<typeof GET>[0], supabase, safeGetSession };
}

async function body(response: Response) {
	return (await response.json()) as {
		from: number;
		chunks: { id: string; index: number }[];
		chunkCount: number;
	};
}

describe('GET /api/books/[slug]/chunks — the range', () => {
	it('serves exactly the requested window of a published book', async () => {
		const { event } = requestEvent({ query: '?from=5&limit=4' });

		const response = await GET(event);

		expect(response.status).toBe(200);
		const payload = await body(response);
		expect(payload.from).toBe(5);
		expect(payload.chunks.map((chunk) => chunk.index)).toEqual([5, 6, 7, 8]);
	});

	it('echoes the book’s authoritative chunkCount, not the window length', async () => {
		const { event } = requestEvent({ query: '?from=0&limit=3', chunkCount: 900 });

		const payload = await body(await GET(event));

		expect(payload.chunkCount).toBe(900);
		expect(payload.chunks).toHaveLength(3);
	});

	it('clamps a limit above the maximum instead of honouring it', async () => {
		// The clamp is what stops this endpoint being a whole-book download.
		const { event } = requestEvent({ query: '?from=0&limit=500', chunkCount: 900 });

		const response = await GET(event);

		expect(response.status).toBe(200);
		expect((await body(response)).chunks).toHaveLength(MAX_WINDOW_LIMIT);
	});

	it('serves a short tail without reaching past the end of the book', async () => {
		const { event } = requestEvent({ query: '?from=23&limit=10' });

		const payload = await body(await GET(event));

		expect(payload.chunks.map((chunk) => chunk.index)).toEqual([23, 24]);
	});

	it('answers 200 with an empty list when from is past the end', async () => {
		// The book exists; that range of it does not. Not a 404.
		const { event } = requestEvent({ query: '?from=99&limit=10' });

		const response = await GET(event);

		expect(response.status).toBe(200);
		expect(await body(response)).toEqual({ from: 99, chunks: [], chunkCount: DEFAULT_CHUNK_COUNT });
	});

	it('issues no chunk query at all for an empty window', async () => {
		const { event, supabase } = requestEvent({ query: '?from=99&limit=10' });

		await GET(event);

		expect(supabase.tables).toEqual(['books']);
	});
});

describe('GET /api/books/[slug]/chunks — no session', () => {
	it('never consults the session', async () => {
		const { event, safeGetSession } = requestEvent();

		await GET(event);

		expect(safeGetSession).not.toHaveBeenCalled();
	});

	it('sets no Set-Cookie and no Vary on the cacheable response', async () => {
		const { event } = requestEvent();

		const response = await GET(event);

		expect(response.headers.get('set-cookie')).toBeNull();
		expect(response.headers.get('vary')).toBeNull();
	});
});

describe('GET /api/books/[slug]/chunks — unknown and unpublished books', () => {
	it('answers 404 when no book has that slug', async () => {
		const { event } = requestEvent({ book: { data: null, error: null } });

		const response = await GET(event);

		expect(response.status).toBe(404);
	});

	it('answers an unpublished book identically to an unknown slug', async () => {
		// RLS hides an unpublished book from `anon` and `authenticated` alike, so the service
		// sees the same empty result for both — the handler cannot tell them apart, by design.
		const unknown = await GET(requestEvent({ book: { data: null, error: null } }).event);
		const unpublished = await GET(
			requestEvent({ slug: 'not-yet-published', book: { data: null, error: null } }).event
		);

		expect(unpublished.status).toBe(unknown.status);
		expect(await unpublished.json()).toEqual(await unknown.json());
	});

	it('never stores a 404 — publishing the book must not be shadowed by a cached miss', async () => {
		const { event } = requestEvent({ book: { data: null, error: null } });

		const response = await GET(event);

		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(response.headers.get('etag')).toBeNull();
	});
});

describe('GET /api/books/[slug]/chunks — parameter validation', () => {
	// A machine caller, unlike `?passage=N`: a malformed range is rejected, never coerced.
	const INVALID = [
		['a missing from', '?limit=10'],
		['a missing limit', '?from=0'],
		['both missing', ''],
		['an empty from', '?from=&limit=10'],
		['an empty limit', '?from=0&limit='],
		['a negative from', '?from=-1&limit=10'],
		['a negative limit', '?from=0&limit=-5'],
		['a zero limit', '?from=0&limit=0'],
		['a non-numeric from', '?from=abc&limit=10'],
		['a non-numeric limit', '?from=0&limit=ten'],
		['a fractional from', '?from=2.0&limit=10'],
		['an exponent limit', '?from=0&limit=1e2'],
		['a hexadecimal from', '?from=0x2&limit=10'],
		['a signed limit', '?from=0&limit=%2B2'],
		['a whitespace-padded from', '?from=%203%20&limit=10']
	] as const;

	it.each(INVALID)('answers 400 for %s', async (_, query) => {
		const { event } = requestEvent({ query });

		const response = await GET(event);

		expect(response.status).toBe(400);
	});

	it('never reads the database for a malformed range', async () => {
		const { event, supabase } = requestEvent({ query: '?from=abc&limit=10' });

		await GET(event);

		expect(supabase.tables).toEqual([]);
	});

	it('never stores a 400', async () => {
		const { event } = requestEvent({ query: '?from=abc&limit=10' });

		const response = await GET(event);

		expect(response.headers.get('cache-control')).toBe('no-store');
	});
});

describe('GET /api/books/[slug]/chunks — caching', () => {
	it('sets the shared-cache headers exactly', async () => {
		const { event } = requestEvent();

		const response = await GET(event);

		expect(response.headers.get('cache-control')).toBe(CACHE_CONTROL);
	});

	it('returns a strong ETag', async () => {
		const { event } = requestEvent();

		const etag = (await GET(event)).headers.get('etag');

		expect(etag).toMatch(/^"[^"]+"$/);
		expect(etag?.startsWith('W/')).toBe(false);
	});

	it('returns the same ETag for the same range twice — it is a content hash', async () => {
		const first = await GET(requestEvent({ query: '?from=0&limit=5' }).event);
		const second = await GET(requestEvent({ query: '?from=0&limit=5' }).event);

		expect(second.headers.get('etag')).toBe(first.headers.get('etag'));
	});

	it('changes the ETag when a re-ingest corrects the text', async () => {
		const before = await GET(requestEvent({ query: '?from=0&limit=5' }).event);
		const after = await GET(
			requestEvent({
				query: '?from=0&limit=5',
				contentFor: (index) => (index === 2 ? 'Corrected passage.' : `Passage ${index + 1}.`)
			}).event
		);

		expect(after.headers.get('etag')).not.toBe(before.headers.get('etag'));
	});

	it('gives different ranges different ETags', async () => {
		const first = await GET(requestEvent({ query: '?from=0&limit=5' }).event);
		const second = await GET(requestEvent({ query: '?from=5&limit=5' }).event);

		expect(second.headers.get('etag')).not.toBe(first.headers.get('etag'));
	});
});

describe('GET /api/books/[slug]/chunks — conditional requests', () => {
	async function etagFor(query: string): Promise<string> {
		const etag = (await GET(requestEvent({ query }).event)).headers.get('etag');
		return etag as string;
	}

	it('answers 304 with no body when the ETag still matches', async () => {
		const etag = await etagFor('?from=0&limit=5');
		const { event } = requestEvent({
			query: '?from=0&limit=5',
			headers: { 'if-none-match': etag }
		});

		const response = await GET(event);

		expect(response.status).toBe(304);
		expect(await response.text()).toBe('');
	});

	it('repeats the validator and the cache headers on the 304', async () => {
		const etag = await etagFor('?from=0&limit=5');
		const { event } = requestEvent({
			query: '?from=0&limit=5',
			headers: { 'if-none-match': etag }
		});

		const response = await GET(event);

		expect(response.headers.get('etag')).toBe(etag);
		expect(response.headers.get('cache-control')).toBe(CACHE_CONTROL);
	});

	it('answers 200 when the client holds a stale validator', async () => {
		const { event } = requestEvent({
			query: '?from=0&limit=5',
			headers: { 'if-none-match': '"stale-validator"' }
		});

		const response = await GET(event);

		expect(response.status).toBe(200);
	});

	it('accepts a weakened validator — revalidation uses the weak comparison', async () => {
		const etag = await etagFor('?from=0&limit=5');
		const { event } = requestEvent({
			query: '?from=0&limit=5',
			headers: { 'if-none-match': `W/${etag}` }
		});

		expect((await GET(event)).status).toBe(304);
	});

	it('accepts a list of candidate validators', async () => {
		const etag = await etagFor('?from=0&limit=5');
		const { event } = requestEvent({
			query: '?from=0&limit=5',
			headers: { 'if-none-match': `"other", ${etag}` }
		});

		expect((await GET(event)).status).toBe(304);
	});

	it('treats * as a match', async () => {
		const { event } = requestEvent({ query: '?from=0&limit=5', headers: { 'if-none-match': '*' } });

		expect((await GET(event)).status).toBe(304);
	});
});

/**
 * The error path. Neither read is wrapped in a `try`, and that is deliberate: a database
 * that is failing is not a book that is missing, and answering 404 would tell a CDN to
 * remember it. Pinned because the difference is invisible until it happens — a swallowed
 * error here caches "no such book" for five minutes over a blip.
 */
describe('GET /api/books/[slug]/chunks — a failing database', () => {
	it('propagates a failure reading the book instead of answering 404', async () => {
		const { event } = requestEvent({
			book: { data: null, error: { message: 'connection terminated' } }
		});

		await expect(GET(event)).rejects.toMatchObject({ message: 'connection terminated' });
	});

	it('propagates a failure reading the chunks instead of serving a short window', async () => {
		// The nastier half: the book read succeeded, so a handler that treated a chunk error
		// as "no rows" would answer 200 with an empty window — and cache it for five minutes,
		// against an ETag computed over the emptiness.
		const { event } = requestEvent({ chunksError: { message: 'statement timeout' } });

		await expect(GET(event)).rejects.toMatchObject({ message: 'statement timeout' });
	});
});

describe('GET /api/books/[slug]/chunks — the ETag is over the answer, not the request', () => {
	it('gives one validator to two requests that clamp to the same range', async () => {
		// `limit=10` and `limit=5000` are different requests and the same window. The ETag is
		// computed from the CLAMPED bounds, so both name the same entity and a cache that
		// stored one can revalidate the other. Computing it from the raw query would mint a
		// second validator for byte-identical content and quietly halve the hit rate.
		const asked = await GET(requestEvent({ query: '?from=0&limit=10' }).event);
		const overAsked = await GET(requestEvent({ query: `?from=0&limit=5000` }).event);

		expect(overAsked.headers.get('etag')).toBe(asked.headers.get('etag'));
		expect(await body(overAsked)).toEqual(await body(asked));
	});

	it('gives an empty window its own validator rather than reusing the full one', async () => {
		const full = await GET(requestEvent({ query: '?from=0&limit=10' }).event);
		const past = await GET(requestEvent({ query: '?from=999&limit=10' }).event);

		expect(past.status).toBe(200);
		expect(past.headers.get('etag')).not.toBe(full.headers.get('etag'));
	});
});
