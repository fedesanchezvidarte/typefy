import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/**
 * OAuth callback (spec #7): Supabase redirects here with a `code`; exchange it for a
 * session (the @supabase/ssr server client reads the PKCE verifier cookie and writes the
 * session cookies), then return the user to where they started. This route is excluded
 * from locale negotiation in hooks.server.ts so the redirect chain never rewrites it.
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	const code = url.searchParams.get('code');
	const next = url.searchParams.get('next') ?? '/';
	const safeNext = next.startsWith('/') ? next : '/';

	if (code) {
		const { error } = await locals.supabase.auth.exchangeCodeForSession(code);
		if (!error) {
			redirect(303, safeNext);
		}
	}
	// No code, or the exchange failed: send them back rather than stranding them here.
	redirect(303, safeNext);
};
