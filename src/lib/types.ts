export type Language = 'en' | 'es';

/**
 * The MEASUREMENT axis (spec #24). It answers exactly one question — *is this stretch of
 * typing being measured?* — and must never accumulate a second meaning.
 *
 * `zen` means no WPM and no accuracy is derived, displayed or persisted. It does NOT mean a
 * different presentation: a future page-view is a SEPARATE axis added beside this one, never
 * a third value inside it. Folding presentation in here would produce `zen-page` /
 * `normal-page` and a combinatorial mess the moment a third of either appears — the same
 * discipline ADR-0011 applied to palette and typeface.
 *
 * Declared here rather than in `src/lib/engine/` because the engine, the progress layer, the
 * route load and the schema all speak it; the engine already imports `Chunk` from this
 * module, so the dependency direction is unchanged.
 */
export type Mode = 'normal' | 'zen';

/**
 * Narrows an untrusted value to `Mode` — a cookie string, a `localStorage` buffer entry, a
 * hand-edited payload. Written as a guard rather than a cast so the two call sites that read
 * from outside the program (the mode cookie and the attempt buffer) cannot silently admit a
 * value the database's CHECK constraint would then reject.
 */
export function isMode(value: unknown): value is Mode {
	return value === 'normal' || value === 'zen';
}

/**
 * What `/type?lang=` selects (spec #19): a content language, or `all`. Derived from
 * `Language` because it filters over exactly that vocabulary — a third content language would
 * become a third filter option by construction.
 *
 * It is NOT a UI locale. The two coincide on two strings today and stay independent by rule
 * (CONTEXT.md) — which is why the starting filter is the locale-independent
 * `DEFAULT_LANGUAGE_FILTER` (`all`) rather than anything derived from `getLocale()`.
 */
export type LanguageFilter = Language | 'all';

/**
 * One user's `book_progress` rollup for one book, as the library reads it (spec #19).
 *
 * Declared here rather than beside the query so `src/lib/library/` — which selects over it —
 * never has to import from `$lib/server/`. Dependencies point one way.
 */
export interface BookActivity {
	chunksCompleted: number;
	/**
	 * `book_progress.last_active_at`; null for a rollup row the trigger has not timestamped.
	 *
	 * It is set from the attempt row's `created_at`, so for a DRAINED buffered attempt it marks
	 * the drain moment rather than the typing moment (ADR-0010's 2c amendment). Ordering by it
	 * is therefore "most recently persisted", which can differ from "most recently typed".
	 */
	lastActiveAt: string | null;
}

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
