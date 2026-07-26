import { expect, guestTest, test } from './fixtures/auth';
import { isLocalStack, readSeededBook, SUPABASE_URL, type AnyClient } from './support/supabase';
import type { Page } from '@playwright/test';
// Imported, never duplicated: the tests type the exact strings the app renders, and address
// the exact key the app stores under. The fixture id IS the `books.slug`.
import { prideAndPrejudiceExcerpt } from '../src/lib/fixtures/en';
import { ATTEMPT_BUFFER_KEY, type BufferedChunkAttempt } from '../src/lib/progress/buffer';

/**
 * The three end-to-end criteria of spec #15 — the ones no unit or component test can reach,
 * because each is about a transition the browser itself makes: guest → signed in, online →
 * offline → online, and user A → user B in one browser profile.
 *
 * What the units already prove is deliberately not re-litigated here. `buffer.spec.ts`,
 * `drain.spec.ts` and `drain-once.spec.ts` own the buffer's rules, the attribution invariant
 * and single flight; `layout-drain.svelte.spec.ts` owns which trigger calls `invalidateAll`.
 * These tests exist to prove those parts are wired to a real session, a real `localStorage`
 * and a real `chunk_attempts` table.
 *
 * They mint throwaway users, so they refuse to run against anything but a local stack.
 */

const BOOK_SLUG = prideAndPrejudiceExcerpt.id;
/** The first passage, and the last — the last is what finishes a session and shows the summary. */
const CHUNK_FIRST = prideAndPrejudiceExcerpt.chunks[0].content;
const CHUNK_LAST = prideAndPrejudiceExcerpt.chunks[5].content;
const PASSAGE_COUNT = prideAndPrejudiceExcerpt.chunks.length;

const META = 'passage-meta';

/** Every Supabase write of an attempt, live or backfilled, goes through this path. */
const CHUNK_ATTEMPTS_ROUTE = /\/rest\/v1\/chunk_attempts/;

/** The attempt buffer exactly as the browser holds it. Malformed storage reads as empty. */
async function readBuffer(page: Page): Promise<BufferedChunkAttempt[]> {
	const raw = await page.evaluate((key) => localStorage.getItem(key), ATTEMPT_BUFFER_KEY);
	if (raw === null) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? (parsed as BufferedChunkAttempt[]) : [];
	} catch {
		return [];
	}
}

/** This client's own `chunk_attempts` rows for one chunk, read back through its own RLS. */
async function attemptsForChunk(client: AnyClient, chunkId: string) {
	const { data, error } = await client
		.from('chunk_attempts')
		.select('chunk_id, user_id, started_at, created_at, completed')
		.eq('chunk_id', chunkId);
	expect(error, `reading chunk_attempts failed: ${error?.message}`).toBeNull();
	return data ?? [];
}

/**
 * Type one whole passage through the OS-level keyboard path.
 *
 * The focus wait is not decoration: the typing surface focuses its hidden input from an
 * attachment after hydration, and keystrokes sent before that land on `<body>` and are lost
 * silently — the passage simply does not advance, which reads as a product bug rather than
 * as the race it is.
 */
async function typePassage(page: Page, text: string): Promise<void> {
	await expect(page.getByTestId('typing-input')).toBeFocused();
	await page.keyboard.type(text, { delay: 0 });
}

/**
 * Fetch the lazily-imported Supabase chunk before the test takes the network away.
 *
 * **This works around a real defect, and the workaround is deliberate rather than
 * incidental.** `TypingSession.saveAttempt` opens with `await loadProgressModules()` and is
 * called as `void saveAttempt(...)`. If the chunk has not been fetched by the time
 * connectivity goes, that import rejects, the rejection is unhandled, and the completion is
 * neither saved, nor counted in `failedSaves`, nor buffered — the one outcome spec #15 §3
 * exists to rule out. Verified by removing this call: the summary shows no pending notice,
 * the buffer stays empty, and the console carries `TypeError: Failed to fetch dynamically
 * imported module: /src/lib/supabase/browser.ts`.
 *
 * Reported, not fixed here (Phase 7 may not touch production code). Until it is fixed, the
 * offline test covers the case a user who has already typed a keystroke while online is in —
 * which is the ordinary one, since the import is started on the session's first keystroke.
 * One keystroke, undone with the passage restart the UI already offers, is the smallest way
 * to reach that state.
 */
async function warmUpWritePath(page: Page): Promise<void> {
	await page.keyboard.press('t');
	await page.waitForLoadState('networkidle');
	await page.getByTestId('restart-chunk').click();
	await expect(page.getByTestId('typing-input')).toBeFocused();
}

test.describe('offline → online: a completed passage is pending, then lands', () => {
	test.skip(
		!isLocalStack,
		`refusing to create throwaway users against a non-local Supabase (${SUPABASE_URL})`
	);

	test('a passage completed offline shows the pending notice and is written when connectivity returns', async ({
		page,
		context,
		authUser
	}) => {
		// ~440 real keystrokes through the OS-level keyboard path.
		test.setTimeout(180_000);
		const book = await readSeededBook(authUser.client, BOOK_SLUG);
		const lastChunkId = book.chunkIds[PASSAGE_COUNT - 1];

		// The LAST passage, so completing it finishes the session and the summary — the one
		// surface that states a pending save — actually renders.
		await page.goto(`/type/${BOOK_SLUG}?passage=${PASSAGE_COUNT}`);
		await expect(page.getByTestId(META)).toContainText(
			`Passage ${PASSAGE_COUNT} of ${book.chunkCount}`
		);
		await expect(page.getByTestId('typing-input')).toBeFocused();
		await warmUpWritePath(page);

		await context.setOffline(true);
		await typePassage(page, CHUNK_LAST);

		// Pending, not lost: the passage is buffered, and the summary says so in as many words.
		await expect(page.getByTestId('summary-save-pending')).toHaveText(
			"One passage will be saved when you're back online."
		);
		await expect(page.getByTestId('summary-save-failures')).toHaveCount(0);

		// Buffered under the user who typed it — not as guest-authored: they held a session,
		// the write merely failed.
		await expect.poll(() => readBuffer(page)).toHaveLength(1);
		const [buffered] = await readBuffer(page);
		expect(buffered.userId).toBe(authUser.id);
		expect(buffered.chunkId).toBe(lastChunkId);
		expect(buffered.completed).toBe(true);
		// Nothing reached the database while the network was gone.
		expect(await attemptsForChunk(authUser.client, lastChunkId)).toHaveLength(0);

		await context.setOffline(false);

		// The `online` trigger drains it. Polled rather than waited on: the drain is
		// fire-and-forget behind the page, exactly as it is in production.
		await expect
			.poll(() => attemptsForChunk(authUser.client, lastChunkId), {
				message: 'the buffered attempt should have been written once connectivity returned'
			})
			.toHaveLength(1);
		const [attempt] = await attemptsForChunk(authUser.client, lastChunkId);
		expect(attempt.user_id).toBe(authUser.id);
		expect(attempt.completed).toBe(true);
		// `started_at` is the genuine first keystroke, from before the reconnect; `created_at`
		// is the drain instant (the ADR-0010 amendment's stated consequence).
		expect(Date.parse(attempt.started_at)).toBeLessThan(Date.parse(attempt.created_at));

		// The entry is gone only because its write was acknowledged.
		await expect.poll(() => readBuffer(page)).toEqual([]);

		// And the backfill is visible where a user would look for it.
		const percent = Math.round((100 * 1) / book.chunkCount);
		await page.goto('/type');
		await expect(page.getByTestId(`text-picker-option-${BOOK_SLUG}`)).toContainText(`${percent}%`);
	});
});

guestTest.describe('guest → sign-in: the completed passages backfill', () => {
	guestTest.skip(
		!isLocalStack,
		`refusing to create throwaway users against a non-local Supabase (${SUPABASE_URL})`
	);

	guestTest(
		'passages typed as a guest show as completed progress after signing in',
		async ({ page, mintUser, session }) => {
			// ~815 real keystrokes across two passages.
			guestTest.setTimeout(240_000);
			const user = await mintUser();
			const book = await readSeededBook(user.client, BOOK_SLUG);

			// ── As a guest ────────────────────────────────────────────────────────────────
			await page.goto(`/type/${BOOK_SLUG}`);
			await expect(page.getByTestId(META)).toContainText(`Passage 1 of ${book.chunkCount}`);
			await typePassage(page, CHUNK_FIRST);
			await expect(page.getByTestId(META)).toContainText(`Passage 2 of ${book.chunkCount}`);
			await expect.poll(() => readBuffer(page)).toHaveLength(1);

			// The last passage too, in a second session, so the summary and its sign-in prompt —
			// the conversion surface this whole feature exists to make honest — actually render.
			await page.goto(`/type/${BOOK_SLUG}?passage=${PASSAGE_COUNT}`);
			await typePassage(page, CHUNK_LAST);
			await expect(page.getByTestId('session-summary')).toBeVisible();

			// The prompt counts THIS session's passage, and it is count-aware because the buffer
			// is what makes the promise keepable.
			await expect(page.getByTestId('summary-sign-in-prompt')).toContainText(
				'Sign in to save the passage you just typed'
			);
			// Both passages are buffered, guest-authored: attributable to whoever signs in next.
			const buffered = await readBuffer(page);
			expect(buffered).toHaveLength(2);
			expect(buffered.map((entry) => entry.userId)).toEqual([null, null]);
			expect(buffered.map((entry) => entry.chunkId)).toEqual([
				book.chunkIds[0],
				book.chunkIds[PASSAGE_COUNT - 1]
			]);

			// ── Signing in ────────────────────────────────────────────────────────────────
			// The prompt posts to the app's only sign-in, which is Google OAuth and cannot be
			// driven from a test. What the test asserts is that the prompt IS that form, and then
			// reproduces the outcome `/auth/callback` produces — the same `@supabase/ssr` session
			// cookies, followed by the same full page load a returning OAuth user arrives on.
			// See the note in `fixtures/auth.ts` for what that does and does not cover.
			await expect(page.getByTestId('summary-sign-in-prompt')).toHaveAttribute(
				'action',
				'/auth/signin'
			);
			await session.signInAs(user);
			await page.goto('/type');

			// ── Back, signed in ───────────────────────────────────────────────────────────
			const percent = Math.round((100 * 2) / book.chunkCount);
			// The card catches up without a manual reload: the mount drain wrote, so it
			// invalidated (spec §11). Polled through Playwright's own retry, not slept on.
			await expect(
				page.getByTestId(`text-picker-option-${BOOK_SLUG}`),
				'the library card should reflect the backfilled passages'
			).toContainText(`${percent}%`);

			// Both attempts are real rows, under the signing-in user, with the genuine
			// first-keystroke timestamps from when they were typed as a guest.
			for (const chunkId of [book.chunkIds[0], book.chunkIds[PASSAGE_COUNT - 1]]) {
				const attempts = await attemptsForChunk(user.client, chunkId);
				expect(attempts, `passage ${chunkId} should have backfilled`).toHaveLength(1);
				expect(attempts[0].user_id).toBe(user.id);
				expect(Date.parse(attempts[0].started_at)).toBeLessThan(Date.parse(attempts[0].created_at));
			}
			await expect.poll(() => readBuffer(page)).toEqual([]);

			// The typing screen agrees, and resume has advanced past the passage the guest typed:
			// passage 1 is complete, so the lowest incomplete index is passage 2.
			await page.goto(`/type/${BOOK_SLUG}`);
			await expect(page.getByTestId(META)).toContainText(`Passage 2 of ${book.chunkCount}`);
			await expect(page.getByTestId(META)).toContainText(`${percent}%`);
		}
	);
});

guestTest.describe('A → B: one browser, two users', () => {
	guestTest.skip(
		!isLocalStack,
		`refusing to create throwaway users against a non-local Supabase (${SUPABASE_URL})`
	);

	guestTest(
		'a second user never inherits the first user’s buffered entries',
		async ({ page, mintUser, session }) => {
			// ~800 real keystrokes across two passages.
			guestTest.setTimeout(240_000);
			const [userA, userB] = [await mintUser(), await mintUser()];
			const book = await readSeededBook(userA.client, BOOK_SLUG);
			const guestChunkId = book.chunkIds[0];
			const ownedChunkId = book.chunkIds[1];

			// ── A guest-authored entry, so the drain has something it MAY write ───────────
			// It doubles as the test's synchronisation point: when B's copy of this row appears,
			// B's drain has demonstrably run, which is what makes the absence of A's entry below
			// a real assertion rather than a race the test happened to win.
			await page.goto(`/type/${BOOK_SLUG}`);
			await typePassage(page, CHUNK_FIRST);
			await expect.poll(() => readBuffer(page)).toHaveLength(1);

			// ── A signed-in-authored entry, from A, buffered by a failing write ───────────
			// Only `chunk_attempts` is blocked, so pages, modules and auth still work — which is
			// what lets the test navigate between sessions while writes keep failing. An aborted
			// request is postgrest-js's `status: 0`, i.e. transient, i.e. buffered.
			await page.route(CHUNK_ATTEMPTS_ROUTE, (route) => route.abort());

			await session.signInAs(userA);
			await page.goto(`/type/${BOOK_SLUG}?passage=2`);
			await expect(page.getByTestId(META)).toContainText(`Passage 2 of ${book.chunkCount}`);
			// A's mount drain fired on the guest entry and failed transiently, so that entry is
			// still standing — nothing was lost by trying.
			await expect.poll(() => readBuffer(page)).toHaveLength(1);

			// No warm-up needed here: A's mount drain has already fetched the Supabase chunk, and
			// the network is up throughout — only `chunk_attempts` is refused.
			await typePassage(page, prideAndPrejudiceExcerpt.chunks[1].content);

			await expect
				.poll(async () => (await readBuffer(page)).map((entry) => entry.userId))
				.toEqual([null, userA.id]);

			// ── B takes over the browser, with A's entry still in the buffer ──────────────
			// Deliberately WITHOUT a guest page load in between. Sign-out hygiene (§5) would have
			// dropped A's entry, and then this test would be exercising that rule instead of the
			// attribution invariant (§4) it is named for. This is the harder case: the buffer
			// still holds an owned entry at the moment a different user's drain runs.
			await page.unroute(CHUNK_ATTEMPTS_ROUTE);
			await session.signInAs(userB);
			await page.goto('/type');

			await expect
				.poll(() => attemptsForChunk(userB.client, guestChunkId), {
					message: 'B should have backfilled the guest-authored entry'
				})
				.toHaveLength(1);

			// The invariant, stated three ways: B did not write A's passage, A did not get it
			// either (nobody drained it), and the entry is still sitting in the buffer, intact
			// and still A's.
			expect(
				await attemptsForChunk(userB.client, ownedChunkId),
				'user B was attributed an attempt user A typed'
			).toHaveLength(0);
			expect(await attemptsForChunk(userA.client, ownedChunkId)).toHaveLength(0);
			const remaining = await readBuffer(page);
			expect(remaining).toHaveLength(1);
			expect(remaining[0].userId).toBe(userA.id);
			expect(remaining[0].chunkId).toBe(ownedChunkId);

			// B's own view is exactly the one passage it legitimately inherited.
			const percent = Math.round((100 * 1) / book.chunkCount);
			await expect(page.getByTestId(`text-picker-option-${BOOK_SLUG}`)).toContainText(
				`${percent}%`
			);

			// ── And on the way out, hygiene (§5) ──────────────────────────────────────────
			// A transition to guest drops every signed-in-authored entry, whoever owns it, so A's
			// passage does not sit on a shared browser waiting for a third user.
			await session.reset();
			await page.goto('/type');
			await expect.poll(() => readBuffer(page)).toEqual([]);
		}
	);
});
