import type { Actions, PageServerLoad } from './$types';
import type { ChapterProgress, TypeableTextDetail } from '$lib/types';
import { error, fail } from '@sveltejs/kit';
import { getLocale } from '$lib/paraglide/runtime';
import { getBookDetailBySlug } from '$lib/server/books';
import {
	getBookCompletionCount,
	getCompletedChunkIndexes,
	resetBookProgress
} from '$lib/server/progress';
import { buildChapterProgress } from '$lib/library/chapter-progress';
import { resolveSummary } from '$lib/library/summary';

/**
 * The book detail screen's data (spec #34) — a book's cover, its back-cover facts, its overall
 * progress and its chapter list. This is the book's canonical page and every library entry
 * point's destination; `/type/[slug]` is what it links INTO, and is unchanged by it.
 *
 * `getBookDetailBySlug` returning `null` becomes a 404, which covers an unknown slug and an
 * unpublished book identically — that collapse is the requirement, not an accident of the
 * query. RLS owns publication (ADR-0006), so there is no `published_at` predicate anywhere on
 * this path and the two cases are genuinely indistinguishable to the route.
 *
 * A guest issues **ZERO progress queries**. The `if (!user)` early return is an acceptance
 * criterion rather than an optimisation, the same posture `/type` and `/type/[slug]` already
 * take. `buildChapterProgress(chapters, chunkCount, [])` still yields the full chapter list
 * with real page ranges and `pagesCompleted: 0` throughout, so the screen is complete signed
 * out with no branching in the pure module — only the progress numerals are omitted, and the
 * component decides that from `page.data.user`.
 *
 * The page counts on this screen are **ours** (`books.chunk_count` under the spec #32 page
 * model), never a print edition's. The app never shows two conflicting numbers for the same
 * book.
 */
export interface BookDetailPageData {
	book: TypeableTextDetail;
	/**
	 * The summary resolved for the CURRENT UI locale, or `null` → the panel is omitted
	 * entirely (no empty panel, no placeholder).
	 *
	 * Resolved HERE rather than in the component, for the same reason `/type`'s load resolves
	 * its filter and sort server-side: the first paint is already the right language, so there
	 * is no hydration flash where an English blurb is replaced by a Spanish one. It also keeps
	 * `resolveSummary` — the single place `books.summary`'s raw `Json` is narrowed — off the
	 * client entirely.
	 */
	summary: string | null;
	/** Always present; every entry has 0 completions for a guest. Empty for a book with no chapters. */
	chapters: ChapterProgress[];
	/** Book-lifetime completed pages — the overall bar's numerator. 0 for a guest. */
	chunksCompleted: number;
}

/**
 * `satisfies` rather than a type annotation: `PageServerLoad`'s declared return is
 * `data | void` over `Record<string, any>`, which erases the payload. Declaring the
 * concrete type and checking it against `PageServerLoad` keeps both — the route
 * contract AND a return type the load's tests can actually hold to.
 */
export const load = (async ({ params, locals }): Promise<BookDetailPageData> => {
	const book = await getBookDetailBySlug(locals.supabase, params.slug);
	if (!book) {
		error(404, 'Book not found');
	}

	// `getLocale()` is the UI locale (the `/es` URL prefix), never the book's content
	// language: a Spanish book read under EN shows the `default` blurb, and the same book
	// under ES shows the manifest's Spanish one. The two axes stay independent by rule.
	const summary = resolveSummary(book.summary, getLocale());

	const { user } = await locals.safeGetSession();
	if (!user) {
		return {
			book,
			summary,
			// Not `[]`: a guest still sees every chapter and its page range, just with no
			// completion counts. The empty completed set is what makes that one code path.
			chapters: buildChapterProgress(book.chapters, book.chunkCount, []),
			chunksCompleted: 0
		};
	}

	// Independent reads, so they share one round trip: the rollup count is the overall bar's
	// numerator and the indices are what the chapter fold buckets. Neither needs the other.
	const [chunksCompleted, completedIndexes] = await Promise.all([
		getBookCompletionCount(locals.supabase, user.id, book.bookId),
		getCompletedChunkIndexes(locals.supabase, user.id, book.bookId)
	]);

	return {
		book,
		summary,
		// `completedIndexes` arrives UNSORTED by design (`getCompletedChunkIndexes` orders by
		// `chunk_id`, the only key `.range()` can partition on). `buildChapterProgress` buckets
		// by lookup precisely so that holds — do not sort on the way in.
		chapters: buildChapterProgress(book.chapters, book.chunkCount, completedIndexes),
		chunksCompleted
	};
}) satisfies PageServerLoad;

/**
 * The progress reset (spec #51) — **the only destructive action in the application**.
 *
 * A form action rather than a browser RPC call, and that is a bundle decision as much as a
 * progressive-enhancement one. The typing screen goes to considerable lengths to keep
 * `@supabase/*` out of the entry bundle — reached only through one dynamic import, with no
 * static import permitted in any component — and doing this server-side means the book detail
 * screen needs none of that machinery: no dynamic import, no `invalidateAll()`, and the
 * refreshed progress falls out of the action's normal load re-run.
 *
 * It also degrades honestly: with JavaScript off, the confirmation's second step is a plain
 * form submit and the reset still works. Only the local page-state clear (spec §8) needs the
 * client, which is why it lives in `use:enhance` and not here.
 *
 * The slug is resolved to a book id HERE rather than trusted from the form body. A client
 * that could post an arbitrary `book_id` would still only reach its own rows — the RPC reads
 * `auth.uid()` internally — but the route should not accept an identifier it can derive, and
 * the lookup is what makes an unknown or unpublished slug a 404 instead of a silent no-op.
 */
export const actions = {
	reset: async ({ params, locals }) => {
		const { user } = await locals.safeGetSession();
		if (!user) {
			// A guest has no progress to reset, and the control that posts here never renders
			// signed out. This is the direct-POST path, refused rather than ignored.
			return fail(401, { reset: 'unauthenticated' });
		}

		const book = await getBookDetailBySlug(locals.supabase, params.slug);
		if (!book) {
			error(404, 'Book not found');
		}

		// Throws on failure, exactly like the reads: a reset that silently failed would leave
		// the user looking at a progress bar they just asked to clear.
		await resetBookProgress(locals.supabase, book.bookId);

		// No redirect: the action returns and SvelteKit re-runs the load, so the bar re-renders
		// at zero and the control disappears with it. `bookId` rides back for `use:enhance`,
		// which needs it to clear this book's in-page-restore drafts (spec §8) — the load's
		// `book.id` is the SLUG, and page-state is keyed by the uuid.
		return { reset: 'done' as const, bookId: book.bookId };
	}
} satisfies Actions;
