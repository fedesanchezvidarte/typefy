export type Language = 'en' | 'es';

/**
 * A **UI locale** — what Paraglide renders the interface in, and the axis a per-locale book
 * summary is keyed on (spec #34).
 *
 * Declared here rather than imported from `$lib/paraglide/runtime` on purpose: that module is
 * generated at build time and gitignored, and `types.ts` is the one module every tier the
 * `lib-patterns` two-tier rule names may import from. A shared contract must not depend on an
 * artifact that does not exist in a fresh checkout.
 *
 * It coincides with {@link Language} on two strings today and stays **independent by rule**
 * (CONTEXT.md): content language is a property of the book, locale is a property of the
 * reader. Never substitute one for the other because the unions happen to match.
 */
export type Locale = 'en' | 'es';

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
 * Locale-keyed book summaries (spec #34) — the validated view of the `books.summary` jsonb map.
 *
 * `default` is Open Library's description, whose language is **unverified** — which is exactly
 * why it is not filed under `'en'`. Any locale key overrides it, so the resolution rule is a
 * one-liner: `summary[locale] ?? summary.default ?? null`. That rule lives in exactly one
 * place, `resolveSummary` (`$lib/library/summary`); no component ever reads this map directly,
 * and nothing else ever narrows the raw `Json` the generated types hand back.
 *
 * `Partial` because every key is optional — a book with no summary at all is `{}`, the column's
 * default, and is a normal state rather than a defect.
 */
export type SummaryByLocale = Partial<Record<'default' | Locale, string>>;

/**
 * One chapter of a book as ingestion derived it (ADR-0017): its 0-based position, its title,
 * and the index of the chunk it starts at. Mirrors a `chapters` row minus the keys.
 *
 * `startChunkIndex` is a **chunk** index, not a page number. The 1-based page numbers a reader
 * sees are derived from it by `buildChapterProgress`, which is the only place the two
 * vocabularies meet.
 */
export interface ChapterSummary {
	index: number;
	title: string;
	startChunkIndex: number;
}

/**
 * A chapter with its resolved page range and one user's progress inside it (spec #34) — what
 * the detail screen's chapter list renders.
 *
 * Produced by `buildChapterProgress` (`$lib/library/chapter-progress`), which applies
 * ADR-0017's attribution rule: a page belongs to the chapter its FIRST character falls in, so
 * ranges are contiguous and non-overlapping and progress stays a plain count with no weighted
 * sum anywhere in the product.
 */
export interface ChapterProgress extends ChapterSummary {
	/** 1-based, inclusive — what the UI shows. */
	firstPage: number;
	/** 1-based, inclusive. Equals `firstPage` for a one-page chapter. */
	lastPage: number;
	pageCount: number;
	/** 0 for a guest and for a chapter with no completions — never null. */
	pagesCompleted: number;
}

/**
 * A book's summary row PLUS the facts only the detail screen needs (spec #34).
 *
 * **Extends `TypeableTextSummary` rather than replacing it, and that is load-bearing.** The
 * typing path reads `getBookSummaryBySlug` on a hot route; it must not start paying for a
 * jsonb column and an embedded chapter list to serve a screen it never renders. Anything the
 * typing path needs belongs on the summary; anything only `/books/[slug]` needs belongs here.
 */
export interface TypeableTextDetail extends TypeableTextSummary {
	/**
	 * The WORK's first publication year (never a Gutenberg release date, never an edition
	 * date). Null is a real, expected state: the Open Library lookup is explicitly non-fatal.
	 */
	year: number | null;
	summary: SummaryByLocale;
	chapters: readonly ChapterSummary[];
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
