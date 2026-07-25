import type { PageServerLoad } from './$types';
import { getLocale } from '$lib/paraglide/runtime';
import { getHeroBook } from '$lib/server/books';

/**
 * The landing hero's typeable text (spec #9): the seeded book matching the UI
 * locale, so the ES landing greets you with Cervantes and the EN one with
 * Austen. The hero passage is real content from the database — never copy.
 * Falls back to the other language before giving up (hero is omitted only if
 * the catalog is truly empty).
 */
export const load: PageServerLoad = async ({ locals }) => {
	const locale = getLocale();
	const heroBook =
		(await getHeroBook(locals.supabase, locale)) ??
		(await getHeroBook(locals.supabase, locale === 'es' ? 'en' : 'es'));
	return { heroBook };
};
