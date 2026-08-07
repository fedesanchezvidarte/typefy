import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/database.types';
import { matchesSearch } from '$lib/library/search';
import type {
	Chunk,
	Language,
	LanguageFilter,
	TypeableText,
	TypeableTextSummary
} from '$lib/types';

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

/** The book columns the library needs — metadata only, no chunk content. */
type BookSummaryRow = Pick<
	BookRow,
	'id' | 'slug' | 'title' | 'author' | 'language' | 'chunk_count' | 'cover_url'
>;
/** One chunk's content columns, as embedded under a book. */
type ChunkContentRow = Pick<ChunkRow, 'id' | 'index' | 'content' | 'char_count'>;
type BookWithChunksRow = BookSummaryRow & { chunks: ChunkContentRow[] };

const BOOK_SUMMARY_COLUMNS = 'id, slug, title, author, language, chunk_count, cover_url';
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
		bookId: row.id, // the DB uuid — chunk_attempts.book_id and the progress rollup key (spec #12)
		title: row.title,
		author: row.author,
		language: toLanguage(row.language),
		chunkCount: row.chunk_count,
		coverUrl: row.cover_url
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

/** Options for {@link listBooks} — both narrow the result, independently of each other. */
export interface ListBooksOptions {
	/** Content-language filter (spec #19 §4). Default `'all'` — no predicate. */
	language?: LanguageFilter;
	/**
	 * Catalog search (spec #25 §2), already resolved by `parseSearchQuery` — `null`/absent
	 * means "no search". Matched in JS against the already-fetched, already-language-filtered
	 * rows (see `matchesSearch`): the catalog is 12 rows, `unaccent` is not installed, and
	 * there is no Postgres text-search predicate to add for this.
	 */
	query?: string | null;
}

/**
 * All published books as metadata (no chunk content), in a stable display order, optionally
 * narrowed to one content language (spec #19 §4) and/or a search query (spec #25 §2).
 * Filtering here rather than in the browser is what makes the first paint already correct —
 * no hydration flash, and no list that visibly narrows after the user has seen it.
 *
 * **The language filter is an ADDITION to the publication gate, never a substitute.** There is
 * still no `published_at` predicate: RLS owns publication (ADR-0006), which is what makes the
 * guarantee hold for every caller rather than for this one. Do not "consolidate" the two — a
 * query filter that looks like a gate becomes the only gate the day someone removes it.
 *
 * **Sorting is deliberately NOT done here.** `sortBooks` needs a locale, and locale is a
 * Paraglide/UI concern this Supabase-facing service shouldn't have to import — the caller
 * (the route) sorts the result itself, same as it already resolves `getLocale()` for the
 * language filter's default.
 */
export async function listBooks(
	client: Client,
	options: ListBooksOptions = {}
): Promise<TypeableTextSummary[]> {
	const { language = 'all', query = null } = options;
	let dbQuery = client.from('books').select(BOOK_SUMMARY_COLUMNS);
	if (language !== 'all') {
		dbQuery = dbQuery.eq('language', language);
	}
	const { data, error } = await dbQuery.order('language').order('title');
	if (error) {
		throw error;
	}
	const books = (data as BookSummaryRow[]).map(toSummary);
	return query === null ? books : books.filter((book) => matchesSearch(book, query));
}

/**
 * One book's METADATA, or `null` if no book has that slug — the route turns `null` into a
 * 404. The typing route's first read, and the only book read on the typing path: chunks
 * arrive separately through `getChunkWindow` (spec #18).
 *
 * No `published_at` filter, deliberately: the publication-gating RLS policy makes an
 * unpublished book indistinguishable from a nonexistent one for `anon` and `authenticated`
 * alike. Relying on the policy here rather than on a query filter is the point — it is what
 * makes the guarantee hold for every caller, not just this one.
 */
export async function getBookSummaryBySlug(
	client: Client,
	slug: string
): Promise<TypeableTextSummary | null> {
	const { data, error } = await client
		.from('books')
		.select(BOOK_SUMMARY_COLUMNS)
		.eq('slug', slug)
		.maybeSingle();
	if (error) {
		throw error;
	}
	if (!data) {
		return null;
	}
	return toSummary(data as BookSummaryRow);
}

/**
 * A bounded run of chunks, ordered by index (spec #18). `from`/`limit` are ABSOLUTE and
 * already clamped by the caller (`clampWindow` in `$lib/reading/window`); this function
 * does not know what a window is, which is what makes it testable against arbitrary ranges
 * and what keeps the window policy in one place.
 *
 * `book` is the summary the caller already holds, because a chunk needs BOTH identifiers:
 * `book.bookId` (the uuid) addresses `chunks.book_id`, and `book.id` (the slug) is what
 * `Chunk.textId` points at. The two are never interchanged.
 *
 * A zero limit short-circuits to `[]` without a query: an empty window is a legitimate
 * answer ("the book exists, that range of it does not"), not a round trip.
 */
export async function getChunkWindow(
	client: Client,
	book: Pick<TypeableTextSummary, 'id' | 'bookId'>,
	from: number,
	limit: number
): Promise<Chunk[]> {
	if (limit <= 0) {
		return [];
	}
	const { data, error } = await client
		.from('chunks')
		.select(CHUNK_COLUMNS)
		.eq('book_id', book.bookId)
		.gte('index', from)
		.lt('index', from + limit)
		.order('index');
	if (error) {
		throw error;
	}
	// Sorted defensively so ordering never depends on the query's row order.
	return [...(data as ChunkContentRow[])]
		.sort((a, b) => a.index - b.index)
		.map((chunk) => toChunk(book.id, chunk));
}

/**
 * The landing hero's typeable text (spec #18 §7): the FEATURED book in this content
 * language, with its FIRST CHUNK ONLY — the hero passage responds on the first keystroke,
 * so it must be real typeable text, not copy, but the hero never needs a second passage.
 * `null` when no featured book exists in that language (the route falls back to the other
 * language before erroring).
 *
 * `.maybeSingle()` is correct rather than lucky here: `books_featured_per_language_idx` is
 * a partial unique index, so the database — not a convention — guarantees at most one row.
 *
 * The returned `TypeableText` reports **`chunkCount: chunks.length`** (1 in practice), NOT
 * `books.chunk_count`. This is deliberate and load-bearing: `LandingHero` loops on the
 * session reaching `finished`, which only fires when `nextIndex >= chunkCount`, so a
 * truncated book claiming 2,000 chunks would try to open a chunk it does not hold on the
 * very first completion. The hero is a one-passage typeable text that happens to be drawn
 * from a book — not a book with 1,999 chunks missing.
 */
export async function getHeroBook(
	client: Client,
	language: Language
): Promise<TypeableText | null> {
	const { data, error } = await client
		.from('books')
		.select(`${BOOK_SUMMARY_COLUMNS}, chunks(${CHUNK_COLUMNS})`)
		.eq('language', language)
		.eq('featured', true)
		.eq('chunks.index', 0)
		.maybeSingle();
	if (error) {
		throw error;
	}
	if (!data) {
		return null;
	}
	const text = toTypeableText(data as unknown as BookWithChunksRow);
	return { ...text, chunkCount: text.chunks.length };
}
