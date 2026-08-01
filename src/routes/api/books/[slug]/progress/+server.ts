import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { WindowProgressResponse } from '$lib/types';
import { getBookSummaryBySlug, getChunkWindow } from '$lib/server/books';
import { getCompletedChunkIds } from '$lib/server/progress';
import { clampWindow } from '$lib/reading/window';
import { failure, parseRange } from '../range';

/**
 * `GET /api/books/[slug]/progress?from=&limit=` — which passages of a window this user has
 * already completed (spec #18 §4).
 *
 * The private half of the split the Feature Brief settled on. Content is public and
 * shared-cacheable; **progress is per-user and never cached, never merged into the cacheable
 * window**. Keeping the two apart is what makes "no user's progress is ever served to
 * another user from a shared cache" true structurally rather than contingent on an
 * intermediary honouring `Vary: Cookie` — which, with Supabase's chunked auth cookie, would
 * key the cache per session and cache nothing anyway.
 *
 * The client calls this **only when signed in**, and a failure here is cosmetic by design:
 * some completion markers are missing until the next load. It must never stall typing,
 * which is the other reason it is not fused into the window response.
 *
 * Validation, clamping and the 404 are identical to the chunks endpoint — same `parseRange`,
 * same RLS-enforced "unpublished is indistinguishable from unknown". A caller must not be
 * able to learn a book exists by asking the progress route what it cannot ask the chunks
 * route.
 */

/** Per-user and unstorable. `no-store` also forbids a validator, so there is no ETag. */
const PROGRESS_CACHE_CONTROL = 'private, no-store';

export const GET: RequestHandler = async ({ params, url, locals }) => {
	const parsed = parseRange(url);
	if (!parsed.ok) {
		return failure(400, parsed.reason);
	}

	const book = await getBookSummaryBySlug(locals.supabase, params.slug);
	if (!book) {
		return failure(404, 'Book not found');
	}

	const bounds = clampWindow(parsed.range.from, parsed.range.limit, book.chunkCount);

	// A guest issues NO progress query — the early return is the acceptance criterion, not an
	// optimisation, and it is the same guard shape the typing load uses. An empty window
	// (`from >= chunkCount`) short-circuits on the same line: there is nothing to scope to.
	const { user } = await locals.safeGetSession();
	if (!user || bounds.limit === 0) {
		return respond({ from: bounds.from, limit: bounds.limit, completedChunkIds: [] });
	}

	// Two independent reads, so one round trip. The chunk read supplies IDENTITY only — the
	// window's chunk uuids, which `chunk_progress` is keyed by and which nothing else in the
	// request knows — while the progress read is the book's completed set under RLS. The
	// intersection is what leaves this endpoint, so ids outside the window never do.
	const [chunks, completed] = await Promise.all([
		getChunkWindow(locals.supabase, book, bounds.from, bounds.limit),
		getCompletedChunkIds(locals.supabase, user.id, book.bookId)
	]);

	return respond({
		from: bounds.from,
		limit: bounds.limit,
		// Filtered through the window's own chunks, so the ids come back in index order.
		completedChunkIds: chunks.filter((chunk) => completed.has(chunk.id)).map((chunk) => chunk.id)
	});
};

function respond(body: WindowProgressResponse): Response {
	return json(body, { headers: { 'cache-control': PROGRESS_CACHE_CONTROL } });
}
