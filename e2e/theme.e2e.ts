import { expect, test, type Page } from '@playwright/test';
import { prideAndPrejudiceExcerpt } from '../src/lib/fixtures/en';
import { openBookFromCard } from './support/library';

/**
 * Two-axis theming (spec #9, ADR-0011): palette and font are independent,
 * cookie-persisted, applied as data attributes on <html> with no FOUC, and the
 * system colour scheme only picks the initial default.
 *
 * Phase 5a (spec #30) relocated both switchers off the header row and into the
 * pencil trigger's ribbon panel (`PencilPanel`), so every test below opens the
 * panel first — the buttons are not interactable, let alone visible, while it
 * is closed. The font axis's display scope also narrowed to "reading font"
 * only (ADR-0011's Phase 5a amendment): `body`/chrome is now fixed Roboto and
 * never varies, so the font-axis assertion reads `TypingSurface`'s `.surface`
 * element instead of `document.body`.
 */

const WARM_LIGHT_BG = 'rgb(243, 237, 226)'; // #F3EDE2
const SOFT_DARK_BG = 'rgb(35, 38, 43)'; // #23262B
const NEAR_BLACK_BG = 'rgb(14, 15, 18)'; // #0E0F12

function bodyBg(page: Page) {
	return page.evaluate(() => {
		document.body.style.transition = 'none'; // read the settled value, not a mid-fade frame
		return getComputedStyle(document.body).backgroundColor;
	});
}

/**
 * Opens the pencil panel via its trigger, retried: the click only takes
 * effect once the page has hydrated (the same hydration-safe retry pattern
 * `smoke.e2e.ts` and `library.e2e.ts` already use for their first interaction).
 */
async function openPencilPanel(page: Page) {
	await expect(async () => {
		await page.getByRole('button', { name: 'Theme and language settings' }).click();
		await expect(page.getByRole('button', { name: 'Warm light' })).toBeVisible({ timeout: 2000 });
	}).toPass();
}

test.describe('palette axis', () => {
	test('a palette dot applies instantly and survives a reload via cookie', async ({ page }) => {
		await page.goto('/');
		await openPencilPanel(page);

		await expect(async () => {
			await page.getByRole('button', { name: 'Near black' }).click();
			await expect(page.locator('html')).toHaveAttribute('data-palette', 'near-black', {
				timeout: 2000
			});
		}).toPass();
		expect(await bodyBg(page)).toBe(NEAR_BLACK_BG);

		// The cookie makes the choice durable — and it is stamped server-side,
		// so the reloaded document arrives already themed (no flash).
		await page.reload();
		await expect(page.locator('html')).toHaveAttribute('data-palette', 'near-black');
		expect(await bodyBg(page)).toBe(NEAR_BLACK_BG);
	});

	test.describe('with no stored choice, the system preference picks the initial default', () => {
		test.describe('light', () => {
			test.use({ colorScheme: 'light' });
			test('warm-light renders and <html> carries no data-palette', async ({ page }) => {
				await page.goto('/');
				await expect(page.locator('html')).not.toHaveAttribute('data-palette');
				expect(await bodyBg(page)).toBe(WARM_LIGHT_BG);
			});
		});

		test.describe('dark', () => {
			test.use({ colorScheme: 'dark' });
			test('soft-dark renders and <html> carries no data-palette', async ({ page }) => {
				await page.goto('/');
				await expect(page.locator('html')).not.toHaveAttribute('data-palette');
				expect(await bodyBg(page)).toBe(SOFT_DARK_BG);
			});
		});
	});
});

test.describe('font axis', () => {
	test('a font choice applies to the reading surface only, survives reload, and never touches the palette or chrome', async ({
		page
	}) => {
		// A rendered TypingSurface is required to observe --reading-font-stack; the library
		// route gets one with no featured-book arrangement needed (unlike the landing hero).
		await page.goto('/type');
		await expect(page.getByTestId('text-picker')).toBeVisible();
		// Two hops since spec #34: the card leads to `/books/[slug]`, whose primary action
		// leads to the surface. The shared helper owns that walk.
		await openBookFromCard(page, prideAndPrejudiceExcerpt.id);

		await openPencilPanel(page);

		// Fix the palette first so axis independence is observable.
		await expect(async () => {
			await page.getByRole('button', { name: 'Warm light' }).click();
			await expect(page.locator('html')).toHaveAttribute('data-palette', 'warm-light', {
				timeout: 2000
			});
		}).toPass();

		await page.getByRole('button', { name: 'Serif' }).click();
		await expect(page.locator('html')).toHaveAttribute('data-font', 'serif');

		const surfaceFamily = await page.evaluate(
			() => getComputedStyle(document.querySelector('[data-testid="typing-surface"]')!).fontFamily
		);
		expect(surfaceFamily).toContain('Roboto Serif');

		// Chrome (the header wordmark) is fixed Roboto and never adopts the reading-font
		// choice — the amendment this axis carries per ADR-0011's Phase 5a note.
		const wordmarkFamily = await page.evaluate(
			() => getComputedStyle(document.querySelector('[data-testid="wordmark"]')!).fontFamily
		);
		expect(wordmarkFamily).not.toContain('Roboto Serif');
		expect(wordmarkFamily).toContain('Roboto');

		// Strict separation (brief condition 1): the palette did not move.
		await expect(page.locator('html')).toHaveAttribute('data-palette', 'warm-light');
		expect(await bodyBg(page)).toBe(WARM_LIGHT_BG);

		await page.reload();
		await expect(page.locator('html')).toHaveAttribute('data-font', 'serif');
		await expect(page.locator('html')).toHaveAttribute('data-palette', 'warm-light');
	});
});

test.describe('self-hosted fonts', () => {
	test('every font file is served from the app origin — no external requests', async ({ page }) => {
		const externalRequests: string[] = [];
		page.on('request', (request) => {
			const url = new URL(request.url());
			if (
				url.origin !== new URL(page.url() || 'http://localhost').origin &&
				url.protocol.startsWith('http')
			) {
				externalRequests.push(request.url());
			}
		});
		await page.goto('/');
		await page.waitForLoadState('networkidle');

		const fontHosts = await page.evaluate(() =>
			performance
				.getEntriesByType('resource')
				.filter((r) => r.name.includes('.woff'))
				.map((r) => new URL(r.name).host)
		);
		expect(fontHosts.length).toBeGreaterThan(0);
		expect(fontHosts.every((host) => host === new URL(page.url()).host)).toBe(true);
		expect(externalRequests.filter((u) => u.includes('fonts.g'))).toEqual([]);
	});
});

/**
 * Phase 5a (spec #30 §2): the pencil trigger's ribbon panel — opening, closing on outside
 * click and Escape, and that it hosts all three theme/language groups (brief §2's
 * `PencilPanel`/`RibbonPanel` shell). Complements the axis-specific tests above, which only
 * prove the CONTROLS inside the panel still work once it's open.
 */
test.describe('pencil panel', () => {
	test('opening it via click reveals reading-font, palette and language controls', async ({
		page
	}) => {
		await page.goto('/');
		const trigger = page.getByRole('button', { name: 'Theme and language settings' });
		await expect(trigger).toHaveAttribute('aria-expanded', 'false');

		await openPencilPanel(page);
		await expect(trigger).toHaveAttribute('aria-expanded', 'true');

		await expect(page.getByRole('button', { name: 'Sans' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Serif' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Mono' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Warm light' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Near black' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'English' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Español' })).toBeVisible();
	});

	test('a click outside the panel closes it', async ({ page }) => {
		await page.goto('/');
		await openPencilPanel(page);

		await page.mouse.click(10, 10);
		await expect(page.getByRole('button', { name: 'Warm light' })).toBeHidden();
		await expect(page.getByRole('button', { name: 'Theme and language settings' })).toHaveAttribute(
			'aria-expanded',
			'false'
		);
	});

	test('Escape closes the panel and returns focus to the trigger', async ({ page }) => {
		await page.goto('/');
		await openPencilPanel(page);

		await page.keyboard.press('Escape');
		await expect(page.getByRole('button', { name: 'Warm light' })).toBeHidden();
		await expect(page.getByRole('button', { name: 'Theme and language settings' })).toBeFocused();
	});
});
