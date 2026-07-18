/**
 * Phase 1 hardcoded typeable texts (spec #5). Replaced by database reads
 * (ADR-0006 `books` + `chunks`) in Phase 2 — consumers depend only on the
 * `TypeableText` shape, never on these constants being hardcoded.
 */
import type { TypeableText } from '$lib/types';
import { prideAndPrejudiceExcerpt } from './en';
import { donQuijoteExcerpt } from './es';

export { prideAndPrejudiceExcerpt } from './en';
export { donQuijoteExcerpt } from './es';

/** All Phase 1 texts, in picker order. Content language is independent of the UI locale. */
export const fixtureTexts: readonly TypeableText[] = [prideAndPrejudiceExcerpt, donQuijoteExcerpt];

export function getFixtureText(id: string): TypeableText | undefined {
	return fixtureTexts.find((text) => text.id === id);
}
