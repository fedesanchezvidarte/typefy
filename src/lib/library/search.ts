import type { TypeableTextSummary } from '$lib/types';

/**
 * The library's `?q` catalog search (spec #25 §2).
 *
 * Pure by construction (`lib-patterns` tier 1): no SvelteKit, no Supabase, no Postgres text
 * search. Matching runs in JS against rows `listBooks` has already fetched — the catalog is
 * 12 rows, `unaccent` is not installed on the project, and enabling it would itself be a
 * migration this feature doesn't need. If the catalog grows to where that matters, that is a
 * future spec's problem with its own measurement.
 */

/**
 * The search query a `?q` parameter carries, or `null` for "no search" — never `''`. A
 * missing, empty, or whitespace-only parameter is "no search", not "zero results": the
 * distinction is what lets the route and the empty-state component tell "nobody searched"
 * apart from "the search matched nothing" (`LibraryEmptyState`'s own guard).
 *
 * Never throws: a query parameter can repeat, arriving as an array, or be absent entirely.
 */
export function parseSearchQuery(raw: unknown): string | null {
	if (typeof raw !== 'string') {
		return null;
	}
	return raw.trim() === '' ? null : raw;
}

/**
 * Folds a string to a case- and accent-insensitive comparison key: Unicode NFD
 * decomposition (splits `é` into `e` + a combining acute accent), strips the combining
 * diacritical marks (`̀`–`ͯ`), then lowercases.
 *
 * Idempotent — normalizing an already-normalized string is a no-op — which is what makes it
 * safe to apply to both sides of a comparison independently.
 */
export function normalizeForSearch(value: string): string {
	return value
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '') // combining diacritical marks block
		.toLowerCase();
}

/**
 * Case- and accent-insensitive substring match against title OR author. `query` is expected
 * to already be a `parseSearchQuery` result (non-null, but may still carry surrounding
 * whitespace — trimmed here so `" quijote "` matches the same as `"quijote"`).
 */
export function matchesSearch(
	book: Pick<TypeableTextSummary, 'title' | 'author'>,
	query: string
): boolean {
	const needle = normalizeForSearch(query.trim());
	if (needle === '') {
		return true;
	}
	return (
		normalizeForSearch(book.title).includes(needle) ||
		normalizeForSearch(book.author).includes(needle)
	);
}
