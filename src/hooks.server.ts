import type { Handle } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import {
	cookieName,
	extractLocaleFromHeader,
	getTextDirection,
	isLocale,
	localizeUrl
} from '$lib/paraglide/runtime';
import { paraglideMiddleware } from '$lib/paraglide/server';

/**
 * First-visit UI language negotiation (spec #3).
 *
 * The URL is authoritative for the rendered page (`/` = EN unprefixed, `/es` = ES).
 * This hook only decides where document requests to unprefixed URLs land, following
 * the priority: saved cookie > Accept-Language > EN (base locale).
 *
 * The Paraglide locale governs UI strings only; the language of typeable text content
 * is data and is fully independent of the UI locale.
 */
const handleLocaleNegotiation: Handle = ({ event, resolve }) => {
	const { request, url } = event;

	const isDocumentRequest =
		request.method === 'GET' &&
		(request.headers.get('sec-fetch-dest') === 'document' ||
			(request.headers.get('accept') ?? '').includes('text/html'));
	const hasLocalePrefix = /^\/es(?:\/|$)/.test(url.pathname);

	if (isDocumentRequest && !hasLocalePrefix) {
		const cookieLocale = event.cookies.get(cookieName);
		const locale = isLocale(cookieLocale)
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

		return resolve(event, {
			transformPageChunk: ({ html }) =>
				html
					.replace('%paraglide.lang%', locale)
					.replace('%paraglide.dir%', getTextDirection(locale))
		});
	});

export const handle: Handle = sequence(handleLocaleNegotiation, handleParaglide);
