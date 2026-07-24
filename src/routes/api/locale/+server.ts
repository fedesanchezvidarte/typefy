import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

const LOCALES = ['en', 'es'] as const;

/**
 * Persists a signed-in user's UI language to profiles.locale (spec #7), so the choice
 * follows them across devices. The row is identified by the session's user — a
 * client-supplied id is never trusted — and RLS scopes the update to auth.uid() = id.
 *
 * Guests get 401 and simply keep the cookie-based preference.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	const { user } = await locals.safeGetSession();
	if (!user) {
		error(401, 'Not signed in');
	}

	const body = await request.json().catch(() => null);
	const locale = (body as { locale?: string } | null)?.locale;
	if (!locale || !(LOCALES as readonly string[]).includes(locale)) {
		error(400, 'Unsupported locale');
	}

	const { error: dbError } = await locals.supabase
		.from('profiles')
		.update({ locale })
		.eq('id', user.id);
	if (dbError) {
		error(500, 'Could not save the language preference');
	}

	return json({ ok: true });
};
