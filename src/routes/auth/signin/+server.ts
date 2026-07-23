import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/**
 * Starts the Google OAuth flow server-side (spec #7). signInWithOAuth stores the PKCE
 * verifier in a cookie (via the @supabase/ssr server client) and returns the provider
 * URL; we redirect the browser there. `next` — the locale-aware path the user came from —
 * rides on the callback URL so we can return them to it afterwards.
 */
export const POST: RequestHandler = async ({ locals, url, request }) => {
	const form = await request.formData();
	const next = form.get('next')?.toString() ?? '/';
	const safeNext = next.startsWith('/') ? next : '/'; // never redirect off-site

	const { data, error } = await locals.supabase.auth.signInWithOAuth({
		provider: 'google',
		options: {
			redirectTo: `${url.origin}/auth/callback?next=${encodeURIComponent(safeNext)}`
		}
	});

	if (error || !data.url) {
		redirect(303, safeNext); // could not start sign-in: return where they were
	}
	redirect(303, data.url);
};
