import type { PageServerLoad } from './$types';
import type { LanguageFilter, TypeableTextSummary } from '$lib/types';
import { getLocale } from '$lib/paraglide/runtime';
import { listBooks } from '$lib/server/books';
import { getBookActivity } from '$lib/server/progress';
import { defaultLanguageFilter, parseLanguageFilter } from '$lib/library/language-filter';
import { selectContinueReading } from '$lib/library/continue-reading';

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
 *
 * Spec #19 adds the content-language filter and the continue-reading set. Both are computed
 * server-side so the first paint is already correct: no hydration flash, and no list that
 * visibly narrows after the user has seen it.
 */
export interface LibraryPageData {
	books: TypeableTextSummary[];
	/** Completed-chunk counts keyed by `books.id`. Empty for a guest. */
	progressByBook: Record<string, number>;
	/**
	 * The ACTIVE filter after fallback — what the control renders as current, never null.
	 * Returned even though the URL already carries it, because a page reached with
	 * `?lang=fr` must show the resolved filter as current rather than nothing.
	 */
	language: LanguageFilter;
	/** Top 3 in-progress books, most recently active first. Empty for a guest. */
	continueReading: TypeableTextSummary[];
}

/**
 * `satisfies` rather than a type annotation: `PageServerLoad`'s declared return is
 * `data | void` over `Record<string, any>`, which erases the payload. Declaring the
 * concrete type and checking it against `PageServerLoad` keeps both — the route
 * contract AND a return type the load's tests can actually hold to.
 */
export const load = (async ({ locals, url }): Promise<LibraryPageData> => {
	// Reading `?lang` from `url.searchParams` is also what makes SvelteKit re-run this load
	// when a filter link is followed. Anything unrecognised falls back SILENTLY — the
	// `?passage=N` posture: a hand-edited or stale link still opens the page, never 400.
	const language = parseLanguageFilter(
		url.searchParams.get('lang'),
		defaultLanguageFilter(getLocale())
	);
	const books = await listBooks(locals.supabase, language);

	const { user } = await locals.safeGetSession();
	if (!user) {
		return { books, progressByBook: {}, language, continueReading: [] };
	}

	const activity = await getBookActivity(locals.supabase, user.id);
	return {
		books,
		progressByBook: Object.fromEntries(
			[...activity].map(([bookId, entry]) => [bookId, entry.chunksCompleted])
		),
		language,
		// Not mapped or spread: `selectContinueReading` returns references INTO `books`, and
		// devalue deduplicates referentially-identical objects — so the book that legitimately
		// renders twice on the page costs payload bytes only once.
		continueReading: selectContinueReading(books, activity)
	};
}) satisfies PageServerLoad;
