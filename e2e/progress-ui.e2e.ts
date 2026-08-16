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
		await expectPageIs(page, 2, book.chunkCount);
		await expect(page.getByTestId('page-completed')).toHaveCount(0);

		await page.getByTestId('page-nav-previous').click();

		await expectPageIs(page, 1, book.chunkCount);
		await expect(page.getByTestId('page-completed')).toBeVisible();
	});
});
