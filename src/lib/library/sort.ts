import type { TypeableTextSummary } from '$lib/types';

/**
 * The library's `?sort` catalog ordering (spec #25 §2).
 *
 * Pure by construction (`lib-patterns` tier 1): `sortBooks` takes the locale as an explicit
 * argument rather than reading it from Paraglide, so nothing here imports SvelteKit or
 * Paraglide and nothing under `src/lib/library/` ever reaches into `$lib/server/` — same
 * posture as `language-filter.ts`.
 */

/** The sort options, in the order the control renders them. */
export const BOOK_SORTS = ['default', 'title', 'length'] as const;

export type BookSort = (typeof BOOK_SORTS)[number];

/**
 * The sort a `?sort` parameter selects, or `'default'` for anything else — including `null`,
 * an empty string, a different case, and values that are not strings at all because a query
 * parameter can repeat.
 *
 * The fallback is **silent**, mirroring `parseLanguageFilter`'s posture: a hand-edited or
 * stale link must still open the page, never 400.
 */
export function parseBookSort(raw: unknown): BookSort {
	if (typeof raw === 'string' && (BOOK_SORTS as readonly string[]).includes(raw)) {
		return raw as BookSort;
	}
	return 'default';
}

/**
 * Orders `books` for display:
 * - `'default'`: no-op — preserves `listBooks`' own order (language, then title).
 * - `'title'`: locale-aware collation (`Intl.Collator(locale, { sensitivity: 'base' })`), so
 *   accents and case never split an otherwise-identical title apart.
 * - `'length'`: ascending by `chunkCount` — shortest passage count first.
 *
 * Always returns a NEW array, never mutates `books` — `books` may be a value the caller (the
 * route's load function) reuses elsewhere (e.g. `selectContinueReading`).
 */
export function sortBooks(
	books: readonly TypeableTextSummary[],
	sort: BookSort,
	locale: string
): TypeableTextSummary[] {
	switch (sort) {
		case 'title': {
			const collator = new Intl.Collator(locale, { sensitivity: 'base' });
			return [...books].sort((a, b) => collator.compare(a.title, b.title));
		}
		case 'length':
			return [...books].sort((a, b) => a.chunkCount - b.chunkCount);
		default:
			return [...books];
	}
}
