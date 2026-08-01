import type { PageServerLoad } from './$types';
import { getLocale } from '$lib/paraglide/runtime';
import { getHeroBook } from '$lib/server/books';

/**
 * The landing hero's typeable text (spec #9, #18 §7): the **featured** book in the UI
 * locale's content language, so the ES landing greets you with Cervantes and the EN one
 * with Austen. The hero passage is real content from the database — never copy.
 *
 * Which book that is, is now a curated fact (`books.featured`, written from the manifest by
 * the ingestion script) rather than an accident of the catalog: the old rule picked the
 * alphabetically-first title, so publishing a book named "A…" silently moved the hero.
 *
 * Only the FIRST chunk is read — `getHeroBook` returns a genuine one-passage typeable text
 * with `chunkCount: 1`, which is what the hero's loop-on-finish behaviour depends on.
 *
 * Falls back to the other language before giving up, so a locale with no featured book
 * renders a hero rather than an error; the hero is omitted only if neither language has
 * one. No featured book anywhere is a missing hero, never a 500.
 */
export const load: PageServerLoad = async ({ locals }) => {
	const locale = getLocale();
	const heroBook =
		(await getHeroBook(locals.supabase, locale)) ??
		(await getHeroBook(locals.supabase, locale === 'es' ? 'en' : 'es'));
	return { heroBook };
};
