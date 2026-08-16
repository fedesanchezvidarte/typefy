import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/auth';
import { isLocalStack, readSeededBook, SUPABASE_URL } from './support/supabase';
import { expectPageIs } from './support/typing-screen';
import { gridCard } from './support/library';
// Fixture contents are imported (not duplicated) so the tests type the exact strings the
// app renders and address the exact slug the seed holds. The fixture id IS the `books.slug`.
import { prideAndPrejudiceExcerpt } from '../src/lib/fixtures/en';
import { donQuijoteExcerpt } from '../src/lib/fixtures/es';

/**
 * The signed-in half of spec #12: resume, book-lifetime display, and the write path end to
 * end — complete a passage → it is saved → come back and continue.
 *
 * These are the criteria only a real authenticated browser can prove. The trigger's own
 * rules live in `progress.e2e.ts` (database-level), and the component-level display rules
 * live in the Vitest component tests; nothing here re-litigates either.
 *
 * Every test gets its own throwaway user from `fixtures/auth.ts`, with its own seeded
 * progress — the resume cases are mutually exclusive states of the SAME book, so they
 * cannot share one.
 */

const BOOK_SLUG = prideAndPrejudiceExcerpt.id;
const OTHER_BOOK_SLUG = donQuijoteExcerpt.id;
const CHUNK_0 = prideAndPrejudiceExcerpt.chunks[0].content;

/** The figures line under the page card: "[wpm · accuracy ·] pct%" (spec #50). */
const META = 'page-meta';

test.describe('resume', () => {
	test.skip(
		!isLocalStack,
		`refusing to create throwaway users against a non-local Supabase (${SUPABASE_URL})`
	);

	test('with passages 1–3 complete, the book opens at passage 4', async ({ page, authUser }) => {
		const book = await authUser.completePassages(BOOK_SLUG, [0, 1, 2]);
		expect(book.chunkCount, 'this test needs a book with more than 3 passages').toBeGreaterThan(3);

		await page.goto(`/type/${BOOK_SLUG}`);
		await expect(page.getByTestId('typing-surface')).toBeVisible();
		await expectPageIs(page, `4`, `${book.chunkCount}`);
	});

	test('with a gap — passages 1 and 3 complete, 2 not — the book opens at passage 2', async ({
		page,
		authUser
	}) => {
		// Gaps count: resume is the LOWEST incomplete index, not "one past the highest
		// completed one". Seeded out of order for the same reason.
		const book = await authUser.completePassages(BOOK_SLUG, [2, 0]);

		await page.goto(`/type/${BOOK_SLUG}`);
		await expect(page.getByTestId('typing-surface')).toBeVisible();
		await expectPageIs(page, `2`, `${book.chunkCount}`);
	});

	test('a fully completed book opens at passage 1, showing 100%', async ({ page, authUser }) => {
		const positions = [...prideAndPrejudiceExcerpt.chunks.keys()];
		const book = await authUser.completePassages(BOOK_SLUG, positions);
		expect(positions.length, 'the seed and the fixture must agree on the passage count').toBe(
			book.chunkCount
		);

		// There is no "you have finished" state in this spec: it simply opens at the start,
		// and the percentage is what tells the user the book is done.
		await page.goto(`/type/${BOOK_SLUG}`);
		await expect(page.getByTestId('typing-surface')).toBeVisible();
		await expectPageIs(page, `1`, `${book.chunkCount}`);
		await expect(page.getByTestId(META)).toContainText('100%');
	});

	test('?passage=N overrides the computed index, and anything invalid silently falls back to it', async ({
		page,
		authUser
	}) => {
		const book = await authUser.completePassages(BOOK_SLUG, [0, 1, 2]);

		// 1-based, matching what the navigator displays, and it wins even though passage 3
		// is already complete.
		await page.goto(`/type/${BOOK_SLUG}?passage=3`);
		await expectPageIs(page, `3`, `${book.chunkCount}`);

		// Zero, out of range, non-numeric, and empty: each falls back to the computed index
		// and renders the book normally. Never a 400, never a 404 — a stale or hand-edited
		// link must still open the book.
		for (const value of ['0', '999', 'abc', '', '2.0', '-1']) {
			await page.goto(`/type/${BOOK_SLUG}?passage=${value}`);
			await expect(
				page.getByTestId('typing-surface'),
				`?passage=${value} should still render the book`
			).toBeVisible();
			await expect(
				page.getByTestId('page-nav-jump'),
				`?passage=${value} should fall back to the computed index`
			).toHaveValue('4');
		}
	});
});

test.describe('display — book-lifetime completion', () => {
	test.skip(
		!isLocalStack,
		`refusing to create throwaway users against a non-local Supabase (${SUPABASE_URL})`
	);

	test('the library card and the meta line both show passages-ever-completed ÷ passage count', async ({
		page,
		authUser
	}) => {
		const book = await authUser.completePassages(BOOK_SLUG, [0, 1, 2]);
		const percent = Math.round((100 * 3) / book.chunkCount);
		expect(percent, 'the seeded book should make this an unambiguous 50%').toBe(50);

		// OTHER_BOOK_SLUG is the ES fixture; the default filter on '/type' resolves to 'en'
		// and would hide it, so both books are asserted under the unfiltered view.
		await page.goto('/type?lang=all');
		await expect(page.getByTestId('text-picker')).toBeVisible();
		// BOOK_SLUG now has progress, so it also renders in the continue-reading section
		// (spec #19 §5) — the grid card is reached through its own container to avoid
		// Playwright's strict-mode collision between the two identical cards.
		await expect(gridCard(page, BOOK_SLUG)).toContainText('50%');
		// An untouched book has no `book_progress` row at all, which reads as 0 rather than
		// as a missing value. It has no continue-reading counterpart, so the bare testid
		// still resolves to exactly one element.
		await expect(page.getByTestId(`text-picker-option-${OTHER_BOOK_SLUG}`)).toContainText('0%');

		// The meta line shows the SAME figure, not how far into today's session the user is:
		// resuming at passage 4 of 6 shows the persisted 50%, never 0%.
		await page.goto(`/type/${BOOK_SLUG}`);
		await expectPageIs(page, `4`, `${book.chunkCount}`);
		await expect(page.getByTestId(META)).toContainText('50%');
	});
});

test.describe('the write path, end to end', () => {
	test.skip(
		!isLocalStack,
		`refusing to create throwaway users against a non-local Supabase (${SUPABASE_URL})`
	);

	test('completing a passage saves an attempt, rolls it up, and the book reopens at passage 2', async ({
		page,
		authUser
	}) => {
		// ~380 real keystrokes through the OS-level keyboard path.
		test.setTimeout(120_000);
		const book = await readSeededBook(authUser.client, BOOK_SLUG);
		const firstChunkId = book.chunkIds[0];
		const expectedPercent = Math.round((100 * 1) / book.chunkCount);

		await page.goto(`/type/${BOOK_SLUG}`);
		await expectPageIs(page, `1`, `${book.chunkCount}`);
		await expect(page.getByTestId('typing-input')).toBeFocused();

		await page.keyboard.type(CHUNK_0, { delay: 0 });

		// The session advances immediately, without waiting for the insert, and the
		// percentage advances optimistically with it.
		await expectPageIs(page, `2`, `${book.chunkCount}`);
		await expect(page.getByTestId(META)).toContainText(`${expectedPercent}%`);

		// The insert is fire-and-forget, so the row is polled for rather than assumed
		// present — but it is the browser's own write, read back through the user's own RLS.
		await expect
			.poll(
				async () => {
					const { data } = await authUser.client
						.from('chunk_attempts')
						.select('chunk_id, book_id, completed, gross_wpm, elapsed_ms')
						.eq('chunk_id', firstChunkId);
					return data ?? [];
				},
				{ message: 'the browser should have appended exactly one chunk_attempts row' }
			)
			.toHaveLength(1);

		const attempt = await authUser.client
			.from('chunk_attempts')
			.select('*')
			.eq('chunk_id', firstChunkId)
			.single();
		expect(attempt.data!.completed).toBe(true);
		expect(attempt.data!.book_id).toBe(book.id);
		expect(attempt.data!.user_id).toBe(authUser.id);
		expect(Number(attempt.data!.gross_wpm)).toBeGreaterThan(0);
		expect(Number(attempt.data!.accuracy_raw)).toBeGreaterThan(0);
		expect(attempt.data!.elapsed_ms).toBeGreaterThan(0);
		// The first keystroke, asserted only as an ordering property — it is informational
		// and no rollup rule reads it.
		expect(Date.parse(attempt.data!.started_at)).toBeLessThanOrEqual(
			Date.parse(attempt.data!.created_at)
		);

		// The trigger folded it into both rollups.
		const chunkProgress = await authUser.client
			.from('chunk_progress')
			.select('first_completed_at, attempt_count')
			.eq('chunk_id', firstChunkId)
			.single();
		expect(chunkProgress.data!.attempt_count).toBe(1);
		expect(chunkProgress.data!.first_completed_at).not.toBeNull();

		const bookProgress = await authUser.client
			.from('book_progress')
			.select('chunks_completed')
			.eq('book_id', book.id)
			.single();
		expect(bookProgress.data!.chunks_completed).toBe(1);

		// The loop closes: come back and the book opens where the typing left off, with the
		// persisted percentage — nothing here depends on the in-memory session any more.
		await page.goto(`/type/${BOOK_SLUG}`);
		await expectPageIs(page, `2`, `${book.chunkCount}`);
		await expect(page.getByTestId(META)).toContainText(`${expectedPercent}%`);
		await page.goto('/type');
		// BOOK_SLUG now has progress, so it also renders in continue-reading — scope through
		// the grid container to avoid the strict-mode collision (spec #19 §5/§6).
		await expect(gridCard(page, BOOK_SLUG)).toContainText(`${expectedPercent}%`);
	});
});

/**
 * Settled pages, end to end (spec #50 §6/§7).
 *
 * The engine suite proves the reducer settles on every arrival, and the component suite proves
 * the surface renders it. This proves the thing only a real browser can: that the page a user
 * genuinely completed on a previous visit — persisted in `chunk_progress`, read back through the
 * load — comes back settled, and that reopening it is per-visit and survives no reload.
 */
test.describe('completed pages come back settled', () => {
	test.skip(
		!isLocalStack,
		`refusing to create throwaway users against a non-local Supabase (${SUPABASE_URL})`
	);

	test('a page completed on a previous visit reads as typed, refuses keystrokes, and reopens', async ({
		page,
		authUser
	}) => {
		const book = await authUser.completePassages(BOOK_SLUG, [0, 1, 2]);

		// `?page=1` overrides resume, which would otherwise open at the first INCOMPLETE page.
		await page.goto(`/type/${BOOK_SLUG}?page=1`);
		// Hydration, before anything is clicked: `Type again` below is inert until the session
		// is live, and a click that lands early does nothing at all.
		await expect(page.getByTestId('typing-input')).toBeFocused();
		await expectPageIs(page, 1, book.chunkCount);
		await expect(page.getByTestId('page-completed')).toBeVisible();

		// Every character reads as typed, and there is no caret to type at.
		const chars = page.locator('[data-testid="typing-surface"] .char[data-state]');
		await expect(chars.first()).toHaveAttribute('data-state', 'correct');
		await expect(page.locator('[data-testid="typing-surface"] .caret')).toHaveCount(0);

		// Keystrokes do nothing — backspace included, which is the one that could otherwise walk
		// back through text this visit never typed.
		await expect(page.getByTestId('typing-input')).toBeFocused();
		await page.keyboard.type('zzz', { delay: 0 });
		await page.keyboard.press('Backspace');
		await expect(chars.first()).toHaveAttribute('data-state', 'correct');
		await expectPageIs(page, 1, book.chunkCount);

		// A settled page fabricates no WPM: it looks fully typed and measured nothing.
		await expect(page.getByTestId(META)).toContainText('— wpm');

		// `Type again` reopens it for a fresh traversal, and hands focus back.
		await page.getByTestId('page-retype').click();
		await expect(chars.first()).toHaveAttribute('data-state', 'pending');
		await expect(page.getByTestId('typing-input')).toBeFocused();
		// The mark stays: it states history, not live status.
		await expect(page.getByTestId('page-completed')).toBeVisible();

		await page.keyboard.type(CHUNK_0.slice(0, 5), { delay: 0 });
		await expect(chars.first()).toHaveAttribute('data-state', 'correct');

		// Reopening is PER-VISIT. Nothing un-completes a page, so a reload settles it again.
		await page.reload();
		await expect(page.getByTestId('page-completed')).toBeVisible();
		await expect(page.getByTestId('page-retype')).toBeVisible();
	});

	test('an uncompleted page carries no mark', async ({ page, authUser }) => {
		const book = await authUser.completePassages(BOOK_SLUG, [0]);

		await page.goto(`/type/${BOOK_SLUG}?page=2`);
		// Hydration first: asserting the ABSENCE of the mark is exactly the assertion that passes
		// vacuously against a half-rendered page, so it must wait for a session that exists.
		await expect(page.getByTestId('typing-input')).toBeFocused();
		await expectPageIs(page, 2, book.chunkCount);
		await expect(page.getByTestId('typing-surface')).toBeVisible();
		await expect(page.getByTestId('page-completed')).toHaveCount(0);
	});

	test('jumping back to a completed page settles it without a navigation', async ({
		page,
		authUser
	}) => {
		const book = await authUser.completePassages(BOOK_SLUG, [0]);

		await page.goto(`/type/${BOOK_SLUG}?page=2`);
		// The hydration gate, and it is load-bearing: the navigator's buttons are inert until the
		// surface has focused its own input on mount, so a click before that silently does
		// nothing and the session never moves. (Same wait, same reason, as the navigator specs in
		// `page-model.e2e.ts`.)
		await expect(page.getByTestId('typing-input')).toBeFocused();
		await expectPageIs(page, 2, book.chunkCount);
		await expect(page.getByTestId('page-completed')).toHaveCount(0);

		await page.getByTestId('page-nav-previous').click();

		await expectPageIs(page, 1, book.chunkCount);
		await expect(page.getByTestId('page-completed')).toBeVisible();
	});
});

/**
 * Resetting a book's progress (spec #51) — the application's only destructive path, end to end.
 *
 * What only a real browser and a real database can prove, and therefore what lives here rather
 * than in Vitest:
 *
 * - The RPC actually deletes both rollups and actually keeps `chunk_attempts`. A mocked client
 *   proves which function was called, never what it did.
 * - The **reset-aware trigger** fires. An attempt typed before a reset but inserted after it —
 *   exactly what the attempt buffer replays on reconnect — must land in history without
 *   re-marking the page. That is a trigger firing on an INSERT, which no unit test can observe.
 * - RLS refuses a direct client delete on the rollups, which is the guarantee that lets the whole
 *   feature be a `SECURITY DEFINER` function.
 * - The flow across two screens: reset here, then the typing screen opens at page 1 with nothing
 *   settled.
 */
test.describe('resetting a book (spec #51)', () => {
	test.skip(
		!isLocalStack,
		`refusing to create throwaway users against a non-local Supabase (${SUPABASE_URL})`
	);

	const trigger = (page: Page) => page.getByTestId('book-detail-reset');
	const confirmButton = (page: Page) => page.getByTestId('book-detail-reset-confirm');
	const cancelButton = (page: Page) => page.getByTestId('book-detail-reset-cancel');
	const progress = (page: Page) => page.getByTestId('book-detail-progress');

	/**
	 * Open the confirmation, retrying until it actually opens.
	 *
	 * The trigger is server-rendered and its handler only exists after hydration, so a click that
	 * lands first silently does nothing — and there is no visible difference between "not
	 * hydrated" and "clicked and ignored". Unlike the typing screen there is no focus signal to
	 * wait on here (nothing on this route steals focus on mount), so the honest wait is to retry
	 * the click until the second step appears.
	 */
	async function openConfirm(page: Page) {
		await expect(async () => {
			await trigger(page).click();
			await expect(cancelButton(page)).toBeVisible({ timeout: 500 });
		}).toPass({ timeout: 15_000 });
	}

	/**
	 * Confirm, and wait for the reset to LAND.
	 *
	 * Deliberately NOT an assertion on the trigger being absent: the trigger is already gone while
	 * the confirmation is open, so that check passes the instant the prompt appears and lets the
	 * test race ahead of the in-flight POST — which is exactly how the first version of these
	 * tests read the database before the reset had happened. The progress line dropping to zero is
	 * the first thing that is only true once the action has returned and the load has re-run.
	 */
	async function confirmReset(page: Page, chunkCount: number) {
		await confirmButton(page).click();
		await expect(progress(page)).toContainText(`0 of ${chunkCount} pages`);
		await expect(trigger(page)).toHaveCount(0);
	}

	test('two steps clear the progress, and the bar re-renders without a reload', async ({
		page,
		authUser
	}) => {
		const book = await authUser.completePassages(BOOK_SLUG, [0, 1, 2]);

		await page.goto(`/books/${BOOK_SLUG}`);
		await expect(progress(page)).toContainText(`3 of ${book.chunkCount} pages`);

		// Step one writes nothing, and focus lands on Cancel rather than on the destructive
		// control — a stray Enter must not complete the action it just opened.
		await openConfirm(page);
		await expect(cancelButton(page)).toBeFocused();
		await expect(progress(page)).toContainText(`3 of ${book.chunkCount} pages`);

		await confirmButton(page).click();

		// The load re-runs, so the bar drops to zero and the control disappears with it — there is
		// no longer progress to reset.
		await expect(progress(page)).toContainText(`0 of ${book.chunkCount} pages`);
		await expect(trigger(page)).toHaveCount(0);
	});

	test('Cancel leaves the progress exactly as it was', async ({ page, authUser }) => {
		const book = await authUser.completePassages(BOOK_SLUG, [0, 1]);

		await page.goto(`/books/${BOOK_SLUG}`);
		await openConfirm(page);
		await cancelButton(page).click();

		await expect(trigger(page)).toBeFocused();
		await expect(progress(page)).toContainText(`2 of ${book.chunkCount} pages`);
	});

	test('the control is absent for a book with no progress', async ({ page, authUser }) => {
		await authUser.completePassages(OTHER_BOOK_SLUG, [0]);

		await page.goto(`/books/${BOOK_SLUG}`);
		await expect(progress(page)).toBeVisible();
		await expect(trigger(page)).toHaveCount(0);
	});

	test('the typing history survives, and the rollups do not', async ({ page, authUser }) => {
		const book = await authUser.completePassages(BOOK_SLUG, [0, 1, 2]);

		await page.goto(`/books/${BOOK_SLUG}`);
		await openConfirm(page);
		await confirmReset(page, book.chunkCount);

		// The whole point of the design: every traversal is still on record.
		const attempts = await authUser.client
			.from('chunk_attempts')
			.select('id')
			.eq('book_id', book.id);
		expect(attempts.error).toBeNull();
		expect(attempts.data, 'chunk_attempts is never touched by a reset').toHaveLength(3);

		const rollup = await authUser.client
			.from('chunk_progress')
			.select('chunk_id')
			.eq('book_id', book.id);
		expect(rollup.data, 'every chunk_progress row for the book is gone').toEqual([]);

		const bookRollup = await authUser.client
			.from('book_progress')
			.select('chunks_completed')
			.eq('book_id', book.id);
		expect(bookRollup.data, 'the book_progress row is deleted, not zeroed').toEqual([]);

		// And the reset is recorded — the marker that keeps the rollups derivable from history.
		const resets = await authUser.client
			.from('progress_resets')
			.select('id')
			.eq('book_id', book.id);
		expect(resets.data).toHaveLength(1);
	});

	/**
	 * The reset-aware trigger (spec §4), and the case that would silently undo a reset without it.
	 */
	test('an attempt typed before the reset lands in history but does not re-mark the page', async ({
		page,
		authUser
	}) => {
		const book = await authUser.completePassages(BOOK_SLUG, [0]);

		await page.goto(`/books/${BOOK_SLUG}`);
		await openConfirm(page);
		await confirmReset(page, book.chunkCount);

		// Typed an hour ago, arriving now: the attempt buffer's shape exactly.
		const { error } = await authUser.client.from('chunk_attempts').insert({
			user_id: authUser.id,
			chunk_id: book.chunkIds[1],
			book_id: book.id,
			completed: true,
			started_at: new Date(Date.now() - 3_600_000).toISOString(),
			gross_wpm: 60,
			accuracy_raw: 0.98,
			elapsed_ms: 30_000,
			mode: 'normal',
			measured_ms: 30_000,
			measured_chars: 500
		});
		expect(error, `the late attempt must still be accepted: ${error?.message}`).toBeNull();

		const attempts = await authUser.client
			.from('chunk_attempts')
			.select('id')
			.eq('book_id', book.id);
		expect(attempts.data, 'history keeps the late attempt').toHaveLength(2);

		const rollup = await authUser.client
			.from('chunk_progress')
			.select('chunk_id')
			.eq('book_id', book.id);
		expect(rollup.data, 'but it must not re-mark the page').toEqual([]);

		// The screen agrees: still nothing to reset.
		await page.reload();
		await expect(trigger(page)).toHaveCount(0);
	});

	/**
	 * The guarantee that lets the rollups stay client-unwritable, and therefore the reason the
	 * whole operation is a SECURITY DEFINER function rather than a delete grant.
	 */
	test('a client cannot delete the rollups directly, nor record a reset itself', async ({
		authUser
	}) => {
		const book = await authUser.completePassages(BOOK_SLUG, [0]);

		await authUser.client.from('chunk_progress').delete().eq('book_id', book.id);
		const survived = await authUser.client
			.from('chunk_progress')
			.select('chunk_id')
			.eq('book_id', book.id);
		expect(survived.data, 'RLS must refuse a direct rollup delete').toHaveLength(1);

		const forged = await authUser.client
			.from('progress_resets')
			.insert({ user_id: authUser.id, book_id: book.id });
		expect(forged.error, 'a client must not be able to record a reset itself').not.toBeNull();
	});

	test('after a reset the book opens at page 1 with nothing settled', async ({
		page,
		authUser
	}) => {
		const book = await authUser.completePassages(BOOK_SLUG, [0, 1]);

		await page.goto(`/books/${BOOK_SLUG}`);
		await openConfirm(page);
		await confirmReset(page, book.chunkCount);

		await page.goto(`/type/${BOOK_SLUG}`);
		await expect(page.getByTestId('typing-input')).toBeFocused();
		await expectPageIs(page, 1, book.chunkCount);
		// Spec #50's settled marker is gone with the progress that produced it.
		await expect(page.getByTestId('page-completed')).toHaveCount(0);
	});
});
