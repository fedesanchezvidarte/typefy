import type { PageServerLoad } from './$types';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/database.types';
import type { ChapterSummary, ChunkWindow, Mode, TypeableTextSummary } from '$lib/types';
import { error } from '@sveltejs/kit';
import { getBookChapters, getBookSummaryBySlug, getChunkWindow } from '$lib/server/books';
import { getBookCompletionCount, getCompletedChunkIds } from '$lib/server/progress';
import { activeChapter } from '$lib/library/chapter-progress';
import { resolveStartIndex } from '$lib/progress/resume';
import { clampWindow, WINDOW_SIZE } from '$lib/reading/window';
import { MODE_COOKIE, parseMode } from '$lib/mode/mode';

/**
 * One book's METADATA and the FIRST WINDOW of its chunks (spec #18). An unknown slug is a
 * 404; a DB error propagates to the error boundary rather than falling back to fixtures.
 *
 * What spec #18 changed: this load no longer reads a whole book. It reads the book's
 * summary, resolves where the session opens, and then reads only the ~10 chunks starting
 * there. Windows 2..n arrive through `GET /api/books/[slug]/chunks` while the user types —
 * never through `invalidateAll()`, which would re-run this load and yank the live session.
 *
 * **The window is not grid-aligned.** `from` is the start index itself, not the origin of
 * some fixed block containing it. That is deliberate: it removes an entire class of
 * off-by-one arithmetic, and it is what makes "`?passage=900` opens the window containing
 * passage 900" true for free rather than by a second calculation.
 *
 * **This load is not cached and must not be made cacheable.** It is user-dependent by
 * construction: `startIndex` comes from `auth.uid()` through the resume RPC, and
 * `completedChunkIds` is per-user. It carries the first window's chunks AND that window's
 * completed ids inline, so the first passage costs zero extra requests — the public/private
 * cache split applies only to the windows that follow.
 *
 * Spec #12's progress contract is unchanged in meaning, only in scope:
 * - `startIndex` — the first incomplete page, or the `?page=N` override when N is a valid
 *   1-based index (spec #32: `?page=` is canonical; `?passage=N` is still accepted for
 *   back-compat, `page` winning when both are present). An invalid override falls back
 *   silently (never a 400/404): a stale hand-edited link must still open the book. Both
 *   rules live in `resolveStartIndex`, not here. The computed fallback now comes from SQL
 *   (`first_incomplete_chunk_index`) rather than from scanning a chunk array this load no
 *   longer has.
 * - `completedChunkIds` — serialised as an array because a `Set` does not survive load
 *   serialisation; the client rebuilds it. **Scoped to the window**, since ids for pages the
 *   session cannot reach yet are of no use to it and grow without bound on a long book.
 * - `chunksCompleted` — the numerator of the meta line's percentage, book-lifetime.
 *
 * A guest issues **no progress query at all** and calls no RPC; the `if (!user)` early
 * return is the acceptance criterion, not just an optimisation. (It is also a hard
 * requirement of the RPC: `execute` is granted to `authenticated` only, so a guest calling
 * it gets a 42501 error, not a 0.)
 */
export interface TypingPageData {
	/** Metadata only. The chunks are in `window`. */
	book: TypeableTextSummary;
	/** The first window, starting AT `startIndex` — not at a grid-aligned origin. */
	window: ChunkWindow;
	startIndex: number;
	/** Completed ids among `window.chunks` only. A `Set` does not survive load serialisation. */
	completedChunkIds: string[];
	chunksCompleted: number;
	/**
	 * The measurement axis this session opens in (spec #24 §10), from the `typefy-mode` cookie.
	 *
	 * Read HERE rather than in `hooks.server.ts` — see `$lib/mode/mode.ts` for the argument.
	 * The short version: exactly one route uses it, there is no chrome attribute to stamp
	 * before paint, and the thing §10 actually protects against is rendering a metrics row and
	 * then visibly stripping it on hydration, which a load read fixes at the same first paint.
	 */
	mode: Mode;
	/**
	 * The book's chapters (spec #45), index/title/start only — never the `summary` jsonb. The
	 * header names the chapter the active page falls in, and re-names it client-side on every
	 * page navigation, so the whole list travels once rather than a title per jump.
	 */
	chapters: ChapterSummary[];
	/**
	 * **The header's first paint**, and only that (spec #45).
	 *
	 * The typing screen's chrome lives in `AppHeader`'s center slot, which renders BEFORE the
	 * page component that owns the live session — on the server there is no effect to fill it
	 * from, and seeding it after hydration would render the metrics row empty and then populate
	 * it, exactly the flash spec #24 §10 forbids for the mode axis. So the load computes the
	 * opening values itself and the client overlays live ones from mount on.
	 */
	typingHeader: TypingHeaderSeed;
}

/**
 * The values the header slot renders before the session is mounted. Identity only since spec
 * #50 — see `seedHeader` for what left and why.
 */
export interface TypingHeaderSeed {
	title: string;
	/** `null` for front matter and for a book with no chapters — both legal (ADR-0017). */
	chapter: string | null;
	/** The book's slug, for the title's link back to the book detail screen. */
	slug: string;
}

/**
 * `satisfies` rather than a type annotation: `PageServerLoad`'s declared return is
 * `data | void` over `Record<string, any>`, which erases the payload. Declaring the
 * concrete type and checking it against `PageServerLoad` keeps both — the route
 * contract AND a return type the load's tests can actually hold to.
 */
export const load = (async ({ params, locals, url, cookies }): Promise<TypingPageData> => {
	const book = await getBookSummaryBySlug(locals.supabase, params.slug);
	if (!book) {
		error(404, 'Book not found');
	}

	// `?page=N` is canonical (spec #32); `?passage=N` is accepted for back-compat, so an
	// existing link keeps working. `page` wins when both happen to be present — back-compat
	// by ACCEPTANCE, not by redirect, matching the "a stale hand-edited link must still open
	// the book" posture `resolveStartIndex` already has for a single param.
	const pageParam = url.searchParams.get('page') ?? url.searchParams.get('passage');
	// No cookie means no explicit choice, so `normal` applies — the theme contract, verbatim.
	// An unrecognised value falls back the same way and silently, in the `?page=N` spirit: a
	// stale hand-edited cookie must still open the book. Identical for guests and signed-in
	// users; mode has no profile column and no precedence rule (§10).
	const mode = parseMode(cookies.get(MODE_COOKIE)) ?? 'normal';
	const { user } = await locals.safeGetSession();

	if (!user) {
		// A guest has no resume position, so the computed fallback is 0 and `?page=N` (or
		// `?passage=N`) is the only thing that can move the opening index. One chunk read, one
		// chapter read, nothing else — chapters are world-readable through their parent book's
		// policy, so this stays a guest-safe pair of reads rather than a progress query.
		const startIndex = resolveStartIndex(pageParam, book.chunkCount, 0);
		const [window, chapters] = await Promise.all([
			readWindow(locals.supabase, book, startIndex),
			getBookChapters(locals.supabase, book.bookId)
		]);
		return {
			book,
			window,
			startIndex,
			completedChunkIds: [],
			chunksCompleted: 0,
			mode,
			chapters,
			typingHeader: seedHeader(book, chapters, startIndex)
		};
	}

	// The resume index and the book-lifetime count are independent, so they share one round
	// trip. The window read cannot join them: it depends on `startIndex`, which is what the
	// RPC produces — a second trip by necessity, not by oversight.
	const [computedStartIndex, chunksCompleted] = await Promise.all([
		firstIncompleteChunkIndex(locals.supabase, book.bookId),
		getBookCompletionCount(locals.supabase, user.id, book.bookId)
	]);

	const startIndex = resolveStartIndex(pageParam, book.chunkCount, computedStartIndex);

	// Independent again: the window's content, the book's completed set and its chapters. The
	// intersection happens here rather than in the query because `chunk_progress` is keyed by
	// chunk uuid, which only the window read knows.
	const [window, completed, chapters] = await Promise.all([
		readWindow(locals.supabase, book, startIndex),
		getCompletedChunkIds(locals.supabase, user.id, book.bookId),
		getBookChapters(locals.supabase, book.bookId)
	]);

	// Filtered through the window's own chunks, so the ids arrive in index order.
	const completedChunkIds = window.chunks
		.filter((chunk) => completed.has(chunk.id))
		.map((chunk) => chunk.id);

	return {
		book,
		window,
		startIndex,
		completedChunkIds,
		chunksCompleted,
		mode,
		chapters,
		typingHeader: seedHeader(book, chapters, startIndex)
	};
}) satisfies PageServerLoad;

/**
 * The header slot's opening values. Pure assembly over what the load already has — the chapter
 * comes from the same `activeChapter` fold the client re-runs on every page navigation, so the
 * server's answer and the client's first answer are the same answer.
 *
 * **Identity only since spec #50.** It used to carry the page number, the percentage and the mode
 * axis as well, because the figures lived in the header and had to paint correctly on the server.
 * They live under the page card now, inside `TypingSession`, which is itself server-rendered with
 * `mode` straight off this load — so spec #24 §10's "no metrics, not even for one frame" is kept
 * by the component that owns them rather than mirrored up here.
 */
function seedHeader(
	book: TypeableTextSummary,
	chapters: readonly ChapterSummary[],
	startIndex: number
): TypingHeaderSeed {
	return {
		title: book.title,
		chapter: activeChapter(chapters, startIndex)?.title ?? null,
		slug: book.id
	};
}

/**
 * The window opening at `startIndex`, at most `WINDOW_SIZE` chunks long however long the
 * book is. `clampWindow` is what enforces that bound, and it is the same clamp the public
 * endpoint applies — one module, one number, so the SSR window and the prefetched ones can
 * never disagree about how much a window is.
 */
async function readWindow(
	client: SupabaseClient<Database>,
	book: TypeableTextSummary,
	startIndex: number
): Promise<ChunkWindow> {
	const bounds = clampWindow(startIndex, WINDOW_SIZE, book.chunkCount);
	return {
		from: bounds.from,
		chunks: await getChunkWindow(client, book, bounds.from, bounds.limit),
		chunkCount: book.chunkCount
	};
}

/**
 * The resume index, computed in SQL (spec #18 §2). Called directly rather than through a
 * service wrapper: it takes no client-supplied identity to validate and shapes nothing —
 * the user is `auth.uid()` inside the function, never an argument, because a user-id
 * parameter on a `SECURITY DEFINER` function reading `chunk_progress` would let any signed-in
 * caller read anyone's resume position.
 *
 * `p_book_id` is `books.id` (the uuid), never the slug. A null result cannot occur — the
 * function `coalesce`s to 0 — but is defended anyway, since 0 is the honest answer for every
 * case it collapses (fully complete, unknown, unpublished): there is no "finished" state.
 */
async function firstIncompleteChunkIndex(
	client: SupabaseClient<Database>,
	bookId: string
): Promise<number> {
	const { data, error: rpcError } = await client.rpc('first_incomplete_chunk_index', {
		p_book_id: bookId
	});
	if (rpcError) {
		throw rpcError;
	}
	return data ?? 0;
}
