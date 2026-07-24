import type { Handle } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import { createServerClient } from '@supabase/ssr';
import { PUBLIC_SUPABASE_PUBLISHABLE_KEY, PUBLIC_SUPABASE_URL } from '$env/static/public';
import {
	cookieName,
	extractLocaleFromHeader,
	getTextDirection,
	isLocale,
	localizeUrl
} from '$lib/paraglide/runtime';
import { paraglideMiddleware } from '$lib/paraglide/server';
import {
	FONT_COOKIE,
	PALETTE_COOKIE,
	parseFont,
	parsePalette,
	themeHtmlAttributes
} from '$lib/theme/theme';

/**
 * Request-scoped Supabase client (@supabase/ssr), bound to the request cookies so a
 * session (once auth lands) survives across requests. Runs first in the sequence: the
 * locale negotiation below will, from Phase 2a's auth work on, read a signed-in user's
 * profile locale, which needs the session this handle establishes.
 *
 * `safeGetSession` validates the JWT with getUser() and never trusts getSession() alone.
 */
const handleSupabase: Handle = async ({ event, resolve }) => {
	event.locals.supabase = createServerClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
		cookies: {
			getAll: () => event.cookies.getAll(),
			setAll: (cookiesToSet) => {
				for (const { name, value, options } of cookiesToSet) {
					event.cookies.set(name, value, { ...options, path: '/' });
				}
			}
		}
	});

	event.locals.safeGetSession = async () => {
		const {
			data: { session }
		} = await event.locals.supabase.auth.getSession();
		if (!session) {
			return { session: null, user: null };
		}
		const {
			data: { user },
			error
		} = await event.locals.supabase.auth.getUser();
		if (error) {
			return { session: null, user: null }; // JWT failed validation
		}
		return { session, user };
	};

	return resolve(event, {
		// @supabase/ssr needs these response headers preserved through SvelteKit.
		filterSerializedResponseHeaders: (name) =>
			name === 'content-range' || name === 'x-supabase-api-version'
	});
};

/**
 * First-visit UI language negotiation (spec #3).
 *
 * The URL is authoritative for the rendered page (`/` = EN unprefixed, `/es` = ES).
 * This hook only decides where document requests to unprefixed URLs land, following
 * the priority: signed-in profile locale > saved cookie > Accept-Language > EN.
 *
 * A null `profiles.locale` means "no explicit preference", so the cookie and
 * Accept-Language tiers still apply. Guests never pay for the profile lookup: with no
 * session cookie, getSession() returns null without a network call.
 *
 * The Paraglide locale governs UI strings only; the language of typeable text content
 * is data and is fully independent of the UI locale.
 */
async function getProfileLocale(event: Parameters<Handle>[0]['event']): Promise<string | null> {
	const { user } = await event.locals.safeGetSession();
	if (!user) {
		return null;
	}
	const { data } = await event.locals.supabase
		.from('profiles')
		.select('locale')
		.eq('id', user.id)
		.maybeSingle();
	return data?.locale ?? null;
}

const handleLocaleNegotiation: Handle = async ({ event, resolve }) => {
	const { request, url } = event;

	const isDocumentRequest =
		request.method === 'GET' &&
		(request.headers.get('sec-fetch-dest') === 'document' ||
			(request.headers.get('accept') ?? '').includes('text/html'));
	const hasLocalePrefix = /^\/es(?:\/|$)/.test(url.pathname);
	// /auth/* must never be locale-rewritten: the OAuth callback is a document GET, and a
	// 302 to /es/auth/callback would break the redirect chain / PKCE exchange (spec #7).
	const isAuthRoute = url.pathname.startsWith('/auth/');

	if (isDocumentRequest && !hasLocalePrefix && !isAuthRoute) {
		const profileLocale = await getProfileLocale(event);
		const cookieLocale = event.cookies.get(cookieName);
		const locale = isLocale(profileLocale)
			? profileLocale
			: isLocale(cookieLocale)
				? cookieLocale
				: (extractLocaleFromHeader(request) ?? 'en');

		if (locale !== 'en') {
			return new Response(null, {
				status: 302,
				headers: {
					location: localizeUrl(url.href, { locale }).href,
					vary: 'accept-language, cookie'
				}
			});
		}
	}

	return resolve(event);
};

const handleParaglide: Handle = ({ event, resolve }) =>
	paraglideMiddleware(event.request, ({ request, locale }) => {
		event.request = request;

		// Theme axes (spec #9): stamp validated cookie choices onto <html> before
		// paint, so a chosen palette/font never flashes the default. No cookie →
		// empty replacement → CSS prefers-color-scheme picks the initial default.
		const themeAttributes = themeHtmlAttributes(
			parsePalette(event.cookies.get(PALETTE_COOKIE)),
			parseFont(event.cookies.get(FONT_COOKIE))
		);

		return resolve(event, {
			transformPageChunk: ({ html }) =>
				html
					.replace('%paraglide.lang%', locale)
					.replace('%paraglide.dir%', getTextDirection(locale))
					.replace('%typefy.theme%', themeAttributes)
		});
	});

export const handle: Handle = sequence(handleSupabase, handleLocaleNegotiation, handleParaglide);
