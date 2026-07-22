import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/database.types';
import type { Chunk, Language, TypeableText, TypeableTextSummary } from '$lib/types';

/**
 * Books service (spec #7): reads typeable-text content from Supabase and maps rows to
 * the `TypeableText` / `Chunk` shapes the engine already consumes, so nothing downstream
 * of the load function changes when the data source moves from fixtures to the database.
 *
 * Per `lib-patterns`, the `SupabaseClient` is injected as the first parameter (never
 * created here), which is what makes these functions unit-testable with a mock. DB errors
 * are surfaced by throwing — there is deliberately no fallback to fixtures (spec #7): if
 * the database is unreachable the caller shows an error rather than silently masking it.
 */

type Client = SupabaseClient<Database>;
type BookRow = Database['public']['Tables']['books']['Row'];
type ChunkRow = Database['public']['Tables']['chunks']['Row'];

/** The book columns the picker needs — metadata only, no chunk content. */
type BookSummaryRow = Pick<BookRow, 'slug' | 'title' | 'author' | 'language' | 'chunk_count'>;
/** One chunk's content columns, as embedded under a book. */
type ChunkContentRow = Pick<ChunkRow, 'id' | 'index' | 'content' | 'char_count'>;
type BookWithChunksRow = BookSummaryRow & { chunks: ChunkContentRow[] };

const BOOK_SUMMARY_COLUMNS = 'slug, title, author, language, chunk_count';
const CHUNK_COLUMNS = 'id, index, content, char_count';

const LANGUAGES: readonly Language[] = ['en', 'es'];

/** `books.language` is a checked text column, generated as `string`; narrow it here. */
function toLanguage(value: string): Language {
	if ((LANGUAGES as readonly string[]).includes(value)) {
		return value as Language;
	}
	throw new Error(`Unknown content language "${value}" in books row`);
}

function toSummary(row: BookSummaryRow): TypeableTextSummary {
	return {
		id: row.slug, // the app addresses a typeable text by its slug
		title: row.title,
		author: row.author,
		language: toLanguage(row.language),
		chunkCount: row.chunk_count
	};
}

function toChunk(slug: string, row: ChunkContentRow): Chunk {
	return {
		id: row.id, // the real DB uuid, so Phase 2b can reference it as chunk_attempts.chunk_id
		textId: slug,
		index: row.index,
		content: row.content,
		charCount: row.char_count
	};
}

function toTypeableText(row: BookWithChunksRow): TypeableText {
	// Sort defensively by index so ordering never depends on the query's row order.
	const chunks = [...row.chunks]
		.sort((a, b) => a.index - b.index)
		.map((chunk) => toChunk(row.slug, chunk));
	return { ...toSummary(row), chunks };
}

/** All seeded books as metadata (no chunk content), in a stable display order. */
export async function listBooks(client: Client): Promise<TypeableTextSummary[]> {
	const { data, error } = await client
		.from('books')
		.select(BOOK_SUMMARY_COLUMNS)
		.order('language')
		.order('title');
	if (error) {
		throw error;
	}
	return (data as BookSummaryRow[]).map(toSummary);
}

/**
 * One book and all its chunks (ordered by index) in a single query, or `null` if no book
 * has that slug — the route turns `null` into a 404.
 */
export async function getBookBySlug(client: Client, slug: string): Promise<TypeableText | null> {
	const { data, error } = await client
		.from('books')
		.select(`${BOOK_SUMMARY_COLUMNS}, chunks(${CHUNK_COLUMNS})`)
		.eq('slug', slug)
		.maybeSingle();
	if (error) {
		throw error;
	}
	if (!data) {
		return null;
	}
	return toTypeableText(data as unknown as BookWithChunksRow);
}
