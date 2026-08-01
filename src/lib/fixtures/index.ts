/**
 * Hardcoded typeable texts, seeded into the database by `npm run db:seed:generate`.
 *
 * Phase 1 (spec #5) wrote the first two as the app's only content; Phase 2 replaced them as
 * the *source* of typeable text with database reads (ADR-0006), and consumers depend only on
 * the `TypeableText` shape. They remain as the deterministic seed every `db:reset` and every
 * E2E run gets.
 *
 * Phase 3a (spec #17) adds a third, deliberately short one: the real catalog is ingested from
 * public-domain sources into a database these fixtures never touch, so the fixtures' job is now
 * exactly the edges a full-length book cannot test cheaply — see `tortoise.ts`.
 */
import type { TypeableText } from '$lib/types';
import { prideAndPrejudiceExcerpt } from './en';
import { donQuijoteExcerpt } from './es';
import { tortoiseAndHare } from './tortoise';

export { prideAndPrejudiceExcerpt } from './en';
export { donQuijoteExcerpt } from './es';
export { tortoiseAndHare } from './tortoise';

/** All seeded texts, in picker order. Content language is independent of the UI locale. */
export const fixtureTexts: readonly TypeableText[] = [
	prideAndPrejudiceExcerpt,
	donQuijoteExcerpt,
	tortoiseAndHare
];

export function getFixtureText(id: string): TypeableText | undefined {
	return fixtureTexts.find((text) => text.id === id);
}
