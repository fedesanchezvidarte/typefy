import type { LanguageFilter } from '$lib/types';
import type { BookSort } from './sort.js';

/**
 * The library's resolved URL state (spec #25 §2): the three composable controls
 * (`?lang`, `?q`, `?sort`) after parsing/fallback, exactly what `LibraryPageData` carries.
 */
export interface LibraryQueryState {
	language: LanguageFilter;
	query: string | null;
	sort: BookSort;
}

/**
 * Builds `/type?lang=..&sort=..[&q=..]` from a full state.
 *
 * This is the ONE place a library URL is built. Every control (`LanguageFilter`,
 * `SearchInput`, `SortControl`, `LibraryEmptyState`'s reset link) calls this rather than
 * concatenating a query string itself — otherwise a component that only owns one control
 * could silently drop one of the other two on navigation (e.g. changing language dropping an
 * active search).
 *
 * Always explicit about `lang` and `sort` (mirrors `LanguageFilter`'s existing "explicit,
 * default included" rule — `all`/`'default'` are real, reachable choices, not an absence).
 * `q` is omitted only when `query` is `null` or empty — never a dangling `&q=`.
 */
export function libraryHref(state: LibraryQueryState): string {
	const params = new URLSearchParams();
	params.set('lang', state.language);
	params.set('sort', state.sort);
	if (state.query !== null && state.query !== '') {
		params.set('q', state.query);
	}
	return `/type?${params.toString()}`;
}
