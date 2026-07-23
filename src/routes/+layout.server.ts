import type { LayoutServerLoad } from './$types';

/**
 * Exposes the signed-in session/user to every page so the layout can render the auth
 * control and pages can tailor guest vs. signed-in behaviour. The session is validated
 * (getUser) inside locals.safeGetSession — never trusted from getSession() alone.
 */
export const load: LayoutServerLoad = async ({ locals }) => {
	const { session, user } = await locals.safeGetSession();
	return { session, user };
};
