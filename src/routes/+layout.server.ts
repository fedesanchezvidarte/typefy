import type { LayoutServerLoad } from './$types';
import { FONT_COOKIE, PALETTE_COOKIE, parseFont, parsePalette } from '$lib/theme/theme';

/**
 * Exposes the signed-in session/user to every page so the layout can render the auth
 * control and pages can tailor guest vs. signed-in behaviour. The session is validated
 * (getUser) inside locals.safeGetSession — never trusted from getSession() alone.
 *
 * Also exposes the two theme axes (spec #9) as read from the cookies, so the header
 * switchers can render the current selection on the server pass. `null` means "no
 * explicit choice yet" — the client resolves it from `prefers-color-scheme`.
 */
export const load: LayoutServerLoad = async ({ locals, cookies }) => {
	const { session, user } = await locals.safeGetSession();
	return {
		session,
		user,
		palette: parsePalette(cookies.get(PALETTE_COOKIE)),
		font: parseFont(cookies.get(FONT_COOKIE))
	};
};
