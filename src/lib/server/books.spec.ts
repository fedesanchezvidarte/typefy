import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/database.types';
import { getBookBySlug, listBooks } from './books';

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
	builder.order = record('order');
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
					slug: 'pride-and-prejudice-excerpt',
					title: 'Pride and Prejudice (excerpt)',
					author: 'Jane Austen',
					language: 'en',
					chunk_count: 6
				}
			],
			error: null
		});

		const books = await listBooks(client);

		expect(books).toEqual([
			{
				id: 'pride-and-prejudice-excerpt',
				title: 'Pride and Prejudice (excerpt)',
				author: 'Jane Austen',
				language: 'en',
				chunkCount: 6
			}
		]);
	});

	it('queries the books table for metadata only, never chunk content', async () => {
		const { client, calls } = mockSupabase({ data: [], error: null });

		await listBooks(client);

		expect(calls.find((c) => c.method === 'from')?.args).toEqual(['books']);
		const select = calls.find((c) => c.method === 'select');
		expect(select?.args[0]).not.toContain('chunks(');
		expect(select?.args[0]).not.toContain('content');
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
});

describe('getBookBySlug', () => {
	const bookRow = {
		slug: 'don-quijote-excerpt',
		title: 'Don Quijote de la Mancha (fragmento)',
		author: 'Miguel de Cervantes',
		language: 'es',
		chunk_count: 2,
		chunks: [
			{ id: 'uuid-1', index: 1, content: 'segundo', char_count: 7 },
			{ id: 'uuid-0', index: 0, content: 'primero', char_count: 7 }
		]
	};

	it('maps a book and its chunks to a full TypeableText, chunks ordered by index', async () => {
		const { client } = mockSupabase({ data: bookRow, error: null });

		const book = await getBookBySlug(client, 'don-quijote-excerpt');

		expect(book).toEqual({
			id: 'don-quijote-excerpt',
			title: 'Don Quijote de la Mancha (fragmento)',
			author: 'Miguel de Cervantes',
			language: 'es',
			chunkCount: 2,
			chunks: [
				{ id: 'uuid-0', textId: 'don-quijote-excerpt', index: 0, content: 'primero', charCount: 7 },
				{ id: 'uuid-1', textId: 'don-quijote-excerpt', index: 1, content: 'segundo', charCount: 7 }
			]
		});
	});

	it('maps chunk char_count → charCount and book_id-by-slug into textId', async () => {
		const { client } = mockSupabase({ data: bookRow, error: null });
		const book = await getBookBySlug(client, 'don-quijote-excerpt');
		expect(book?.chunks.every((c) => c.textId === 'don-quijote-excerpt')).toBe(true);
		expect(book?.chunks[0].charCount).toBe(7);
	});

	it('resolves the slug against the books table', async () => {
		const { client, calls } = mockSupabase({ data: bookRow, error: null });
		await getBookBySlug(client, 'don-quijote-excerpt');
		expect(calls.find((c) => c.method === 'eq')?.args).toEqual(['slug', 'don-quijote-excerpt']);
		expect(calls.find((c) => c.method === 'select')?.args[0]).toContain('chunks(');
	});

	it('returns null for an unknown slug (no row)', async () => {
		const { client } = mockSupabase({ data: null, error: null });
		expect(await getBookBySlug(client, 'missing')).toBeNull();
	});

	it('throws when the database returns an error', async () => {
		const { client } = mockSupabase({ data: null, error: { message: 'timeout' } });
		await expect(getBookBySlug(client, 'x')).rejects.toEqual({ message: 'timeout' });
	});
});
