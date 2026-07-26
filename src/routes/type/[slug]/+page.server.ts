import type { PageServerLoad } from './$types';
import type { TypeableText } from '$lib/types';
import { error } from '@sveltejs/kit';
import { getBookBySlug } from '$lib/server/books';
import { getBookCompletionCount, getCompletedChunkIds } from '$lib/server/progress';
import { resolveStartIndex } from '$lib/progress/resume';

/**
 * One book and all its chunks (spec #7). An unknown slug is a 404; a DB error propagates
 * to the error boundary rather than falling back to fixtures.
 *
 * Spec #12 adds resume and book-lifetime progress:
 * - `startIndex` — the first incomplete passage, or the `?passage=N` override when N is a
 *   valid 1-based index. An invalid override falls back silently (never a 400/404): a stale
 *   hand-edited link must still open the book. Both rules live in `resolveStartIndex`, not here.
 * - `completedChunkIds` — serialised as an array because a `Set` does not survive load
 *   serialisation; the client rebuilds it.
 * - `chunksCompleted` — the numerator of the meta line's percentage.
 *
 * A guest issues **no progress query at all**; the `user ?` guards are the acceptance
 * criterion. For a signed-in user the two reads are independent, so they share one round
 * trip via `Promise.all` — inside the guard, so the guest branch stays query-free.
 */
export interface TypingPageData {
	book: TypeableText;
	/** Passage the session opens at: first incomplete, or a valid `?passage=N` override. */
	startIndex: number;
	/** Completed chunk ids, as an array — a `Set` does not survive load serialisation. */
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
	const book = await getBookBySlug(locals.supabase, params.slug);
	if (!book) {
		error(404, 'Book not found');
	}

	const { user } = await locals.safeGetSession();
	const [completedChunkIds, chunksCompleted] = user
		? await Promise.all([
				getCompletedChunkIds(locals.supabase, user.id, book.bookId),
				getBookCompletionCount(locals.supabase, user.id, book.bookId)
			])
		: [new Set<string>() as ReadonlySet<string>, 0];

	return {
		book,
		startIndex: resolveStartIndex(book.chunks, completedChunkIds, url.searchParams.get('passage')),
		completedChunkIds: [...completedChunkIds],
		chunksCompleted
	};
}) satisfies PageServerLoad;
