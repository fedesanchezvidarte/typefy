import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/**
 * Profile stub (Phase 5a, spec #30 §2): signed-in-only. A guest hitting this route directly
 * is bounced to `/` — mirrors the `locals.safeGetSession` guard pattern the rest of the app
 * uses (e.g. the library/progress endpoints), rather than rendering an empty/broken page.
 */
export const load: PageServerLoad = async ({ locals }) => {
	const { user } = await locals.safeGetSession();
	if (!user) {
		redirect(303, '/');
	}
	return { user };
};
