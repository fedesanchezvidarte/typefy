import { expect, guestTest, test } from './fixtures/auth';
import { isLocalStack, readSeededBook, SUPABASE_URL, type AnyClient } from './support/supabase';
import { expectPageIs } from './support/typing-screen';
import { gridCard } from './support/library';
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

const META = 'page-meta';

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
 * Every error the page reported with nobody to catch it, from the moment this is called.
 *
 * This is how Phase 7 found the cold-import defect, and it is why the offline test below now
 * types NOTHING before going offline. `TypingSession.saveAttempt` awaits the lazily-imported
 * write path; when the session's first keystroke never ran the warm-up, that import is still
 * cold at the completion instant, and offline it rejects. The rejection used to escape
 * `void saveAttempt(...)` entirely: the completion was neither saved, nor counted, nor
 * buffered, and the only trace anywhere was `Uncaught (in promise) TypeError: Failed to fetch
 * dynamically imported module: /src/lib/supabase/browser.ts` in the console.
 *
 * So the test asserts both halves: the passage is buffered (the behaviour a user feels), and
 * nothing went unhandled (the cause, which no UI assertion can see).
 */
function collectUnhandledErrors(page: Page): string[] {
	const errors: string[] = [];
	// Chromium reports an unhandled rejection to the console; Playwright surfaces uncaught
	// exceptions separately. Both are collected, and both are filtered to the module-load
	// failure this test is about — an offline page produces plenty of legitimate network noise.
	page.on('console', (message) => {
		if (message.type() === 'error' && /dynamically imported module/i.test(message.text())) {
			errors.push(message.text());
		}
	});
	page.on('pageerror', (error) => {
		if (/dynamically imported module/i.test(error.message)) {
			errors.push(error.message);
		}
	});
	return errors;
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
		const unhandled = collectUnhandledErrors(page);
		const book = await readSeededBook(authUser.client, BOOK_SLUG);
		const lastChunkId = book.chunkIds[PASSAGE_COUNT - 1];

		// The LAST passage, so completing it finishes the session and the summary — the one
		// surface that states a pending save — actually renders.
		await page.goto(`/type/${BOOK_SLUG}?passage=${PASSAGE_COUNT}`);
		await expectPageIs(page, PASSAGE_COUNT, book.chunkCount);
		await expect(page.getByTestId('typing-input')).toBeFocused();

		// Deliberately NOT a single keystroke before this line: the lazy write path is still
		// cold, so the completion below has to fetch it with the network already gone. That is
		// the harder of the two offline shapes and the one that used to drop the passage
		// silently — a signed-in user who loses connectivity before typing anything, or whose
		// first keystroke is also the completing one.
		await context.setOffline(true);
		await typePassage(page, CHUNK_LAST);

		// Pending, not lost: the passage is buffered, and the summary says so in as many words.
		await expect(page.getByTestId('summary-save-pending')).toHaveText(
			"One page will be saved when you're back online."
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
		// And the failed fetch of the write path was handled, not merely survived: an unhandled
		// rejection here is the exact signature of the passage being dropped instead of buffered.
		expect(
			unhandled,
			'the cold module load must fail into the buffer, not into the console'
		).toEqual([]);

		await context.setOffline(false);

		// **The `online` trigger cannot rescue THIS document, and that is browser behaviour, not
		// a defect.** A failed dynamic import is recorded in the document's module map, so every
		// later `import()` of the same URL in the same document fails immediately — without
		// touching the network, connectivity or not. (Verified in Chromium against this app's own
		// module URL.) A session that went offline before it ever fetched the write path
		// therefore stays without one until the page is replaced, which is exactly why the
		// completion is BUFFERED rather than retried in place: the entry outlives the document.
		//
		// So the drain trigger this case actually gets is the next page load's mount trigger.
		// The user reaches it the same way they always leave a summary — by picking another text.
		const percent = Math.round((100 * 1) / book.chunkCount);
		await page.goto('/type');

		// Polled rather than waited on: the drain is fire-and-forget behind the page, exactly as
		// it is in production.
		await expect
			.poll(() => attemptsForChunk(authUser.client, lastChunkId), {
				message: 'the buffered attempt should have been written on the next page load'
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
		// BOOK_SLUG now has progress, so it also renders in continue-reading (spec #19 §5) —
		// scope through the grid container to avoid the strict-mode collision.
		await expect(gridCard(page, BOOK_SLUG)).toContainText(`${percent}%`);
	});
});

/**
 * Phase 8 (accessibility). The `online` drain trigger in `+layout.svelte` calls
 * `invalidateAll()`, and unlike the mount trigger it can fire while somebody is mid-passage:
 * connectivity returns, the backlog goes out, and the page's load functions re-run underneath
 * a user who did nothing to ask for it.
 *
 * Spec §11 is often read as covering this — it does not. What §11 forbids is the IN-SESSION
 * trigger (`TypingSession.saveAttempt`) invalidating after every successful write, and
 * `TypingSession.svelte.spec.ts` asserts that negative. The reconnect trigger genuinely does
 * invalidate mid-passage, so what protects the typist has to be proven rather than assumed:
 * focus is not moved, the session is not yanked, and nothing is announced at them.
 *
 * Deliberately E2E and not a component test: every mechanism at issue belongs to the real
 * router. `invalidateAll()` re-runs loads without going through `navigate()`, so it never
 * applies focus or scroll reset; `{#key data.book.id}` keys on a stable id so nothing in the
 * focused subtree remounts; and `startIndex` is read through `untrack` so a resume index that
 * has just moved cannot pull the session with it. Mocking any of those would test the mock.
 */
test.describe('a reconnect drain must not disturb a typist mid-passage', () => {
	test.skip(
		!isLocalStack,
		`refusing to create throwaway users against a non-local Supabase (${SUPABASE_URL})`
	);

	test('invalidateAll from the online trigger keeps focus, the session and the announcer intact', async ({
		page,
		authUser
	}) => {
		const book = await readSeededBook(authUser.client, BOOK_SLUG);
		// A dozen characters is enough to have a session worth losing, and keeps the test fast.
		const prefix = CHUNK_FIRST.slice(0, 12);
		const typedCorrect = () =>
			page.locator('[data-testid="typing-surface"] .char[data-state="correct"]');

		await page.goto(`/type/${BOOK_SLUG}`);
		await expectPageIs(page, 1, book.chunkCount);
		await expect(page.getByTestId('page-meta')).toContainText('0%');
		await typePassage(page, prefix);
		await expect(typedCorrect()).toHaveCount(prefix.length);

		// What the announcer says right now. It is the only live region on this screen, so it is
		// the only thing that could speak over somebody who is typing.
		const announcer = page.getByTestId('page-announcer');
		const announcedBefore = await announcer.textContent();

		// A backlog appears — guest-authored, for the very passage being typed, so the drain
		// moves BOTH the percentage and the resume index. The resume index is the sharper of
		// the two: after this write the lowest incomplete passage is 2, and a session that
		// re-read `startIndex` on invalidation would jump there and discard what is on screen.
		const entry: BufferedChunkAttempt = {
			userId: null,
			chunkId: book.chunkIds[0],
			// `books.id`, which is what `chunk_attempts.book_id` is keyed by. Typed as
			// `BufferedChunkAttempt` rather than an object literal on purpose: an entry the
			// buffer's own validator rejects reads back as an empty buffer, so a wrong field
			// here would make the drain silently not happen and every assertion below vacuous.
			bookId: book.id,
			completed: true,
			grossWpm: 55,
			accuracyRaw: 0.96,
			elapsedMs: 30_000,
			startedAt: Date.now() - 600_000,
			bufferedAt: Date.now() - 590_000
		};
		await page.evaluate(({ key, entries }) => localStorage.setItem(key, entries), {
			key: ATTEMPT_BUFFER_KEY,
			entries: JSON.stringify([entry])
		});
		// The buffer is really there — otherwise `maybeDrain`'s synchronous gate returns early
		// and the `online` event below proves nothing.
		expect(await readBuffer(page)).toHaveLength(1);

		await page.evaluate(() => window.dispatchEvent(new Event('online')));

		// The drain wrote and invalidated: the figure on screen caught up without a reload.
		// This is the assertion that proves `invalidateAll()` actually ran — everything below
		// is only meaningful because it did.
		const percent = Math.round((100 * 1) / book.chunkCount);
		await expect(page.getByTestId(META)).toContainText(`${percent}%`);

		// ── and the typist noticed nothing ────────────────────────────────────────────────
		// Focus never left the hidden input, so the next keystroke still reaches the engine.
		await expect(page.getByTestId('typing-input')).toBeFocused();
		// The session was not yanked to the new resume index, and no keystroke was lost.
		await expectPageIs(page, `1`, `${book.chunkCount}`);
		await expect(typedCorrect()).toHaveCount(prefix.length);
		// Nothing was announced: the sr-only announcer is a pure function of the passage number
		// and the book length, neither of which a drain can move. The visible percentage that
		// DID change is not a live region, which is exactly why it may change silently.
		await expect(announcer).toHaveText(announcedBefore ?? '');

		// And typing simply continues from where it was.
		await page.keyboard.type(CHUNK_FIRST.slice(prefix.length, prefix.length + 6), { delay: 0 });
		await expect(typedCorrect()).toHaveCount(prefix.length + 6);
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
			// ~815 real keystrokes across two pages.
			guestTest.setTimeout(240_000);
			const user = await mintUser();
			const book = await readSeededBook(user.client, BOOK_SLUG);

			// ── As a guest ────────────────────────────────────────────────────────────────
			await page.goto(`/type/${BOOK_SLUG}`);
			await expectPageIs(page, `1`, `${book.chunkCount}`);
			await typePassage(page, CHUNK_FIRST);
			await expectPageIs(page, `2`, `${book.chunkCount}`);
			await expect.poll(() => readBuffer(page)).toHaveLength(1);

			// The last passage too, in a second session, so the summary and its sign-in prompt —
			// the conversion surface this whole feature exists to make honest — actually render.
			await page.goto(`/type/${BOOK_SLUG}?passage=${PASSAGE_COUNT}`);
			await typePassage(page, CHUNK_LAST);
			await expect(page.getByTestId('session-summary')).toBeVisible();

			// The prompt counts THIS session's passage, and it is count-aware because the buffer
			// is what makes the promise keepable.
			await expect(page.getByTestId('summary-sign-in-prompt')).toContainText(
				'Sign in to save the page you just typed'
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
			// BOOK_SLUG now has progress, so it also renders in continue-reading (spec #19 §5) —
			// scope through the grid container to avoid the strict-mode collision.
			await expect(
				gridCard(page, BOOK_SLUG),
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
			await expectPageIs(page, `2`, `${book.chunkCount}`);
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
			// ~800 real keystrokes across two pages.
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
			await expectPageIs(page, `2`, `${book.chunkCount}`);
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

			// B's own view is exactly the one passage it legitimately inherited. BOOK_SLUG now
			// has progress, so it also renders in continue-reading (spec #19 §5) — scope
			// through the grid container to avoid the strict-mode collision.
			const percent = Math.round((100 * 1) / book.chunkCount);
			await expect(gridCard(page, BOOK_SLUG)).toContainText(`${percent}%`);

			// ── And on the way out, hygiene (§5) ──────────────────────────────────────────
			// A transition to guest drops every signed-in-authored entry, whoever owns it, so A's
			// passage does not sit on a shared browser waiting for a third user.
			await session.reset();
			await page.goto('/type');
			await expect.poll(() => readBuffer(page)).toEqual([]);
		}
	);
});
