import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
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
import { expectPageIs } from './support/typing-screen';
import { WINDOW_SIZE } from '../src/lib/reading/window';
import { tortoiseAndHare } from '../src/lib/fixtures/tortoise';
import { PALETTE_IDS } from '../src/lib/theme/palettes';
import { PALETTE_COOKIE } from '../src/lib/theme/theme';

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
			contents: Array.from({ length: CHUNK_COUNT }, (_, index) => probeChunk(index)),
			// Spec #45's header names the chapter the active page falls in. Chapter one starts
			// at index 1, deliberately, so page 1 is FRONT MATTER — the case that must render no
			// chapter at all rather than folding into chapter one (ADR-0017).
			chapters: [
				{ index: 0, title: 'Probe Chapter One', startChunkIndex: 1 },
				{ index: 1, title: 'Probe Chapter Two', startChunkIndex: 3 }
			]
		});
	});

	test.afterAll(async () => {
		await retireProbeBook(service, SLUG);
	});

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
			await expectPageIs(page, `3`, `${tortoiseAndHare.chunkCount}`);

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
			await expectPageIs(page, `1`, `${book.chunkCount}`);

			await page.getByTestId('page-nav-next').click();
			await expectPageIs(page, `2`, `${book.chunkCount}`);
			await expect(page.getByTestId('typing-surface')).toContainText(book.contents[1]);
			await expect(page).toHaveURL(/[?&]page=2(&|$)/);

			await page.getByTestId('page-nav-previous').click();
			await expectPageIs(page, `1`, `${book.chunkCount}`);
			await expect(page).toHaveURL(/[?&]page=1(&|$)/);

			const jump = page.getByTestId('page-nav-jump');
			await jump.fill(String(CHUNK_COUNT));
			await jump.press('Enter');
			await expectPageIs(page, `${CHUNK_COUNT}`, `${book.chunkCount}`);
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
			await expectPageIs(page, `1`, `${book.chunkCount}`);
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
			await expectPageIs(page, `2`, `${book.chunkCount}`);

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

			await expectPageIs(page, `${target}`, `${book.chunkCount}`);
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
			await expectPageIs(page, `2`, `${book.chunkCount}`);

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

	/**
	 * Phase 8. Everything new in spec #32 that a static component test cannot see: the `↵`
	 * glyph's real, composited contrast (its `opacity` reduces the token's already-audited
	 * strength — `theme.spec.ts`'s WCAG AA suite only proves the TOKEN clears 4.5:1 at full
	 * strength, not the glyph drawn at 0.4/0.7 of it), the navigator's keyboard reachability
	 * and accessible names, and a keyboard-only walk that includes both the navigator and a
	 * newline. Same "critical/serious only, no rule carve-outs" posture as `mode.e2e.ts` and
	 * `windowed-reading.e2e.ts`.
	 */
	test.describe('accessibility (phase 8)', () => {
		const A11Y_SLUG = 'page-model-a11y-probe';
		/** `line one` is 8 chars, so index 8 is the `\n` — short enough it can never wrap. */
		const A11Y_CONTENT = ['line one\nline two', 'second page'];

		let a11yBook: ProbeBook;

		test.beforeAll(async () => {
			a11yBook = await arrangeProbeBook(service, {
				slug: A11Y_SLUG,
				title: 'Page model a11y probe',
				author: 'probe',
				language: 'en',
				contents: A11Y_CONTENT
			});
		});

		test.afterAll(async () => {
			await retireProbeBook(service, A11Y_SLUG);
		});

		async function seriousViolations(page: Page) {
			const results = await new AxeBuilder({ page }).analyze();
			return results.violations
				.filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
				.map((violation) => `${violation.impact}: ${violation.id} — ${violation.help}`);
		}

		function chars(page: Page) {
			return page.locator('[data-testid="typing-surface"] .char');
		}

		/**
		 * The glyph is revealed by CSS only when the position holds the caret (`opacity: 0.4`,
		 * `--dim`) or is `incorrect` (`opacity: 0.7`, `--error`) — both states are exercised, in
		 * every palette this app ships (ADR-0011's two-axis system: two light, two dark), not
		 * just the default. `theme.spec.ts` already proves `--dim`/`--error` clear 4.5:1 at full
		 * strength; a partial-opacity glyph composites toward the surface behind it and could in
		 * principle fall under that bar even though its source token does not — this is the one
		 * place that composited value is actually measured, by a real browser, rather than
		 * assumed from the token audit.
		 */
		test('the newline glyph clears axe contrast checks held by the caret and marked incorrect, in every palette', async ({
			page,
			context,
			baseURL
		}) => {
			test.setTimeout(120_000);
			for (const paletteId of PALETTE_IDS) {
				await context.addCookies([{ name: PALETTE_COOKIE, value: paletteId, url: baseURL! }]);
				// In-page restore (spec #32 §8, `page-state.ts`) persists a half-typed page in
				// `localStorage` keyed by book+index, independent of palette, and flushes
				// IMMEDIATELY on `visibilitychange -> hidden` (`TypingSession.svelte`) — not just
				// on the debounce. This test deliberately leaves the page `incorrect` at the end
				// of every iteration, and reuses this same `page` across all four palettes, so a
				// naive `goto` + `clear()` + `reload()` here is not enough: the `goto` restores
				// the previous iteration's leftover state into a live session (moving the CURSOR
				// to the newline position, not just pre-filling it as `correct`), and the
				// `reload()` that follows the clear then re-flushes THAT still-live session's
				// state back into the storage the clear just emptied — restoring it right back.
				// Landing on a same-origin bystander page with no typing session mounted at all,
				// between the previous iteration and this one, breaks the cycle: there is
				// nothing live left to re-flush by the time storage is cleared, so the next load
				// is genuinely fresh. `about:blank` cannot be used for the clear itself — it is a
				// different (opaque) origin, and `localStorage` there throws a `SecurityError`.
				await page.goto('/type');
				await page.evaluate(() => localStorage.clear());
				await page.goto(`/type/${a11yBook.slug}`);
				await expect(page.getByTestId('typing-surface')).toBeVisible();
				await expect(page.getByTestId('typing-input')).toBeFocused();
				await expect(page.locator('html')).toHaveAttribute('data-palette', paletteId);

				// Caret-held: cursor sits ON the `\n` position (index 8) with nothing typed there yet.
				await page.keyboard.type('line one', { delay: 0 });
				await expect(chars(page).nth(8)).toHaveClass(/caret/);
				expect(
					await seriousViolations(page),
					`axe: newline glyph, caret-held, ${paletteId}`
				).toEqual([]);

				// Incorrect: a space at the newline position is refused (chunk.spec.ts's own case),
				// same page reused rather than reloaded — one axe pass per state is enough here.
				await page.keyboard.press('Space');
				await expect(chars(page).nth(8)).toHaveAttribute('data-state', 'incorrect');
				expect(
					await seriousViolations(page),
					`axe: newline glyph, incorrect, ${paletteId}`
				).toEqual([]);
			}
		});

		/**
		 * Reachability, accessible names beyond the icon glyphs, and Enter/Space activation —
		 * spec #32's explicit scope cut (no keyboard shortcuts beyond standard tab/enter) means
		 * these three are the WHOLE affordance, so each has to actually work.
		 */
		test('the page navigator is keyboard-reachable, accessibly named, and Enter/Space-operable', async ({
			page
		}) => {
			await page.goto(`/type/${book.slug}`);
			await expect(page.getByTestId('typing-surface')).toBeVisible();
			await expect(page.getByTestId('typing-input')).toBeFocused();

			await expect(page.getByTestId('page-nav-previous')).toHaveAccessibleName('Previous page');
			await expect(page.getByTestId('page-nav-next')).toHaveAccessibleName('Next page');
			await expect(page.getByTestId('page-nav-jump')).toHaveAccessibleName('Go to page');
			// Disabled at the start edge — never a focus stop, and never announced as actionable.
			await expect(page.getByTestId('page-nav-previous')).toBeDisabled();

			// Spec #50 put the Zen toggle in the bottom row's LEFT column, ahead of the navigator
			// in DOM order — so it is now the first Tab stop from the input, and the tab order
			// follows the reading order of the row: toggle, then navigator, then the figures
			// (which are text and take no focus).
			await page.keyboard.press('Tab');
			await expect(page.getByTestId('zen-toggle')).toBeFocused();

			// Previous is disabled on page 1, so the next Tab lands on the jump box, a native
			// input skipping disabled controls exactly as it would skip any other.
			await page.keyboard.press('Tab');
			await expect(page.getByTestId('page-nav-jump')).toBeFocused();
			await page.keyboard.press('Tab');
			await expect(page.getByTestId('page-nav-next')).toBeFocused();

			// Enter activates the focused button — no click, no pointer, ever. `navigateToIndex`
			// (`TypingSession.svelte`) calls `surface?.focusInput()` at the end of EVERY
			// navigation, click or keyboard, so its own comment reads "a navigator click must not
			// strand a keyboard-only user" — focus never stays on the button that triggered it,
			// it lands back on the typing input, which is the actual thing to prove here.
			await page.keyboard.press('Enter');
			await expectPageIs(page, `2`, `${book.chunkCount}`);
			await expect(page.getByTestId('typing-input')).toBeFocused();

			// Now that page 1 is behind it, previous is enabled and is the first navigator stop —
			// reached on the second Tab, past the Zen toggle. Space activates it exactly as Enter
			// did the next button.
			await page.keyboard.press('Tab');
			await expect(page.getByTestId('zen-toggle')).toBeFocused();
			await page.keyboard.press('Tab');
			await expect(page.getByTestId('page-nav-previous')).toBeFocused();
			await page.keyboard.press(' ');
			await expectPageIs(page, `1`, `${book.chunkCount}`);
			// Same "never stranded" guarantee on the way back.
			await expect(page.getByTestId('typing-input')).toBeFocused();
		});

		/**
		 * An out-of-range jump is silently ignored (`PageNavigator.svelte`'s own comment: "the
		 * same posture `resolveStartIndex` already applies to `?page=`"). Silence is a deliberate
		 * design decision, not an oversight — the field's own value reverting to the current page
		 * IS the feedback, readable by a screen reader that re-enters or re-reads the field, the
		 * same information a sighted user gets (no toast either). This test pins that the revert
		 * actually happens (nothing about it can regress silently) and that it degrades to
		 * nothing worse than "no navigation" — never a crash, never a stuck value, never a jump to
		 * the wrong page.
		 */
		test('an out-of-range jump reverts the field rather than failing silently in place', async ({
			page
		}) => {
			await page.goto(`/type/${book.slug}`);
			await expect(page.getByTestId('typing-surface')).toBeVisible();

			const jump = page.getByTestId('page-nav-jump');
			await jump.fill(String(book.chunkCount + 50));
			await jump.press('Enter');

			// No navigation happened, and the field is readable again as "the current page" —
			// not left holding the rejected value.
			await expectPageIs(page, `1`, `${book.chunkCount}`);
			await expect(jump).toHaveValue('1');
			expect(await seriousViolations(page), 'axe: after a rejected jump').toEqual([]);
		});

		/**
		 * Extends `windowed-reading.e2e.ts`'s "the whole flow is keyboard-only" pattern (that
		 * file's own describe, same name) to the two things spec #32 actually added: the
		 * navigator, and a page containing a newline. No pointer is used anywhere in this test.
		 */
		test('the whole page-model flow is keyboard-only, including the navigator and a newline', async ({
			page
		}) => {
			await page.goto(`/type/${a11yBook.slug}`);
			await expect(page.getByTestId('typing-surface')).toBeVisible();
			await expect(page.getByTestId('typing-input')).toBeFocused();

			// Type across the real Enter path (spec #32 §7's desktop branch), correct the whole
			// way including a deliberate mistake-and-correction at the newline itself.
			await page.keyboard.type('line one', { delay: 0 });
			await page.keyboard.press('Space'); // wrong: marks the newline incorrect
			await expect(chars(page).nth(8)).toHaveAttribute('data-state', 'incorrect');
			await page.keyboard.press('Backspace');
			await expect(chars(page).nth(8)).toHaveAttribute('data-state', 'pending');
			await page.keyboard.press('Enter'); // right: the real newline keystroke
			await expect(chars(page).nth(8)).toHaveAttribute('data-state', 'corrected');
			await page.keyboard.type('line two', { delay: 0 });
			await expectPageIs(page, `2`, `${a11yBook.chunkCount}`);
			await expect(page.getByTestId('typing-input')).toBeFocused();

			// Tab out to the navigator and back, purely by keyboard, and confirm focus never gets
			// stuck anywhere along the way (the same "escapes to a real control" assertion
			// `windowed-reading.e2e.ts`'s awaiting test makes for its own focus boundary).
			// `navigateToIndex` (`TypingSession.svelte`) calls `surface?.focusInput()` at the end
			// of every navigation — click or keyboard — so focus never lingers on the button that
			// triggered it; it lands back on the typing input, which is the actual boundary this
			// test is proving.
			await page.keyboard.press('Tab'); // the Zen toggle leads the bottom row (spec #50)
			await expect(page.getByTestId('zen-toggle')).toBeFocused();
			await page.keyboard.press('Tab'); // previous, now enabled (page 2 of 2)
			await expect(page.getByTestId('page-nav-previous')).toBeFocused();
			await page.keyboard.press('Enter');
			await expectPageIs(page, `1`, `${a11yBook.chunkCount}`);
			await expect(page.getByTestId('typing-input')).toBeFocused();
		});
	});

	/**
	 * Spec #45 — the book page. Three things that are genuinely new browser behaviour: the
	 * chrome having moved into the header, the chapter being named there, and paragraphs
	 * rendering as blocks with a real blank line between them.
	 *
	 * The scroll model is deliberately NOT re-proved here, for the same reason spec #32's was
	 * not: `computeTranslateY` is pure and fully unit-tested, and asserting a translateY pixel
	 * value through a browser measures font metrics rather than the feature.
	 */
	test.describe('the book page (spec #45)', () => {
		test('the header carries book, chapter, page and metrics — and re-names the chapter on navigation', async ({
			page
		}) => {
			await page.goto(`/type/${book.slug}`);
			await expect(page.getByTestId('typing-surface')).toBeVisible();
			// Hydration, proved the way the navigator test proves it: the surface focuses its own
			// input on mount, and the navigator buttons below do nothing until that has happened.
			await expect(page.getByTestId('typing-input')).toBeFocused();

			const slot = page.getByTestId('typing-header-slot');
			await expect(slot).toBeVisible();
			await expect(page.getByTestId('header-book')).toHaveText('Page model probe');
			await expectPageIs(page, `1`, `${book.chunkCount}`);
			// Spec #50 sends the figures and the toggle back DOWN, under the card: the header now
			// carries identity only. Asserted from both directions so a regression either way fails
			// here — one figures line on the page, and none of it inside the slot.
			await expect(page.getByTestId('page-meta')).toHaveCount(1);
			await expect(slot.getByTestId('page-meta')).toHaveCount(0);
			await expect(slot.getByTestId('zen-toggle')).toHaveCount(0);
			await expect(page.getByTestId('zen-toggle')).toHaveAttribute('aria-pressed', 'false');
			// The title is the way back to the book detail screen.
			await expect(page.getByTestId('header-book')).toHaveAttribute(
				'href',
				new RegExp(`/books/${book.slug}$`)
			);

			// Page 1 is front matter: no chapter, rather than chapter one.
			await expect(page.getByTestId('header-chapter')).toHaveCount(0);

			// Crossing into chapter one, and then into chapter two, renames it — with no
			// navigation and no request, since the whole chapter list came with the load.
			await page.getByTestId('page-nav-next').click();
			await expect(page.getByTestId('header-chapter')).toHaveText('Probe Chapter One');
			await page.getByTestId('page-nav-next').click();
			await expect(page.getByTestId('header-chapter')).toHaveText('Probe Chapter One');
			await page.getByTestId('page-nav-next').click();
			await expect(page.getByTestId('header-chapter')).toHaveText('Probe Chapter Two');
			await expectPageIs(page, `4`, `${book.chunkCount}`);

			// And the typing input still holds focus through all of it.
			await expect(page.getByTestId('typing-input')).toBeFocused();
		});

		test('the book line above the card is gone, but the h1 still names the book', async ({
			page
		}) => {
			await page.goto(`/type/${book.slug}`);
			const heading = page.getByTestId('book-line');
			await expect(heading).toHaveCount(1);
			await expect(heading).toHaveText('Page model probe · probe');
			// Visually hidden, never removed: heading structure is unchanged for assistive tech.
			await expect(heading).not.toBeInViewport();
			expect(await heading.evaluate((node) => node.tagName)).toBe('H1');
		});

		test('paragraphs render as blocks separated by exactly one blank line', async ({ page }) => {
			// The tortoise fixture's third page carries two real paragraph breaks (spec #32 R9).
			const chunk = tortoiseAndHare.chunks[2];
			const breaks = [...chunk.content].filter((char) => char === '\n').length;
			expect(breaks, 'this fixture must still carry paragraph breaks').toBeGreaterThan(0);

			await page.goto(`/type/${tortoiseAndHare.id}?page=3`);
			await expect(page.getByTestId('typing-surface')).toBeVisible();

			const paragraphs = page.locator('[data-testid="typing-measure"] p');
			await expect(paragraphs).toHaveCount(breaks + 1);

			// The newline slot still EXISTS — it holds the caret and the error tint — but renders
			// no glyph, so `white-space: pre-wrap` cannot emit a second break for it.
			const newlineText = await page
				.locator('[data-testid="typing-measure"] .newline')
				.first()
				.textContent();
			expect(newlineText).toBe('');

			// One blank line between blocks: the gap is one rendered line-height, within a
			// tolerance that allows for sub-pixel line boxes but not for a second break.
			const lineHeight = await paragraphs
				.first()
				.evaluate((node) => Number.parseFloat(getComputedStyle(node).lineHeight));
			const first = (await paragraphs.nth(0).boundingBox())!;
			const second = (await paragraphs.nth(1).boundingBox())!;
			const gap = second.y - (first.y + first.height);
			expect(gap).toBeGreaterThan(lineHeight * 0.75);
			expect(gap).toBeLessThan(lineHeight * 1.25);
		});
	});
});
