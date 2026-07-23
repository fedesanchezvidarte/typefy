import type { PageServerLoad } from './$types';
import { listBooks } from '$lib/server/books';

/**
 * The picker's data: seeded books as metadata only (no chunk content) from the database
 * (spec #7). A DB error propagates to SvelteKit's error boundary — there is deliberately
 * no fallback to fixtures.
 */
export const load: PageServerLoad = async ({ locals }) => {
	return { books: await listBooks(locals.supabase) };
};
