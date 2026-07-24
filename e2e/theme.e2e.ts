import { expect, test, type Page } from '@playwright/test';

/**
 * Two-axis theming (spec #9, ADR-0011): palette and font are independent,
 * cookie-persisted, applied as data attributes on <html> with no FOUC, and the
 * system colour scheme only picks the initial default.
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

test.describe('palette axis', () => {
	test('a palette dot applies instantly and survives a reload via cookie', async ({ page }) => {
		await page.goto('/');

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
	test('a font choice applies instantly, survives reload, and never touches the palette', async ({
		page
	}) => {
		await page.goto('/');

		// Fix the palette first so axis independence is observable.
		await expect(async () => {
			await page.getByRole('button', { name: 'Warm light' }).click();
			await expect(page.locator('html')).toHaveAttribute('data-palette', 'warm-light', {
				timeout: 2000
			});
		}).toPass();

		await page.getByRole('button', { name: 'Serif' }).click();
		await expect(page.locator('html')).toHaveAttribute('data-font', 'serif');
		const family = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
		expect(family).toContain('IBM Plex Serif');

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
