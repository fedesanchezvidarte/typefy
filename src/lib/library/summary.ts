import type { Json } from '$lib/database.types';
import type { Locale, SummaryByLocale } from '$lib/types';

/**
 * Per-locale book summaries (spec #34): the single place `books.summary`'s raw `Json` becomes
 * a validated `string | null`.
 *
 * Pure by construction (`lib-patterns` tier 1): the locale is an explicit argument rather than
 * a `getLocale()` call, so nothing here imports Paraglide or SvelteKit — the same posture
 * `sort.ts` and `language-filter.ts` already take, and the reason this lives beside them in
 * `library/` rather than in the Supabase-facing service.
 */

/**
 * The summary to render for `locale`, or `null` when this book has none:
 * `summary[locale] ?? summary.default ?? null`.
 *
 * `default` is Open Library's description, whose language is unverified — it is the fallback
 * for EVERY locale, which is why it is not stored under `'en'`. A locale key always wins.
 *
 * **Nothing here throws, and that is the contract, not leniency.** The column is `jsonb` and
 * the generated types give `Json`, so the shape is unenforced at the boundary beyond a
 * `jsonb_typeof = 'object'` check. A non-object, an array, a non-string value, and an
 * empty-or-whitespace string all resolve as *absent*: a malformed row must render a screen
 * without a summary panel, not a 500. Absent means "keep looking", so an unusable locale value
 * still falls through to `default`.
 *
 * The result is trimmed — an ingested blurb can carry trailing whitespace, and nothing
 * downstream should have to know that.
 */
export function resolveSummary(summary: Json | SummaryByLocale, locale: Locale): string | null {
	if (typeof summary !== 'object' || summary === null || Array.isArray(summary)) {
		return null;
	}
	const map = summary as Record<string, unknown>;
	return usable(map[locale]) ?? usable(map.default);
}

/** The value as a rendered summary, or `null` if it cannot be one. */
function usable(value: unknown): string | null {
	if (typeof value !== 'string') {
		return null;
	}
	const trimmed = value.trim();
	return trimmed === '' ? null : trimmed;
}
