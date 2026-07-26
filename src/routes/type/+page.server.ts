import type { PageServerLoad } from './$types';
import type { TypeableTextSummary } from '$lib/types';
import { listBooks } from '$lib/server/books';
import { getBookCompletionCounts } from '$lib/server/progress';

/**
 * The picker's data: seeded books as metadata only (no chunk content) from the database
 * (spec #7). A DB error propagates to SvelteKit's error boundary — there is deliberately
 * no fallback to fixtures.
 *
 * Spec #12 adds `progressByBook`: book-lifetime completion counts keyed by `books.id`
 * (`TypeableTextSummary.bookId`, never the slug), which the card turns into a percentage.
 * A guest issues **no progress query at all** — the `if (!user)` early return is the
 * acceptance criterion, not just an optimisation. A book absent from the map has no
 * `book_progress` row; the page reads it as 0 rather than treating absence as an error.
 */
export interface LibraryPageData {
	books: TypeableTextSummary[];
	/** Completed-chunk counts keyed by `books.id`. Empty for a guest. */
	progressByBook: Record<string, number>;
}

/**
 * `satisfies` rather than a type annotation: `PageServerLoad`'s declared return is
 * `data | void` over `Record<string, any>`, which erases the payload. Declaring the
 * concrete type and checking it against `PageServerLoad` keeps both — the route
 * contract AND a return type the load's tests can actually hold to.
 */
export const load = (async ({ locals }): Promise<LibraryPageData> => {
	const books = await listBooks(locals.supabase);

	const { user } = await locals.safeGetSession();
	if (!user) {
		return { books, progressByBook: {} };
	}

	const counts = await getBookCompletionCounts(locals.supabase, user.id);
	return { books, progressByBook: Object.fromEntries(counts) };
}) satisfies PageServerLoad;
