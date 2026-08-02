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
 * The filter to start from for a UI locale — a guess that saves a visitor a click, never a
 * stored preference and never a constraint (`all` is always reachable).
 *
 * Written as an **explicit mapping** rather than `locale as LanguageFilter`, even though the
 * two vocabularies coincide on `en` and `es` today. UI locale and content language are
 * independent by rule (CONTEXT.md); an assignment would quietly encode the coincidence as an
 * identity, and the next locale to be added would inherit a filter that does not exist.
 */
export function defaultLanguageFilter(locale: string): LanguageFilter {
	switch (locale) {
		case 'es':
			return 'es';
		case 'en':
			return 'en';
		default:
			return 'en';
	}
}
