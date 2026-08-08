import type { LanguageFilter } from '$lib/types';

/**
 * The library's content-language filter (spec #19 §4).
 *
 * Pure by construction (`lib-patterns` tier 1): the raw parameter and the UI locale are both
 * arguments, so nothing here imports SvelteKit or Paraglide and nothing under
 * `src/lib/library/` ever reaches into `$lib/server/`.
 */

/** The filter options, in the order the control renders them. */
export const LANGUAGE_FILTERS: readonly LanguageFilter[] = ['en', 'es', 'all'];

/**
 * The filter a `?lang` parameter selects, or `fallback` for anything else — including `null`,
 * an empty string, a different case, an unknown language, and values that are not strings at
 * all because a query parameter can repeat.
 *
 * The fallback is **silent**: a hand-edited or stale link must still open the page, never 400.
 * That is the same posture `?passage=N` already takes.
 */
export function parseLanguageFilter(raw: unknown, fallback: LanguageFilter): LanguageFilter {
	if (typeof raw === 'string' && (LANGUAGE_FILTERS as readonly string[]).includes(raw)) {
		return raw as LanguageFilter;
	}
	return fallback;
}

/**
 * The filter an unparameterised `/type` starts on: the whole library.
 *
 * Deliberately NOT derived from the UI locale (it used to be, via `defaultLanguageFilter`).
 * UI locale and content language are independent by rule (CONTEXT.md), and a locale-derived
 * default hid half the catalogue behind a control a first-time visitor had not noticed yet.
 * Showing everything and letting the reader narrow is the honest starting state; `en`/`es`
 * remain one click away and are still what a shared `?lang=` link restores.
 */
export const DEFAULT_LANGUAGE_FILTER: LanguageFilter = 'all';
