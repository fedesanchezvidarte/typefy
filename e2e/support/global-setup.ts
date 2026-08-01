import { createClient } from '@supabase/supabase-js';
import type { Database } from '../../src/lib/database.types';
import { fixtureTexts } from '../../src/lib/fixtures';
import { isLocalStack, localSecretKey, SUPABASE_URL } from './supabase';

/**
 * Put the catalog back to its seeded shape before every run (spec #18, phase 7).
 *
 * ## Why a global setup and not more `afterAll`s
 *
 * Several specs publish probe books and one takes the single featured slot per language, and
 * every one of them already retires what it arranged. That is necessary and not sufficient:
 * teardown only runs if the run reaches it. A crashed worker, a `--grep` that never reaches
 * the owning file, a Ctrl-C, or Playwright's own "did not run" after a bail all leave a
 * PUBLISHED probe book in a world-readable catalog — and the spec that fails next is not the
 * one that leaked. `typing.e2e.ts` pins the grid to exactly the seeded fixtures and
 * `resume-rpc.e2e.ts` pins the featured index, so a leak surfaces as an off-by-one card count
 * or an unexpected unique violation in a FILE THAT NEVER TOUCHED BOOKS. That has already
 * happened here: one aborted run made the next three runs disagree with each other.
 *
 * Cleanup on the way IN is what makes a run independent of how the previous one died.
 * Teardown stays where it is — this is the safety net, not a replacement for it.
 *
 * ## Retire, never delete
 *
 * The ingestion role has no `delete` grant on `books`, deliberately: deleting one cascades
 * away every user's attempts and rollups. Unpublishing is the whole teardown a book gets —
 * the publication policy makes an unpublished book invisible to `anon` and `authenticated`
 * alike, which is exactly what "out of the catalog" means here.
 *
 * ## Local only, and silent when it cannot run
 *
 * Writing books needs the secret key, and no client role may publish one. On a non-local
 * stack, or without the key, this is a no-op: the database specs `test.skip` themselves in
 * the same conditions, so there is nothing to clean and nothing to warn about. It never
 * throws — a setup that fails the whole run over a housekeeping hiccup is worse than the
 * mess it was tidying.
 */
export default async function globalSetup(): Promise<void> {
	if (!isLocalStack) return;
	const secret = localSecretKey();
	if (!secret) return;

	const service = createClient<Database>(SUPABASE_URL, secret, {
		auth: { persistSession: false, autoRefreshToken: false }
	});

	// The seeded fixtures are the catalog's baseline: published, and never featured — nothing
	// in the seed sets `featured`, so a featured fixture is always something a spec left behind.
	const seeded = fixtureTexts.map((text) => text.id);

	const { data, error } = await service.from('books').select('slug');
	if (error) {
		console.warn(`[e2e] global setup could not read the catalog: ${error.message}`);
		return;
	}

	const strays = (data ?? []).map((book) => book.slug).filter((slug) => !seeded.includes(slug));
	if (strays.length > 0) {
		const { error: retired } = await service
			.from('books')
			.update({ published_at: null, featured: false })
			.in('slug', strays);
		if (retired) {
			console.warn(
				`[e2e] global setup could not retire ${strays.length} stray book(s): ${retired.message}`
			);
		} else {
			console.log(`[e2e] retired ${strays.length} stray probe book(s) from a previous run`);
		}
	}

	const { error: unfeatured } = await service
		.from('books')
		.update({ featured: false })
		.in('slug', seeded)
		.eq('featured', true);
	if (unfeatured) {
		console.warn(`[e2e] global setup could not clear the featured flag: ${unfeatured.message}`);
	}
}
