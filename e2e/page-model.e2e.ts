import { expect, guestTest as test } from './fixtures/auth';
import {
	isLocalStack,
	localSecretKey,
	readSeededBook,
	secretClient,
	SUPABASE_URL,
	type AnyClient
} from './support/supabase';
import { arrangeProbeBook, retireProbeBook, type ProbeBook } from './support/probe-books';
import { WINDOW_SIZE } from '../src/lib/reading/window';
import { tortoiseAndHare } from '../src/lib/fixtures/tortoise';

/**
 * Spec #32's user-facing promises that are genuinely new browser behaviour, not already
 * re-litigated elsewhere:
 *
 * - `\n` typed via Enter, end to end, including the database row (`mode.e2e.ts` and
 *   `windowed-reading.e2e.ts`'s short-book loops already prove Enter does not break a whole
 *   session; this file is the one place that reads back `measured_chars` against `char_count`
 *   to prove the newline was actually counted, not merely typed without crashing).
 * - The page navigator UI (arrows + jump box), and the URL it writes.
 * - The A′ engine seek (spec #32 §10 D1): an in-window jump costs no request and no
 *   navigation; an out-of-window jump fetches a fresh window anchored at the target and still
 *   costs no navigation — "the same session continues" proved at the browser level, not just
 *   asserted from the component test's vantage point.
 * - In-page restore across a real reload: the typed prefix comes back, and only the newly
 *   typed span is measured — folding in acceptance criterion #14 (a restored page under 100
 *   remaining characters sets no personal best) as a consequence read back from the database,
 *   not a separate assumption.
 *
 * The teleprompter's scroll behaviour is deliberately NOT re-proved here: `teleprompter.ts`'s
 * pure-math unit tests already pin `computeTranslateY`'s every case (band entry, both clamps),
 * and the DOM half is one `$effect` that only ever calls that function with real measurements.
 * Asserting a `translateY` pixel value through a real browser would be measuring font metrics
 * and line-height rounding, not the feature — exactly the kind of E2E flake the pure-math split
 * exists to avoid needing.
 */

const SLUG = 'page-model-probe';
/** One more than a window, so page (WINDOW_SIZE + 1) is a genuine out-of-window seek target. */
const CHUNK_COUNT = WINDOW_SIZE + 5;

function probeChunk(index: number): string {
	return `probe page ${index} content here`;
}

test.describe('the page model (spec #32)', () => {
	test.skip(
		!isLocalStack,
		`refusing to publish a probe book against a non-local Supabase (${SUPABASE_URL})`
	);
	test.skip(
		!localSecretKey(),
		'needs the local secret key: no client role may publish a book, and none should'
	);

	let service: AnyClient;
	let book: ProbeBook;

	test.beforeAll(async () => {
		service = secretClient()!;
		book = await arrangeProbeBook(service, {
			slug: SLUG,
			title: 'Page model probe',
			author: 'probe',
			language: 'en',
			contents: Array.from({ length: CHUNK_COUNT }, (_, index) => probeChunk(index))
		});
	});

	test.afterAll(async () => {
		await retireProbeBook(service, SLUG);
	});

	function meta(page: import('@playwright/test').Page) {
		return page.getByTestId('page-meta');
	}

	test.describe('Enter as a typed character', () => {
		test("a completed page's measured_chars includes its newline characters", async ({
			page,
			mintUser,
			session
		}) => {
			test.setTimeout(60_000);
			const user = await mintUser();
			await session.signInAs(user);

			// The tortoise fixture's third passage carries two real paragraph breaks (spec #32's
			// own fixture-migration fixture, R9) — a seeded catalog book, not a probe, since this
			// is exactly the case R9 exists to make available without inventing new content.
			const chunk = tortoiseAndHare.chunks[2];
			expect(chunk.content, 'this fixture must still carry paragraph breaks').toContain('\n');
			// The fixture's own `.id` is a deliberately fake, stable placeholder (never a real
			// row address, per the fixture module's own comment) — the real uuid `chunk_id` has
			// to come from the database it was seeded into.
			const seeded = await readSeededBook(user.client, tortoiseAndHare.id);
			const realChunkId = seeded.chunkIds[2];

			await page.goto(`/type/${tortoiseAndHare.id}?page=3`);
			await expect(page.getByTestId('typing-surface')).toBeVisible();
			await expect(page.getByTestId('typing-input')).toBeFocused();
			await expect(meta(page)).toContainText(`Page 3 of ${tortoiseAndHare.chunkCount}`);

			// Real typing through the OS-level keyboard path: Playwright's `keyboard.type` presses
			// Enter for an embedded `\n`, which is exactly the desktop path `handleKeydown`'s
			// `Enter` branch is written for (spec #32 §7) — not a synthetic `\n` character event.
			await page.keyboard.type(chunk.content, { delay: 0 });

			// The book completes here (3 of 3), so the summary is the stopped state to wait on.
			await expect(page.getByTestId('session-summary')).toBeVisible();

			const row = async () => {
				const { data, error } = await user.client
					.from('chunk_attempts')
					.select('measured_chars, completed')
					.eq('chunk_id', realChunkId)
					.maybeSingle();
				expect(error, `reading chunk_attempts failed: ${error?.message}`).toBeNull();
				return data;
			};
			await expect.poll(async () => (await row())?.completed).toBe(true);
			const attempt = await row();
			// The newlines are ordinary characters in the measured span (spec #32, accepted WPM
			// drift): a page typed wholly clean measures its FULL char_count, `\n` included.
			expect(attempt!.measured_chars).toBe(chunk.charCount);
		});
	});

	test.describe('the page navigator', () => {
		test('previous/next and the jump box move the session, and the URL carries ?page=N', async ({
			page
		}) => {
			await page.goto(`/type/${book.slug}`);
			await expect(page.getByTestId('typing-surface')).toBeVisible();
			await expect(page.getByTestId('typing-input')).toBeFocused();
			await expect(meta(page)).toContainText(`Page 1 of ${book.chunkCount}`);

			await page.getByTestId('page-nav-next').click();
			await expect(meta(page)).toContainText(`Page 2 of ${book.chunkCount}`);
			await expect(page.getByTestId('typing-surface')).toContainText(book.contents[1]);
			await expect(page).toHaveURL(/[?&]page=2(&|$)/);

			await page.getByTestId('page-nav-previous').click();
			await expect(meta(page)).toContainText(`Page 1 of ${book.chunkCount}`);
			await expect(page).toHaveURL(/[?&]page=1(&|$)/);

			const jump = page.getByTestId('page-nav-jump');
			await jump.fill(String(CHUNK_COUNT));
			await jump.press('Enter');
			await expect(meta(page)).toContainText(`Page ${CHUNK_COUNT} of ${book.chunkCount}`);
			await expect(page.getByTestId('typing-surface')).toContainText(
				book.contents[CHUNK_COUNT - 1]
			);
			await expect(page).toHaveURL(new RegExp(`[?&]page=${CHUNK_COUNT}(&|$)`));

			// The previous button reaches the disabled edge and stops, rather than wrapping or
			// erroring — the jump box's own "silently ignore anything invalid" contract (spec
			// #32) applied to the arrow's edge case. Currently on page CHUNK_COUNT, so exactly
			// CHUNK_COUNT - 1 clicks reach page 1; a click on the now-disabled button would just
			// hang waiting for actionability, so the loop stops there rather than overshooting.
			for (let i = 0; i < CHUNK_COUNT - 1; i += 1) {
				await page.getByTestId('page-nav-previous').click();
			}
			await expect(meta(page)).toContainText(`Page 1 of ${book.chunkCount}`);
			await expect(page.getByTestId('page-nav-previous')).toBeDisabled();
		});
	});

	test.describe('the A′ seek — no remount (spec #32 §10 D1)', () => {
		/**
		 * A real document load only — NOT `framenavigated`, which Playwright/CDP also reports
		 * for a same-document `history.pushState` navigation (exactly what the shallow-routed
		 * seek performs), so it cannot tell "remounted" from "just updated the URL". `load`
		 * fires once per actual document, which a `pushState` never produces — the discriminator
		 * this test needs.
		 */
		function countNavigations(page: import('@playwright/test').Page): () => number {
			let count = 0;
			page.on('load', () => {
				count += 1;
			});
			return () => count;
		}

		test('an in-window jump costs no fetch and no navigation — the same session continues', async ({
			page
		}) => {
			await page.goto(`/type/${book.slug}`);
			await expect(page.getByTestId('typing-surface')).toBeVisible();
			await expect(page.getByTestId('typing-input')).toBeFocused();
			// A marker that only a real navigation (a fresh document, a fresh JS realm) can erase —
			// the direct proof that a jump does not remount the page, not an inference from the URL
			// alone.
			await page.evaluate(() => {
				(window as unknown as { __typefyAlive: boolean }).__typefyAlive = true;
			});

			const requests: string[] = [];
			await page.route(/\/api\/books\/[^/]+\/chunks\?/, async (route) => {
				requests.push(route.request().url());
				await route.continue();
			});
			const navigations = countNavigations(page);

			// Page 2 is well inside the first WINDOW_SIZE-chunk window the load already served.
			await page.getByTestId('page-nav-next').click();
			await expect(meta(page)).toContainText(`Page 2 of ${book.chunkCount}`);

			expect(requests, 'an in-window jump must not ask the chunks endpoint for anything').toEqual(
				[]
			);
			expect(navigations(), 'an in-window jump must not navigate the frame').toBe(0);
			expect(
				await page.evaluate(() => (window as unknown as { __typefyAlive?: boolean }).__typefyAlive)
			).toBe(true);
		});

		test('an out-of-window jump fetches a fresh window and still costs no navigation', async ({
			page
		}) => {
			await page.goto(`/type/${book.slug}`);
			await expect(page.getByTestId('typing-surface')).toBeVisible();
			await expect(page.getByTestId('typing-input')).toBeFocused();
			await page.evaluate(() => {
				(window as unknown as { __typefyAlive: boolean }).__typefyAlive = true;
			});

			const requests: string[] = [];
			await page.route(/\/api\/books\/[^/]+\/chunks\?/, async (route) => {
				requests.push(route.request().url());
				await route.continue();
			});
			const navigations = countNavigations(page);

			// Well past the first WINDOW_SIZE-chunk window.
			const target = CHUNK_COUNT; // 1-based jump-box value
			const jump = page.getByTestId('page-nav-jump');
			await jump.fill(String(target));
			await jump.press('Enter');

			await expect(meta(page)).toContainText(`Page ${target} of ${book.chunkCount}`);
			await expect(page.getByTestId('typing-surface')).toContainText(book.contents[target - 1]);

			expect(requests.length, 'an out-of-window jump must fetch the target window').toBeGreaterThan(
				0
			);
			expect(requests.some((url) => url.includes(`from=${target - 1}`))).toBe(true);
			expect(navigations(), 'a seek is never a real navigation, even out of window').toBe(0);
			expect(
				await page.evaluate(() => (window as unknown as { __typefyAlive?: boolean }).__typefyAlive)
			).toBe(true);
		});
	});

	test.describe('in-page restore across a reload (spec #32 §8)', () => {
		test('restores the typed prefix, measures only the new span, and sets no best under the floor', async ({
			page,
			mintUser,
			session
		}) => {
			test.setTimeout(60_000);
			const user = await mintUser();
			await session.signInAs(user);

			const content = probeChunk(0); // 'probe page 0 content here' — 26 chars
			expect(content.length).toBeLessThan(100);
			const prefix = content.slice(0, 15);
			const rest = content.slice(15);

			await page.goto(`/type/${book.slug}`);
			await expect(page.getByTestId('typing-surface')).toBeVisible();
			await expect(page.getByTestId('typing-input')).toBeFocused();
			await page.keyboard.type(prefix, { delay: 0 });
			await expect(
				page.locator('[data-testid="typing-surface"] .char').nth(prefix.length - 1)
			).toHaveAttribute('data-state', 'correct');

			// Force the debounced page-state write rather than waiting out its 2s timer: a real
			// `visibilitychange -> hidden` is one of the app's own three flush triggers (spec §8),
			// fired here synchronously instead of raced against a fixed sleep.
			await page.evaluate(() => {
				Object.defineProperty(document, 'visibilityState', {
					value: 'hidden',
					configurable: true
				});
				document.dispatchEvent(new Event('visibilitychange'));
			});

			await page.reload();
			await expect(page.getByTestId('typing-surface')).toBeVisible();
			await expect(page.getByTestId('typing-input')).toBeFocused();

			// The restored prefix renders correct with no keystroke this sitting, cursor right
			// after it — the visible half of "restores the typed prefix."
			const chars = page.locator('[data-testid="typing-surface"] .char');
			for (let i = 0; i < prefix.length; i += 1) {
				await expect(chars.nth(i)).toHaveAttribute('data-state', 'correct');
			}
			await expect(chars.nth(prefix.length)).toHaveClass(/caret/);

			// Completing page 1 of a CHUNK_COUNT-page book auto-advances rather than ending the
			// session (the summary is a whole-BOOK stopped state, not a per-page one) — so page 2
			// is the on-screen proof of completion here, and the database row is the proof of
			// what was actually measured.
			await page.keyboard.type(rest, { delay: 0 });
			await expect(meta(page)).toContainText(`Page 2 of ${book.chunkCount}`);

			const chunkId = book.chunkIds[0];
			const attempt = async () => {
				const { data, error } = await user.client
					.from('chunk_attempts')
					.select('measured_chars, completed')
					.eq('chunk_id', chunkId)
					.maybeSingle();
				expect(error, `reading chunk_attempts failed: ${error?.message}`).toBeNull();
				return data;
			};
			await expect.poll(async () => (await attempt())?.completed).toBe(true);
			// Only the span typed THIS sitting is measured — the restored prefix is
			// correct-but-unjudged and contributes nothing (spec #32 §8, ADR-0014 amendment).
			expect((await attempt())!.measured_chars).toBe(rest.length);

			// Acceptance criterion #14, read back rather than assumed: `rest.length` is well
			// under BEST_MEASURED_CHARS_FLOOR (100), so the floor the trigger already enforces
			// (proved generically in `best-floor.e2e.ts`) must leave no best set from THIS
			// restored completion either.
			const { data: rollup, error: rollupError } = await user.client
				.from('chunk_progress')
				.select('best_wpm, best_accuracy_raw')
				.eq('chunk_id', chunkId)
				.maybeSingle();
			expect(rollupError, `reading chunk_progress failed: ${rollupError?.message}`).toBeNull();
			expect(rollup, 'the trigger should still write a chunk_progress row').not.toBeNull();
			expect(
				rollup!.best_wpm,
				'a restored completion under the floor must set no best_wpm'
			).toBeNull();
			expect(
				rollup!.best_accuracy_raw,
				'a restored completion under the floor must set no best_accuracy_raw'
			).toBeNull();
		});
	});
});
