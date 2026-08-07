import { isMode, type Mode } from '$lib/types';

/**
 * Mode persistence (spec #24 §10): one cookie, written client-side by the toggle and read
 * server-side by the typing route's load.
 *
 * **This module deliberately mirrors `src/lib/theme/theme.ts`'s CONTRACT without being part
 * of it** — the spec asks for the theme cookie contract, not the theme module, and the
 * distinction is load-bearing:
 *
 * 1. §1 forbids mode accumulating a second meaning, and `theme.ts` is where the PRESENTATION
 *    axes live. A `Mode` sitting next to `PaletteId` and `FontId` invites the next reader to
 *    add `data-mode` to `themeHtmlAttributes` and give mode a look — precisely the error §1
 *    calls the one "most likely to be helpfully undone later" (ADR-0011's discipline: palette
 *    and typeface are two axes, not one enum of combinations; a future page-view presentation
 *    is a third axis added BESIDE mode, never a third value inside it). Living here makes that
 *    a cross-module change rather than a two-line one. A guardrail, not a wall.
 * 2. Mode is read in `src/routes/type/[slug]/+page.server.ts`, NOT in `hooks.server.ts`. There
 *    is no FOUC to prevent: nothing about the document chrome depends on mode. What §10
 *    actually protects against is rendering a metrics row and stripping it on hydration, and a
 *    `+page.server.ts` read fixes that at the same first paint. A hook read would put a cookie
 *    parse on every route for a value exactly one route uses, and would then need `locals`
 *    plumbing to reach the component.
 *
 * The contract itself is followed verbatim: one cookie, `path=/`, one-year max-age,
 * `SameSite=Lax`, client-written and server-read, guests and signed-in users identical, no
 * profile column and no precedence rule. **No cookie means "no explicit choice", and the
 * default — `normal` — applies**; that fallback is the caller's `?? 'normal'`, so `parseMode`
 * can keep saying "nothing valid here" without inventing a choice the user never made.
 *
 * The max-age constant is duplicated (one number) rather than imported from `theme.ts`: an
 * import would couple the measurement axis to the theming axes for the sake of a literal, and
 * coupling is the thing this module exists not to have.
 *
 * It imports nothing from `@supabase/*`, and must not: it is reached from the typing screen,
 * where a guest's zero-Supabase-bytes guarantee (spec §12) holds.
 */

export const MODE_COOKIE = 'typefy-mode';

/** One year — a preference, not a session. */
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/**
 * The cookie value narrowed to a `Mode`, or `null` for absent, empty or unrecognised.
 *
 * Junk is silently ignored rather than reported, in the same spirit as the route's
 * `?passage=N` handling: a hand-edited or stale cookie must still open the book, and the only
 * honest reading of a value outside the axis is that no explicit choice was made.
 */
export function parseMode(value: string | undefined | null): Mode | null {
	return isMode(value) ? value : null;
}

/** Client-side cookie write for the mode axis (SameSite=Lax, path=/). */
export function modeCookie(value: Mode): string {
	return `${MODE_COOKIE}=${value}; path=/; max-age=${COOKIE_MAX_AGE_SECONDS}; samesite=lax`;
}
