import { expect, test } from '@playwright/test';
import { prideAndPrejudiceExcerpt } from '../src/lib/fixtures/en';
import { donQuijoteExcerpt } from '../src/lib/fixtures/es';
import { SUPABASE_URL } from './support/supabase';
import { expectPageIs } from './support/typing-screen';

/**
 * What a guest does NOT do (spec #12): every book opens at passage 1, every progress bar
 * reads 0, and completing a passage issues no write.
 *
 * Kept in its own file rather than alongside the authenticated specs on purpose: the
 * authenticated fixture overrides Playwright's `storageState`, which the built-in `context`
 * always depends on, so any test sharing that file would sign a throwaway user up whether
 * it wanted one or not. A guest test must run with no session at all.
 *
 * The component tests already prove `TypingSession` calls no write service and constructs no
 * Supabase client for a guest. Only a real browser can prove the stronger claim the spec
 * makes — that **no request leaves the page** — which is what the network listener below is
 * for. Deliberately not duplicated in Vitest, where there is no network to observe.
 */

const BOOK_SLUG = prideAndPrejudiceExcerpt.id;
const OTHER_BOOK_SLUG = donQuijoteExcerpt.id;
const CHUNK_0 = prideAndPrejudiceExcerpt.chunks[0].content;

test.describe('a guest', () => {
	test('opens every book at passage 1, with every progress bar at 0%', async ({ page }) => {
		// The language filter (spec #19) defaults to the UI locale's content language, which
		// would hide the ES fixture on a plain '/type'. Both fixture languages are asserted
		// here, so the unfiltered view is requested explicitly.
		await page.goto('/type?lang=all');
		await expect(page.getByTestId('text-picker')).toBeVisible();
		for (const slug of [BOOK_SLUG, OTHER_BOOK_SLUG]) {
			await expect(page.getByTestId(`text-picker-option-${slug}`)).toContainText('0%');
		}

		for (const slug of [BOOK_SLUG, OTHER_BOOK_SLUG]) {
			await page.goto(`/type/${slug}`);
			await expect(page.getByTestId('typing-surface')).toBeVisible();
			await expectPageIs(page, 1);
			await expect(page.getByTestId('page-meta')).toContainText('0%');
		}
	});

	test('completing a passage issues no chunk_attempts request at all', async ({ page }) => {
		// ~380 real keystrokes through the OS-level keyboard path.
		test.setTimeout(120_000);

		// Every request the page makes, from before navigation until after the next passage
		// is underway. The claim is "no request", not "a request that fails", so this
		// listener is attached first and never detached.
		const attemptRequests: string[] = [];
		page.on('request', (request) => {
			if (request.url().includes('chunk_attempts')) {
				attemptRequests.push(`${request.method()} ${request.url()}`);
			}
		});

		await page.goto(`/type/${BOOK_SLUG}`);
		await expectPageIs(page, `1`, `6`);
		await expect(page.getByTestId('typing-input')).toBeFocused();

		await page.keyboard.type(CHUNK_0, { delay: 0 });
		await expectPageIs(page, `2`, `6`);

		// Keep typing past the boundary and let the network settle, so a write dispatched
		// late at the completion instant would still have been observed by the assertion
		// below rather than raced past it.
		await page.keyboard.type('"My dear', { delay: 0 });
		await expect(page.locator('[data-testid="typing-surface"] .char').nth(0)).toHaveAttribute(
			'data-state',
			'correct'
		);
		await page.waitForLoadState('networkidle');

		expect(attemptRequests, 'a guest must issue no chunk_attempts request').toEqual([]);

		// And the guest's progress is still session-relative and unsaved: a reload starts
		// over at passage 1.
		await page.reload();
		await expectPageIs(page, `1`, `6`);
	});

	/**
	 * The same claim, on the Zen path (spec #24 §12: "guests still issue no Supabase request
	 * while typing and still fetch no Supabase client code").
	 *
	 * Mirrored rather than parameterised: mode changes what the completion HANDLER decides to
	 * write — a Zen traversal produces a row with NULL metrics — and that is precisely the
	 * branch a "it's the same code path" assumption would leave unexercised. Whether the
	 * guest gate still sits in front of it is the whole question.
	 *
	 * Two listeners, two claims:
	 *
	 * - **No request.** Any `chunk_attempts` traffic, and any request at all to the Supabase
	 *   origin — broader than the test above, since a Zen write could plausibly go somewhere
	 *   else on that host.
	 * - **No client code.** Any module request whose URL names `@supabase`/`supabase-js`. On
	 *   the dev server (local runs) Vite serves those dependencies under their own names, so
	 *   this is a real assertion; against the production build (CI) chunk filenames are
	 *   content-hashed and the name check is weaker than it looks. The origin check above
	 *   holds in both, and `TypingSession.svelte.spec.ts` proves the import is never reached
	 *   for a guest — this is the browser-level corroboration, not the sole proof.
	 */
	test('completing a passage in Zen issues no Supabase request and loads no Supabase code', async ({
		page,
		context,
		baseURL
	}) => {
		test.setTimeout(120_000);

		const supabaseOrigin = new URL(SUPABASE_URL).origin;
		const supabaseRequests: string[] = [];
		const supabaseModules: string[] = [];
		page.on('request', (request) => {
			const url = request.url();
			if (url.includes('chunk_attempts') || url.startsWith(supabaseOrigin)) {
				supabaseRequests.push(`${request.method()} ${url}`);
			}
			if (/@supabase|supabase-js|supabase_ssr/i.test(url)) {
				supabaseModules.push(url);
			}
		});

		// Opened in Zen from the cookie, so the whole traversal is unmeasured and the
		// completion takes the NULL-metrics branch.
		await context.addCookies([{ name: 'typefy-mode', value: 'zen', url: baseURL! }]);
		await page.goto(`/type/${BOOK_SLUG}`);
		await expect(page.getByTestId('zen-toggle')).toHaveAttribute('aria-pressed', 'true');
		await expectPageIs(page, `1`, `6`);
		await expect(page.getByTestId('page-meta')).not.toContainText('wpm');
		await expect(page.getByTestId('typing-input')).toBeFocused();

		await page.keyboard.type(CHUNK_0, { delay: 0 });
		await expectPageIs(page, `2`, `6`);

		// Type past the boundary and let the network settle, so a write dispatched late at
		// the completion instant would still be observed rather than raced past.
		await page.keyboard.type('"My dear', { delay: 0 });
		await expect(page.locator('[data-testid="typing-surface"] .char').nth(0)).toHaveAttribute(
			'data-state',
			'correct'
		);
		await page.waitForLoadState('networkidle');

		expect(supabaseRequests, 'a guest in Zen must issue no Supabase request').toEqual([]);
		expect(supabaseModules, 'a guest must fetch no Supabase client code').toEqual([]);
	});
});
