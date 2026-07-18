import type { Locale as _Locale } from '$lib/paraglide/runtime';
import { browser } from '$app/environment';
import { page } from '$app/state';

import {
	baseLocale,
	cookieMaxAge,
	cookieName,
	localizeUrl,
	overwriteGetLocale,
	overwriteSetLocale,
	toLocale
} from '$lib/paraglide/runtime';

export class Locale {
	#current: _Locale = $state(
		toLocale(browser && document.querySelector('html')?.lang) ?? baseLocale
	);

	constructor() {
		overwriteGetLocale(() => this.#current);

		overwriteSetLocale((locale) => {
			// Persist the preference: saved cookie > Accept-Language > EN
			// (the server-side negotiation lives in hooks.server.ts).
			document.cookie = `${cookieName}=${locale}; path=/; max-age=${cookieMaxAge}; samesite=lax`;
			// Full navigation so the server re-renders with the correct
			// <html lang> / dir and Paraglide locale.
			window.location.href = localizeUrl(page.url.pathname, { locale }).href;
		});
	}
}
