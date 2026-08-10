import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/database.types';
import {
	getBookDetailBySlug,
	getBookSummaryBySlug,
	getChunkWindow,
	getHeroBook,
	listBooks
} from './books';

/**
 * Service tests (spec #7): the injected Supabase client is mocked — a real DB call must
 * never reach a unit test (testing-patterns). The mock is a chainable, thenable query
 * builder that records its calls and resolves to a configured `{ data, error }`.
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
	builder.gte = record('gte');
	builder.lt = record('lt');
	builder.order = record('order');
	builder.limit = record('limit');
	builder.maybeSingle = (...args: unknown[]) => {
		calls.push({ method: 'maybeSingle', args });
		return Promise.resolve(result);
	};
	// Thenable so `await client.from(...).select(...).order(...)` resolves to the result.
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

describe('listBooks', () => {
	it('maps book rows to TypeableText summaries (slug → id, chunk_count → chunkCount)', async () => {
		const { client } = mockSupabase({
			data: [
				{
					id: 'b0000000-0000-0000-0000-000000000001',
					slug: 'pride-and-prejudice-excerpt',
					title: 'Pride and Prejudice (excerpt)',
					author: 'Jane Austen',
					language: 'en',
					chunk_count: 6,
					cover_url: null
				}
			],
			error: null
		});

		const books = await listBooks(client);

		expect(books).toEqual([
			{
				id: 'pride-and-prejudice-excerpt',
				bookId: 'b0000000-0000-0000-0000-000000000001',
				title: 'Pride and Prejudice (excerpt)',
				author: 'Jane Austen',
				language: 'en',
				chunkCount: 6,
				coverUrl: null
			}
		]);
	});

	it('passes curated cover art through as coverUrl (spec #9 cover policy)', async () => {
		const { client } = mockSupabase({
			data: [
				{
					slug: 'x',
					title: 'X',
					author: 'Y',
					language: 'en',
					chunk_count: 1,
					cover_url: 'https://covers.example/x.jpg'
				}
			],
			error: null
		});
		const books = await listBooks(client);
		expect(books[0].coverUrl).toBe('https://covers.example/x.jpg');
	});

	it('queries the books table for metadata only, never chunk content', async () => {
		const { client, calls } = mockSupabase({ data: [], error: null });

		await listBooks(client);

		expect(calls.find((c) => c.method === 'from')?.args).toEqual(['books']);
		const select = calls.find((c) => c.method === 'select');
		expect(select?.args[0]).not.toContain('chunks(');
		expect(select?.args[0]).not.toContain('content');
	});

	it('selects books.id, and keeps the slug in `id` and the uuid in `bookId` (never swapped)', async () => {
		const { client, calls } = mockSupabase({
			data: [
				{
					id: 'b0000000-0000-0000-0000-000000000002',
					slug: 'don-quijote-excerpt',
					title: 'Don Quijote de la Mancha (fragmento)',
					author: 'Miguel de Cervantes',
					language: 'es',
					chunk_count: 5,
					cover_url: null
				}
			],
			error: null
		});

		const books = await listBooks(client);

		// The summary select must ask for the uuid: spec #12's write path needs
		// chunk_attempts.book_id, and without this column it is simply not in the row.
		const columns = String(calls.find((c) => c.method === 'select')?.args[0])
			.split(',')
			.map((column) => column.trim());
		expect(columns).toContain('id');
		expect(columns).toContain('slug');
		// The two identifiers are distinct and must not be interchanged: `id` addresses
		// the /type/[slug] URL, `bookId` addresses the database.
		expect(books[0].id).toBe('don-quijote-excerpt');
		expect(books[0].bookId).toBe('b0000000-0000-0000-0000-000000000002');
		expect(books[0].id).not.toBe(books[0].bookId);
	});

	it('throws when the database returns an error (no fallback)', async () => {
		const { client } = mockSupabase({ data: null, error: { message: 'connection refused' } });
		await expect(listBooks(client)).rejects.toEqual({ message: 'connection refused' });
	});

	it('rejects an unknown content language rather than mislabelling it', async () => {
		const { client } = mockSupabase({
			data: [{ slug: 'x', title: 'X', author: 'Y', language: 'fr', chunk_count: 1 }],
			error: null
		});
		await expect(listBooks(client)).rejects.toThrow(/Unknown content language "fr"/);
	});

	// The `?lang` filter (spec #19 §4), applied server-side so the first paint is already
	// correct — no hydration flash, no list that visibly narrows after the user has seen it.
	describe('the content-language filter', () => {
		it('filters on the language when one is asked for', async () => {
			const { client, calls } = mockSupabase({ data: [], error: null });

			await listBooks(client, { language: 'es' });

			expect(calls.filter((c) => c.method === 'eq').map((c) => c.args)).toEqual([
				['language', 'es']
			]);
		});

		it('applies no language predicate for `all`', async () => {
			const { client, calls } = mockSupabase({ data: [], error: null });

			await listBooks(client, { language: 'all' });

			expect(calls.some((c) => c.method === 'eq')).toBe(false);
		});

		it('defaults to the whole catalog, so existing callers are unchanged', async () => {
			const { client, calls } = mockSupabase({ data: [], error: null });

			await listBooks(client);

			expect(calls.some((c) => c.method === 'eq')).toBe(false);
		});

		it('defaults to the whole catalog when options is an empty object', async () => {
			const { client, calls } = mockSupabase({ data: [], error: null });

			await listBooks(client, {});

			expect(calls.some((c) => c.method === 'eq')).toBe(false);
		});

		it('keeps the display order whatever the filter is', async () => {
			const { client, calls } = mockSupabase({ data: [], error: null });

			await listBooks(client, { language: 'en' });

			expect(calls.filter((c) => c.method === 'order').map((c) => c.args)).toEqual([
				['language'],
				['title']
			]);
		});

		it('never adds a published_at predicate — the filter is not a publication gate', async () => {
			// RLS owns publication (ADR-0006). A query filter here would look like the same thing
			// and would silently become the only gate the day someone "consolidated" the two.
			const { client, calls } = mockSupabase({ data: [], error: null });

			await listBooks(client, { language: 'en' });

			const args = JSON.stringify(calls.map((c) => c.args));
			expect(args).not.toContain('published_at');
		});
	});

	// The `?q` catalog search (spec #25 §2): matched in JS against rows already fetched by
	// the (unchanged) language-filtered query — no `ilike`, no `unaccent`, no new predicate.
	describe('the search filter', () => {
		const rows = [
			{
				id: 'b1',
				slug: 'pride-and-prejudice',
				title: 'Pride and Prejudice',
				author: 'Jane Austen',
				language: 'en',
				chunk_count: 6,
				cover_url: null
			},
			{
				id: 'b2',
				slug: 'don-quijote',
				title: 'Don Quijote de la Mancha',
				author: 'Miguel de Cervantes',
				language: 'es',
				chunk_count: 5,
				cover_url: null
			}
		];

		it('applies no filter and issues no extra query when query is absent', async () => {
			const { client } = mockSupabase({ data: rows, error: null });
			const books = await listBooks(client, {});
			expect(books).toHaveLength(2);
		});

		it('applies no filter when query is null', async () => {
			const { client } = mockSupabase({ data: rows, error: null });
			const books = await listBooks(client, { query: null });
			expect(books).toHaveLength(2);
		});

		it('narrows to books matching title or author, case- and accent-insensitively', async () => {
			const { client } = mockSupabase({ data: rows, error: null });
			const books = await listBooks(client, { query: 'cervantes' });
			expect(books.map((b) => b.id)).toEqual(['don-quijote']);
		});

		it('matches accent-insensitively even when the query itself carries no accent', async () => {
			const { client } = mockSupabase({ data: rows, error: null });
			const books = await listBooks(client, { query: 'quijote' });
			expect(books.map((b) => b.id)).toEqual(['don-quijote']);
		});

		it('returns an empty array when nothing matches, without erroring', async () => {
			const { client } = mockSupabase({ data: rows, error: null });
			const books = await listBooks(client, { query: 'frankenstein' });
			expect(books).toEqual([]);
		});

		it('composes with the language filter — both narrow together', async () => {
			const { client, calls } = mockSupabase({ data: [rows[1]], error: null });
			const books = await listBooks(client, { language: 'es', query: 'quijote' });
			expect(calls.filter((c) => c.method === 'eq').map((c) => c.args)).toEqual([
				['language', 'es']
			]);
			expect(books.map((b) => b.id)).toEqual(['don-quijote']);
		});

		it('issues no ilike or unaccent predicate — matching happens in JS, not Postgres', async () => {
			const { client, calls } = mockSupabase({ data: rows, error: null });
			await listBooks(client, { query: 'quijote' });
			expect(calls.some((c) => c.method === 'ilike')).toBe(false);
			const args = JSON.stringify(calls.map((c) => c.args));
			expect(args).not.toContain('unaccent');
		});
	});
});

describe('getBookSummaryBySlug', () => {
	const row = {
		id: 'b0000000-0000-0000-0000-000000000002',
		slug: 'don-quijote',
		title: 'Don Quijote de la Mancha',
		author: 'Miguel de Cervantes',
		language: 'es',
		chunk_count: 2000,
		cover_url: null
	};

	it('maps one book row to a summary, with chunkCount from books.chunk_count', async () => {
		const { client } = mockSupabase({ data: row, error: null });
		expect(await getBookSummaryBySlug(client, 'don-quijote')).toEqual({
			id: 'don-quijote',
			bookId: 'b0000000-0000-0000-0000-000000000002',
			title: 'Don Quijote de la Mancha',
			author: 'Miguel de Cervantes',
			language: 'es',
			chunkCount: 2000,
			coverUrl: null
		});
	});

	it('never embeds chunks — this is the metadata read that replaced the whole-book one', async () => {
		const { client, calls } = mockSupabase({ data: row, error: null });
		await getBookSummaryBySlug(client, 'don-quijote');
		const select = String(calls.find((c) => c.method === 'select')?.args[0]);
		expect(select).not.toContain('chunks(');
		expect(select).not.toContain('content');
	});

	it('resolves the slug against the books table', async () => {
		const { client, calls } = mockSupabase({ data: row, error: null });
		await getBookSummaryBySlug(client, 'don-quijote');
		expect(calls.find((c) => c.method === 'from')?.args).toEqual(['books']);
		expect(calls.find((c) => c.method === 'eq')?.args).toEqual(['slug', 'don-quijote']);
	});

	it('applies no published_at filter — RLS makes unpublished indistinguishable from unknown', async () => {
		const { client, calls } = mockSupabase({ data: row, error: null });
		await getBookSummaryBySlug(client, 'don-quijote');
		expect(calls.some((c) => JSON.stringify(c.args).includes('published_at'))).toBe(false);
	});

	it('returns null for an unknown slug (no row) — the route turns that into a 404', async () => {
		const { client } = mockSupabase({ data: null, error: null });
		expect(await getBookSummaryBySlug(client, 'missing')).toBeNull();
	});

	it('throws when the database returns an error', async () => {
		const { client } = mockSupabase({ data: null, error: { message: 'timeout' } });
		await expect(getBookSummaryBySlug(client, 'x')).rejects.toEqual({ message: 'timeout' });
	});
});

describe('getChunkWindow', () => {
	const book = { id: 'don-quijote', bookId: 'b0000000-0000-0000-0000-000000000002' };
	const rows = [
		{ id: 'uuid-10', index: 10, content: 'once', char_count: 4 },
		{ id: 'uuid-9', index: 9, content: 'nine', char_count: 4 }
	];

	it('maps chunk rows to Chunks with their ABSOLUTE index, ordered by index', async () => {
		const { client } = mockSupabase({ data: rows, error: null });
		expect(await getChunkWindow(client, book, 9, 2)).toEqual([
			{ id: 'uuid-9', textId: 'don-quijote', index: 9, content: 'nine', charCount: 4 },
			{ id: 'uuid-10', textId: 'don-quijote', index: 10, content: 'once', charCount: 4 }
		]);
	});

	it('queries a half-open range on the chunks table: [from, from + limit)', async () => {
		const { client, calls } = mockSupabase({ data: [], error: null });
		await getChunkWindow(client, book, 9, 10);
		expect(calls.find((c) => c.method === 'from')?.args).toEqual(['chunks']);
		expect(calls.find((c) => c.method === 'eq')?.args).toEqual([
			'book_id',
			'b0000000-0000-0000-0000-000000000002'
		]);
		expect(calls.find((c) => c.method === 'gte')?.args).toEqual(['index', 9]);
		expect(calls.find((c) => c.method === 'lt')?.args).toEqual(['index', 19]);
		expect(calls.find((c) => c.method === 'order')?.args[0]).toBe('index');
	});

	it('takes bounds as arguments and applies no window policy of its own', async () => {
		// The clamp lives in src/lib/reading/window.ts; this is the mechanism, so an
		// arbitrary range must reach the query untouched — that is what makes it testable.
		const { client, calls } = mockSupabase({ data: [], error: null });
		await getChunkWindow(client, book, 1500, 4);
		expect(calls.find((c) => c.method === 'gte')?.args).toEqual(['index', 1500]);
		expect(calls.find((c) => c.method === 'lt')?.args).toEqual(['index', 1504]);
	});

	it('returns an empty array without querying for a zero limit — an empty window is not an error', async () => {
		const { client, calls } = mockSupabase({ data: null, error: { message: 'must not run' } });
		expect(await getChunkWindow(client, book, 2000, 0)).toEqual([]);
		expect(calls).toEqual([]);
	});

	it('returns an empty array when the range holds no rows', async () => {
		const { client } = mockSupabase({ data: [], error: null });
		expect(await getChunkWindow(client, book, 1999, 10)).toEqual([]);
	});

	it('puts the SLUG in textId and the uuid in the query — the two are never interchanged', async () => {
		const { client } = mockSupabase({ data: rows, error: null });
		const chunks = await getChunkWindow(client, book, 9, 2);
		expect(chunks.every((c) => c.textId === 'don-quijote')).toBe(true);
		expect(chunks.every((c) => c.textId !== book.bookId)).toBe(true);
	});

	it('throws when the database returns an error', async () => {
		const { client } = mockSupabase({ data: null, error: { message: 'timeout' } });
		await expect(getChunkWindow(client, book, 0, 10)).rejects.toEqual({ message: 'timeout' });
	});
});

describe('getHeroBook', () => {
	const bookRow = {
		id: 'b0000000-0000-0000-0000-000000000002',
		slug: 'don-quijote',
		title: 'Don Quijote de la Mancha',
		author: 'Miguel de Cervantes',
		language: 'es',
		chunk_count: 2000,
		cover_url: null,
		chunks: [{ id: 'uuid-0', index: 0, content: 'primero', char_count: 7 }]
	};

	it('resolves the FEATURED book in the requested content language', async () => {
		const { client, calls } = mockSupabase({ data: bookRow, error: null });

		const book = await getHeroBook(client, 'es');

		expect(book?.id).toBe('don-quijote');
		const eqs = calls.filter((c) => c.method === 'eq').map((c) => c.args);
		expect(eqs).toContainEqual(['language', 'es']);
		expect(eqs).toContainEqual(['featured', true]);
	});

	it('no longer selects the alphabetically first title — featured is the selection rule', async () => {
		const { client, calls } = mockSupabase({ data: bookRow, error: null });
		await getHeroBook(client, 'es');
		expect(calls.find((c) => c.method === 'order')?.args[0]).not.toBe('title');
	});

	it('loads exactly one chunk, index 0', async () => {
		const { client, calls } = mockSupabase({ data: bookRow, error: null });
		const book = await getHeroBook(client, 'es');
		expect(book?.chunks).toEqual([
			{ id: 'uuid-0', textId: 'don-quijote', index: 0, content: 'primero', charCount: 7 }
		]);
		expect(calls.filter((c) => c.method === 'eq').map((c) => c.args)).toContainEqual([
			'chunks.index',
			0
		]);
	});

	it('reports chunkCount 1, NOT the book-wide chunk_count', async () => {
		// Load-bearing: LandingHero loops on `status === "finished"`, which only fires when
		// nextIndex >= chunkCount. A truncated book reporting 2000 would try to open a chunk
		// it does not hold on the very first completion. The hero is a one-passage typeable
		// text drawn from a book — not a book with 1,999 chunks missing.
		const { client } = mockSupabase({ data: bookRow, error: null });
		const book = await getHeroBook(client, 'es');
		expect(book?.chunkCount).toBe(1);
		expect(book?.chunkCount).not.toBe(bookRow.chunk_count);
	});

	it('reports chunkCount 0 when the featured book has no chunk at index 0', async () => {
		// The write window of a non-transactional ingest: chunk_count is upserted before the
		// rows. The hero must report what it actually holds, not what the column claims.
		const { client } = mockSupabase({ data: { ...bookRow, chunks: [] }, error: null });
		const book = await getHeroBook(client, 'es');
		expect(book?.chunks).toEqual([]);
		expect(book?.chunkCount).toBe(0);
	});

	it('returns null when no featured book exists in that language', async () => {
		// The landing load falls back to the other language rather than erroring.
		const { client } = mockSupabase({ data: null, error: null });
		expect(await getHeroBook(client, 'en')).toBeNull();
	});

	it('throws when the database returns an error', async () => {
		const { client } = mockSupabase({ data: null, error: { message: 'timeout' } });
		await expect(getHeroBook(client, 'es')).rejects.toEqual({ message: 'timeout' });
	});
});

describe('getBookDetailBySlug', () => {
	const detailRow = {
		id: 'b0000000-0000-0000-0000-000000000009',
		slug: 'don-quijote',
		title: 'Don Quijote de la Mancha',
		author: 'Miguel de Cervantes',
		language: 'es',
		chunk_count: 2000,
		cover_url: null,
		year: 1605,
		summary: { default: 'An English blurb', es: 'Una reseña' },
		chapters: [
			{ index: 1, title: 'Capítulo II', start_chunk_index: 12 },
			{ index: 0, title: 'Capítulo I', start_chunk_index: 0 }
		]
	};

	it('maps the row to a TypeableTextDetail — summary fields plus year, summary and chapters', async () => {
		const { client } = mockSupabase({ data: detailRow, error: null });

		const book = await getBookDetailBySlug(client, 'don-quijote');

		expect(book).toEqual({
			id: 'don-quijote',
			bookId: 'b0000000-0000-0000-0000-000000000009',
			title: 'Don Quijote de la Mancha',
			author: 'Miguel de Cervantes',
			language: 'es',
			chunkCount: 2000,
			coverUrl: null,
			year: 1605,
			summary: { default: 'An English blurb', es: 'Una reseña' },
			chapters: [
				{ index: 0, title: 'Capítulo I', startChunkIndex: 0 },
				{ index: 1, title: 'Capítulo II', startChunkIndex: 12 }
			]
		});
	});

	it('sorts chapters defensively by index, never trusting the query row order', async () => {
		const { client } = mockSupabase({ data: detailRow, error: null });
		const book = await getBookDetailBySlug(client, 'don-quijote');
		expect(book?.chapters.map((c) => c.index)).toEqual([0, 1]);
	});

	it('reads books and chapters in ONE round trip, embedding chapters', async () => {
		const { client, calls } = mockSupabase({ data: detailRow, error: null });

		await getBookDetailBySlug(client, 'don-quijote');

		expect(calls.filter((c) => c.method === 'from').map((c) => c.args)).toEqual([['books']]);
		const select = calls.find((c) => c.method === 'select')?.args[0] as string;
		expect(select).toContain('year');
		expect(select).toContain('summary');
		expect(select).toContain('chapters(index, title, start_chunk_index)');
		expect(calls.some((c) => c.method === 'maybeSingle')).toBe(true);
	});

	it('applies no published_at predicate — RLS owns publication for every caller', async () => {
		const { client, calls } = mockSupabase({ data: detailRow, error: null });

		await getBookDetailBySlug(client, 'don-quijote');

		expect(calls.filter((c) => c.method === 'eq').map((c) => c.args)).toEqual([
			['slug', 'don-quijote']
		]);
	});

	it('returns a book with no chapters as an empty list, not null', async () => {
		// El Buscón-class books: no headings in the HTML, so no chapters row at all. The
		// screen renders without a chapter list rather than 404ing.
		const { client } = mockSupabase({ data: { ...detailRow, chapters: [] }, error: null });
		const book = await getBookDetailBySlug(client, 'el-buscon');
		expect(book?.chapters).toEqual([]);
	});

	it('passes a missing year and an empty summary map through untouched', async () => {
		// A failed or absent Open Library lookup is explicitly non-fatal. `resolveSummary`
		// turns `{}` into "no panel"; this service does not pre-empt that decision.
		const { client } = mockSupabase({
			data: { ...detailRow, year: null, summary: {} },
			error: null
		});
		const book = await getBookDetailBySlug(client, 'don-quijote');
		expect(book?.year).toBeNull();
		expect(book?.summary).toEqual({});
	});

	it('returns null for an unknown or unpublished slug, so the route 404s on both', async () => {
		const { client } = mockSupabase({ data: null, error: null });
		expect(await getBookDetailBySlug(client, 'nope')).toBeNull();
	});

	it('throws when the database returns an error', async () => {
		const { client } = mockSupabase({ data: null, error: { message: 'timeout' } });
		await expect(getBookDetailBySlug(client, 'don-quijote')).rejects.toEqual({
			message: 'timeout'
		});
	});
});
