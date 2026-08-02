import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, guestTest, test } from './fixtures/auth';
import { isLocalStack, SUPABASE_URL } from './support/supabase';
import { gridCard, sectionCard } from './support/library';
import { prideAndPrejudiceExcerpt } from '../src/lib/fixtures/en';
import { donQuijoteExcerpt } from '../src/lib/fixtures/es';
import { tortoiseAndHare } from '../src/lib/fixtures/tortoise';

/**
 * Spec #19 §4 (language filter) and §5 (continue reading), end to end.
 *
 * The pure filter rules (`parseLanguageFilter`, `defaultLanguageFilter`) and the pure
 * selection rule (`selectContinueReading`) already have unit coverage under `src/lib/`;
 * nothing here re-litigates them. What only a real browser can prove is that the URL, the
 * server load and the rendered library actually agree: the default resolves from the UI
 * locale, an unrecognised value fails open rather than 400ing, the active option is
 * keyboard-reachable and exposed to assistive tech, and a signed-in user's in-progress books
 * appear (or do not) exactly where §5 says they should.
 */

const EN_ID = prideAndPrejudiceExcerpt.id;
const ES_ID = donQuijoteExcerpt.id;
const SHORT_ID = tortoiseAndHare.id;

function filterOption(page: Page, value: 'en' | 'es' | 'all') {
	return page.getByTestId(`library-language-filter-${value}`);
}

/**
 * Retried, not a plain `page.goto`: on a local `npm run dev` server (not CI, which builds and
 * serves a production preview) the very first request for a route Vite has not compiled yet
 * can abort the navigation instead of completing it — a dev-server cold-start artefact, not
 * app behaviour. `toPass` gives that first compile somewhere to land without flaking the
 * assertion that actually matters.
 */
async function gotoLibrary(page: Page, path: string) {
	await expect(async () => {
		await page.goto(path);
		await expect(page.getByTestId('text-picker')).toBeVisible({ timeout: 2000 });
	}).toPass();
}

test.describe('language filter', () => {
	test('defaults to the UI locale content language at /type', async ({ page }) => {
		await gotoLibrary(page, '/type');
		await expect(filterOption(page, 'en')).toHaveAttribute('aria-current', 'page');
		await expect(filterOption(page, 'es')).not.toHaveAttribute('aria-current', 'page');
		await expect(page.getByTestId(`text-picker-option-${EN_ID}`)).toBeVisible();
		await expect(page.getByTestId(`text-picker-option-${SHORT_ID}`)).toBeVisible();
		await expect(page.getByTestId(`text-picker-option-${ES_ID}`)).not.toBeVisible();
	});

	test('defaults to the UI locale content language at /es/type', async ({ page }) => {
		await gotoLibrary(page, '/es/type');
		await expect(filterOption(page, 'es')).toHaveAttribute('aria-current', 'page');
		await expect(filterOption(page, 'en')).not.toHaveAttribute('aria-current', 'page');
		await expect(page.getByTestId(`text-picker-option-${ES_ID}`)).toBeVisible();
		await expect(page.getByTestId(`text-picker-option-${EN_ID}`)).not.toBeVisible();
	});

	test('?lang=all shows every seeded language at once', async ({ page }) => {
		await page.goto('/type?lang=all');
		await expect(filterOption(page, 'all')).toHaveAttribute('aria-current', 'page');
		await expect(page.getByTestId(`text-picker-option-${EN_ID}`)).toBeVisible();
		await expect(page.getByTestId(`text-picker-option-${ES_ID}`)).toBeVisible();
		await expect(page.getByTestId(`text-picker-option-${SHORT_ID}`)).toBeVisible();
	});

	test('an unrecognised ?lang value falls back silently to the default, never a 400', async ({
		page
	}) => {
		const response = await page.goto('/type?lang=fr');
		expect(response?.status()).toBe(200);
		// Falls back to 'en' (the UI locale default), exactly as an unfiltered '/type' would.
		await expect(filterOption(page, 'en')).toHaveAttribute('aria-current', 'page');
		await expect(page.getByTestId(`text-picker-option-${EN_ID}`)).toBeVisible();
		await expect(page.getByTestId(`text-picker-option-${ES_ID}`)).not.toBeVisible();
	});

	test('the control is keyboard-operable and back/forward restores the previous filter', async ({
		page
	}) => {
		await page.goto('/type');
		await filterOption(page, 'all').focus();
		await expect(filterOption(page, 'all')).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(page).toHaveURL(/\?lang=all/);
		await expect(filterOption(page, 'all')).toHaveAttribute('aria-current', 'page');
		await expect(page.getByTestId(`text-picker-option-${ES_ID}`)).toBeVisible();

		await page.goBack();
		await expect(page).not.toHaveURL(/\?lang=all/);
		await expect(filterOption(page, 'en')).toHaveAttribute('aria-current', 'page');
		await expect(page.getByTestId(`text-picker-option-${ES_ID}`)).not.toBeVisible();
	});
});

test.describe('continue reading', () => {
	test('a guest sees no continue-reading section at all', async ({ page }) => {
		await page.goto('/type?lang=all');
		await expect(page.getByTestId('text-picker')).toBeVisible();
		await expect(page.getByTestId('continue-reading')).toHaveCount(0);
	});

	test('a signed-in user with no in-progress books sees no section either', async ({
		page,
		authUser
	}) => {
		test.skip(
			!isLocalStack,
			`refusing to create throwaway users against a non-local Supabase (${SUPABASE_URL})`
		);
		void authUser;
		await page.goto('/type?lang=all');
		await expect(page.getByTestId('text-picker')).toBeVisible();
		await expect(page.getByTestId('continue-reading')).toHaveCount(0);
	});

	test('an in-progress book appears in both the section and the grid, and the two cards do not collide', async ({
		page,
		authUser
	}) => {
		test.skip(
			!isLocalStack,
			`refusing to create throwaway users against a non-local Supabase (${SUPABASE_URL})`
		);
		const book = await authUser.completePassages(EN_ID, [0]);
		const percent = Math.round((100 * 1) / book.chunkCount);

		await page.goto('/type?lang=all');
		await expect(page.getByTestId('continue-reading')).toBeVisible();
		await expect(sectionCard(page, EN_ID)).toContainText(`${percent}%`);
		await expect(gridCard(page, EN_ID)).toContainText(`${percent}%`);
	});

	test('a fully completed book is excluded even though it has progress', async ({
		page,
		authUser
	}) => {
		test.skip(
			!isLocalStack,
			`refusing to create throwaway users against a non-local Supabase (${SUPABASE_URL})`
		);
		// The short fixture is 3 chunks — cheap to finish entirely.
		await authUser.completePassages(SHORT_ID, [0, 1, 2]);

		await page.goto('/type?lang=all');
		await expect(page.getByTestId('continue-reading')).toHaveCount(0);
		// Still in the grid, at 100% — completion is not the same as removal from the catalog.
		await expect(gridCard(page, SHORT_ID)).toContainText('100%');
	});

	test('at most 3 books show, most recently active first', async ({ page, authUser }) => {
		test.skip(
			!isLocalStack,
			`refusing to create throwaway users against a non-local Supabase (${SUPABASE_URL})`
		);
		// Sequential inserts (completePassages awaits each one) give each book a strictly
		// later `chunk_attempts.created_at`, which is what `last_active_at` is derived from —
		// so the arrival order below is also the expected display order, most recent first.
		await authUser.completePassages(EN_ID, [0]);
		await authUser.completePassages(ES_ID, [0]);
		await authUser.completePassages(SHORT_ID, [0]);

		await page.goto('/type?lang=all');
		const section = page.getByTestId('continue-reading');
		await expect(section).toBeVisible();
		const cards = section.locator('[data-testid^="text-picker-option-"]');
		await expect(cards).toHaveCount(3);
		await expect(cards.nth(0)).toHaveAttribute('data-testid', `text-picker-option-${SHORT_ID}`);
		await expect(cards.nth(1)).toHaveAttribute('data-testid', `text-picker-option-${ES_ID}`);
		await expect(cards.nth(2)).toHaveAttribute('data-testid', `text-picker-option-${EN_ID}`);
	});

	test('respects the active language filter, so the page never contradicts itself', async ({
		page,
		authUser
	}) => {
		test.skip(
			!isLocalStack,
			`refusing to create throwaway users against a non-local Supabase (${SUPABASE_URL})`
		);
		await authUser.completePassages(EN_ID, [0]);
		await authUser.completePassages(ES_ID, [0]);

		// Default ('en'): only the EN book is offered to continue.
		await page.goto('/type');
		await expect(sectionCard(page, EN_ID)).toBeVisible();
		await expect(
			page.getByTestId('continue-reading').getByTestId(`text-picker-option-${ES_ID}`)
		).toHaveCount(0);

		// 'es': only the ES book.
		await page.goto('/type?lang=es');
		await expect(sectionCard(page, ES_ID)).toBeVisible();
		await expect(
			page.getByTestId('continue-reading').getByTestId(`text-picker-option-${EN_ID}`)
		).toHaveCount(0);

		// 'all': both.
		await page.goto('/type?lang=all');
		await expect(sectionCard(page, EN_ID)).toBeVisible();
		await expect(sectionCard(page, ES_ID)).toBeVisible();
	});
});

guestTest.describe('continue reading issues no progress query for a guest', () => {
	guestTest('no book_progress request leaves the page when signed out', async ({ page }) => {
		const progressRequests: string[] = [];
		page.on('request', (request) => {
			if (request.url().includes('book_progress')) {
				progressRequests.push(`${request.method()} ${request.url()}`);
			}
		});

		await page.goto('/type?lang=all');
		await expect(page.getByTestId('text-picker')).toBeVisible();
		await page.waitForLoadState('networkidle');

		expect(progressRequests, 'a guest load must issue no book_progress request').toEqual([]);
	});
});

/**
 * Phase 8 (accessibility) for the library page's two new affordances (spec #19). The typing
 * screen itself is `windowed-reading.e2e.ts`'s to audit; this covers what §4/§5 add: the
 * filter control and the continue-reading section, filtered and unfiltered, guest and
 * signed-in.
 *
 * Same gate and the same carve-out as `windowed-reading.e2e.ts`'s a11y block, for the same
 * reason: `--muted` fails WCAG AA contrast in the two light palettes today, tracked
 * separately as issue #21, and is not something a filter/continue-reading feature should
 * silently "fix" by picking different tokens than the rest of the chrome.
 */
test.describe('library accessibility (phase 8)', () => {
	const KNOWN_PREEXISTING_RULES = new Set(['color-contrast']);

	async function seriousViolations(page: Page) {
		const results = await new AxeBuilder({ page }).analyze();
		return results.violations
			.filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
			.filter(
				(violation) => violation.impact === 'critical' || !KNOWN_PREEXISTING_RULES.has(violation.id)
			)
			.map((violation) => `${violation.impact}: ${violation.id} — ${violation.help}`);
	}

	test('the default filtered library has no serious violations', async ({ page }) => {
		await page.goto('/type');
		await expect(page.getByTestId('text-picker')).toBeVisible();
		expect(await seriousViolations(page), 'axe: /type, default filter').toEqual([]);
	});

	test('the unfiltered library and a signed-in continue-reading section have no serious violations', async ({
		page,
		authUser
	}) => {
		test.skip(
			!isLocalStack,
			`refusing to create throwaway users against a non-local Supabase (${SUPABASE_URL})`
		);
		await authUser.completePassages(EN_ID, [0]);

		await page.goto('/type?lang=all');
		await expect(page.getByTestId('continue-reading')).toBeVisible();
		expect(await seriousViolations(page), 'axe: /type?lang=all, signed in with progress').toEqual(
			[]
		);
	});

	test('the filter control is reachable in page tab order and its active option is announced, not just coloured', async ({
		page
	}) => {
		await page.goto('/type');
		const active = filterOption(page, 'en');
		// aria-current is the non-colour half of the signal (spec #19 §4): a link element with
		// this attribute exposes it to assistive tech through the accessible-name/state API by
		// definition (it is a standard ARIA state, not a custom data attribute), so asserting
		// the DOM attribute here is exactly what an AT would read. The axe pass above (which
		// runs `aria-valid-attr-value`) additionally proves it is not just present but valid.
		await expect(active).toHaveAttribute('aria-current', 'page');
		await expect(filterOption(page, 'es')).not.toHaveAttribute('aria-current', 'page');

		// Reachable by keyboard: Tab from the top of the page lands on it within a bounded walk.
		let reached = false;
		for (let i = 0; i < 20 && !reached; i += 1) {
			await page.keyboard.press('Tab');
			reached =
				(await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? '')) ===
				'library-language-filter-en';
		}
		expect(reached, 'Tab should reach the active filter option within 20 stops').toBe(true);
	});
});
