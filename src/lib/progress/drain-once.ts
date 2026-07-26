import { ATTEMPT_BUFFER_KEY, readAll } from './buffer';
import { getAttemptStorage } from './storage';
import type { DrainResult } from './drain';

/**
 * The drain's single-flight wrapper and its ONE dynamic-import boundary (spec #15 §4).
 *
 * Splitting this off `drain.ts` is what keeps that module pure: everything Supabase-carrying
 * is reached through the `await import()` below, and `$app/navigation` never enters
 * `src/lib/` at all — `invalidateAll()` stays with the caller, which is also what lets the
 * caller honour spec §11's rule that only the mount and `online` triggers may invalidate.
 *
 * This module is itself statically importable and Supabase-free, so a component can wire up
 * a trigger without dragging `@supabase/*` into the entry bundle.
 */

/**
 * The in-flight drain, held at module scope — one per tab, the same `??=` shape
 * `loadProgressModules()` established in `TypingSession.svelte`. Three triggers can fire
 * within a few milliseconds of each other (mount, `online`, a post-write flush), and
 * without this they would replay the same entries concurrently and race each other's
 * removals.
 */
let inFlight: Promise<DrainResult | null> | null = null;

/**
 * Drains the attempt buffer as `userId`, at most once at a time. Concurrent callers join
 * the running drain and receive its result; a caller arriving after it settles starts a
 * fresh one, which is what lets a repeated `online` event pick up entries buffered since.
 *
 * Resolves `null` when there was nothing to do — an empty or unreachable buffer, or a
 * drain that failed outright. **Never rejects**: a drain runs behind the typing path with
 * nobody awaiting it, so a rejection here would surface as an unhandled one.
 *
 * When it did run, the result reports what was written, so the CALLER can decide whether to
 * call `invalidateAll()`. That decision is deliberately not made here (spec §11): on the
 * typing screen invalidating re-runs `safeGetSession()` and re-serialises the whole book
 * text mid-passage, to refresh figures the session has already advanced optimistically.
 *
 * `now` is injectable for tests; it defaults to the wall clock because the trigger points
 * are DOM events, which are already outside the pure layer.
 */
export function drainOnce(userId: string, now: number = Date.now()): Promise<DrainResult | null> {
	return (inFlight ??= run(userId, now).finally(() => {
		inFlight = null;
	}));
}

async function run(userId: string, now: number): Promise<DrainResult | null> {
	const storage = getAttemptStorage(ATTEMPT_BUFFER_KEY);

	// The cheap synchronous gate, deliberately BEFORE the dynamic import: the common case
	// is an empty buffer, and answering "nothing to drain" must not cost a network fetch of
	// the Supabase chunk. This is what preserves the 2b guest bundle guarantee even though
	// the mount trigger runs on every page load.
	if (readAll(storage, now).length === 0) return null;

	try {
		const [{ getBrowserSupabase }, { drainAttemptBuffer }] = await Promise.all([
			import('$lib/supabase/browser'),
			import('./drain')
		]);
		return await drainAttemptBuffer(getBrowserSupabase(), storage, userId, now);
	} catch {
		// A failed chunk fetch or a client that refuses to construct. The buffer is
		// untouched, so the next trigger simply tries again.
		return null;
	}
}
