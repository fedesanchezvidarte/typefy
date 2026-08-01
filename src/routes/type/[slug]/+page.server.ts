import type { PageServerLoad } from './$types';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/database.types';
import type { ChunkWindow, TypeableTextSummary } from '$lib/types';
import { error } from '@sveltejs/kit';
import { getBookSummaryBySlug, getChunkWindow } from '$lib/server/books';
import { getBookCompletionCount, getCompletedChunkIds } from '$lib/server/progress';
import { resolveStartIndex } from '$lib/progress/resume';
import { clampWindow, WINDOW_SIZE } from '$lib/reading/window';

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
 * - `startIndex` — the first incomplete passage, or the `?passage=N` override when N is a
 *   valid 1-based index. An invalid override falls back silently (never a 400/404): a stale
 *   hand-edited link must still open the book. Both rules live in `resolveStartIndex`, not
 *   here. The computed fallback now comes from SQL (`first_incomplete_chunk_index`) rather
 *   than from scanning a chunk array this load no longer has.
 * - `completedChunkIds` — serialised as an array because a `Set` does not survive load
 *   serialisation; the client rebuilds it. **Scoped to the window**, since ids for passages
 *   the session cannot reach yet are of no use to it and grow without bound on a long book.
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
}

/**
 * `satisfies` rather than a type annotation: `PageServerLoad`'s declared return is
 * `data | void` over `Record<string, any>`, which erases the payload. Declaring the
 * concrete type and checking it against `PageServerLoad` keeps both — the route
 * contract AND a return type the load's tests can actually hold to.
 */
export const load = (async ({ params, locals, url }): Promise<TypingPageData> => {
	const book = await getBookSummaryBySlug(locals.supabase, params.slug);
	if (!book) {
		error(404, 'Book not found');
	}

	const passage = url.searchParams.get('passage');
	const { user } = await locals.safeGetSession();

	if (!user) {
		// A guest has no resume position, so the computed fallback is 0 and `?passage=N` is
		// the only thing that can move the opening index. One chunk read, nothing else.
		const startIndex = resolveStartIndex(passage, book.chunkCount, 0);
		return {
			book,
			window: await readWindow(locals.supabase, book, startIndex),
			startIndex,
			completedChunkIds: [],
			chunksCompleted: 0
		};
	}

	// The resume index and the book-lifetime count are independent, so they share one round
	// trip. The window read cannot join them: it depends on `startIndex`, which is what the
	// RPC produces — a second trip by necessity, not by oversight.
	const [computedStartIndex, chunksCompleted] = await Promise.all([
		firstIncompleteChunkIndex(locals.supabase, book.bookId),
		getBookCompletionCount(locals.supabase, user.id, book.bookId)
	]);

	const startIndex = resolveStartIndex(passage, book.chunkCount, computedStartIndex);

	// Independent again: the window's content and the book's completed set. The intersection
	// happens here rather than in the query because `chunk_progress` is keyed by chunk uuid,
	// which only the window read knows.
	const [window, completed] = await Promise.all([
		readWindow(locals.supabase, book, startIndex),
		getCompletedChunkIds(locals.supabase, user.id, book.bookId)
	]);

	return {
		book,
		window,
		startIndex,
		// Filtered through the window's own chunks, so the ids arrive in index order.
		completedChunkIds: window.chunks
			.filter((chunk) => completed.has(chunk.id))
			.map((chunk) => chunk.id),
		chunksCompleted
	};
}) satisfies PageServerLoad;

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
