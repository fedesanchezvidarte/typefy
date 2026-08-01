export type Language = 'en' | 'es';

/**
 * Book metadata without chunk content — what the `/type` picker needs (spec #7:
 * the book list loads metadata only, no chunk text). `id` is the book's slug.
 */
export interface TypeableTextSummary {
	/**
	 * The book's SLUG — the `/type/[slug]` URL segment, the `{#key}` identity in the typing
	 * route, and what `Chunk.textId` points at. Never the uuid: `bookId` is that.
	 */
	id: string;
	/**
	 * The `books.id` uuid (spec #12). The database's own key for the book, used as
	 * `chunk_attempts.book_id` and to look progress up in `book_progress` / `chunk_progress`.
	 * Distinct from `id` on purpose — the URL is addressed by slug, the database by uuid.
	 */
	bookId: string;
	title: string;
	author: string;
	language: Language; // content language — independent of UI locale
	chunkCount: number;
	/**
	 * Curated cover art (ADR-0006 `books.cover_url`); null → the library renders
	 * a generated typographic cover (spec #9). The call is made per book by a
	 * human — there is no heuristic.
	 */
	coverUrl: string | null;
}

/**
 * A summary plus **all** its chunks (ADR-0006 `books` row + its `chunks`).
 *
 * Since spec #18 the typing path never produces one of these: text is delivered in
 * `ChunkWindow`s and the engine consumes `LoadedChunks`. What legitimately remains are the
 * fixtures (`src/lib/fixtures/*`, which `db:seed:generate` reads) and `getHeroBook`, whose
 * result is a genuine one-passage typeable text with `chunkCount: 1`. Do not reach for it
 * on a full-length book again — that read is the ~1 MB payload with a silent PostgREST
 * row-limit truncation behind it that `getBookBySlug`'s deletion removed.
 */
export interface TypeableText extends TypeableTextSummary {
	chunks: readonly Chunk[];
}

/**
 * A contiguous run of chunks addressed by ABSOLUTE index — the unit typeable text is
 * delivered in (spec #18). Carries no per-user data, by construction: it is the body of a
 * publicly cacheable response, and completed-chunk ids travel on a separate private one.
 */
export interface ChunkWindow {
	/** Absolute index of the first chunk, AFTER clamping. */
	from: number;
	/** The chunks, ordered by index. Empty when `from >= chunkCount` — a 200, not a 404. */
	chunks: Chunk[];
	/**
	 * The text's authoritative length (`books.chunk_count`), echoed on every window so a
	 * client holding a stale bound — a re-ingest grew or shrank the book mid-session — can
	 * reconcile instead of awaiting a chunk that will never exist.
	 */
	chunkCount: number;
}

/** `GET /api/books/[slug]/chunks` body. Identical to `ChunkWindow` — that is the point. */
export type ChunkWindowResponse = ChunkWindow;

/**
 * `GET /api/books/[slug]/progress` body. Per-user; never cached, never merged into the
 * cacheable window above.
 */
export interface WindowProgressResponse {
	from: number;
	limit: number;
	/** Completed chunk ids among that range only. Empty for a guest, with no query issued. */
	completedChunkIds: string[];
}

/** Mirrors the future `chunks` row. `textId` maps to `book_id` in Phase 2. */
export interface Chunk {
	id: string;
	textId: string;
	index: number; // 0-based order within the text
	content: string; // 400-600 chars, hand-chunked per ADR-0005
	charCount: number;
}
