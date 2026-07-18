import { expect, test } from '@playwright/test';

const EN_TAGLINE = 'Read and type long texts at the same time.';
const ES_TAGLINE = 'Lee y escribe textos largos al mismo tiempo.';

test.describe('placeholder page', () => {
	test('/ renders the English UI', async ({ page }) => {
		await page.goto('/');
		await expect(page.locator('html')).toHaveAttribute('lang', 'en');
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('Typefy');
		await expect(page.getByText(EN_TAGLINE)).toBeVisible();
	});

	test('/es renders the Spanish UI', async ({ page }) => {
		await page.goto('/es');
		await expect(page.locator('html')).toHaveAttribute('lang', 'es');
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('Typefy');
		await expect(page.getByText(ES_TAGLINE)).toBeVisible();
	});

	test('language switcher toggles the locale and the preference persists via cookie', async ({
		page
	}) => {
		await page.goto('/');

		// The click only works once the page has hydrated; retry until it takes effect.
		await expect(async () => {
			await page.getByRole('button', { name: 'Español' }).click();
			await expect(page).toHaveURL(/\/es\/?$/, { timeout: 2000 });
		}).toPass();

		await expect(page.locator('html')).toHaveAttribute('lang', 'es');
		await expect(page.getByText(ES_TAGLINE)).toBeVisible();

		// The saved preference (cookie) wins on a fresh unprefixed visit.
		await page.goto('/');
		await expect(page).toHaveURL(/\/es\/?$/);
		await expect(page.getByText(ES_TAGLINE)).toBeVisible();

		// Switching back to English updates the cookie too.
		await expect(async () => {
			await page.getByRole('button', { name: 'English' }).click();
			await expect(page.locator('html')).toHaveAttribute('lang', 'en', { timeout: 2000 });
		}).toPass();
		await expect(page.getByText(EN_TAGLINE)).toBeVisible();
	});
});

test.describe('first-visit language negotiation', () => {
	test.describe('browser prefers Spanish', () => {
		test.use({ locale: 'es-ES' });

		test('lands on the Spanish UI', async ({ page }) => {
			await page.goto('/');
			await expect(page).toHaveURL(/\/es\/?$/);
			await expect(page.getByText(ES_TAGLINE)).toBeVisible();
		});
	});

	test.describe('browser prefers an unsupported language', () => {
		test.use({ locale: 'fr-FR' });

		test('falls back to English', async ({ page }) => {
			await page.goto('/');
			await expect(page.locator('html')).toHaveAttribute('lang', 'en');
			await expect(page.getByText(EN_TAGLINE)).toBeVisible();
		});
	});
});
