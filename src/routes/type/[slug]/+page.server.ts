import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { getBookBySlug } from '$lib/server/books';

/**
 * One book and all its chunks (spec #7). An unknown slug is a 404; a DB error propagates
 * to the error boundary rather than falling back to fixtures.
 */
export const load: PageServerLoad = async ({ params, locals }) => {
	const book = await getBookBySlug(locals.supabase, params.slug);
	if (!book) {
		error(404, 'Book not found');
	}
	return { book };
};
