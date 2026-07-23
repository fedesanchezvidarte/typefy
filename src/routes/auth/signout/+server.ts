import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/**
 * Signs the user out (spec #7): clears the session cookies via the server client, then
 * returns to the locale-aware page they were on.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	const form = await request.formData();
	const next = form.get('next')?.toString() ?? '/';
	const safeNext = next.startsWith('/') ? next : '/';

	await locals.supabase.auth.signOut();
	redirect(303, safeNext);
};
