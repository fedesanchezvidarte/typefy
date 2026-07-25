import { expect, test } from '@playwright/test';

const EN_HEADLINE = 'Type through a book, one passage at a time.';
const ES_HEADLINE = 'Escribe un libro entero, pasaje a pasaje.';

test.describe('landing page', () => {
	test('/ renders the English UI', async ({ page }) => {
		await page.goto('/');
		await expect(page.locator('html')).toHaveAttribute('lang', 'en');
		await expect(page.getByRole('heading', { level: 1 })).toHaveText(EN_HEADLINE);
	});

	test('/es renders the Spanish UI', async ({ page }) => {
		await page.goto('/es');
		await expect(page.locator('html')).toHaveAttribute('lang', 'es');
		await expect(page.getByRole('heading', { level: 1 })).toHaveText(ES_HEADLINE);
	});

	test('the hero is a live typing surface: focused on load, first keystrokes fill in', async ({
		page
	}) => {
		await page.goto('/');
		await expect(page.getByTestId('landing-hero')).toBeVisible();
		// Already focused — the concept explains itself on the first keystroke.
		await expect(page.getByTestId('typing-input')).toBeFocused();

		// The click-to-focus fallback plus real typing (hydration-safe retry).
		const chars = page.locator('[data-testid="typing-surface"] .char');
		await expect(async () => {
			await page.getByTestId('typing-surface').click();
			await page.keyboard.type('It', { delay: 0 });
			await expect(chars.nth(0)).toHaveAttribute('data-state', 'correct', { timeout: 1000 });
		}).toPass();
		await expect(chars.nth(1)).toHaveAttribute('data-state', 'correct');
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
		await expect(page.getByText(ES_HEADLINE)).toBeVisible();

		// The saved preference (cookie) wins on a fresh unprefixed visit.
		await page.goto('/');
		await expect(page).toHaveURL(/\/es\/?$/);
		await expect(page.getByText(ES_HEADLINE)).toBeVisible();

		// Switching back to English updates the cookie too.
		await expect(async () => {
			await page.getByRole('button', { name: 'English' }).click();
			await expect(page.locator('html')).toHaveAttribute('lang', 'en', { timeout: 2000 });
		}).toPass();
		await expect(page.getByText(EN_HEADLINE)).toBeVisible();
	});
});

test.describe('first-visit language negotiation', () => {
	test.describe('browser prefers Spanish', () => {
		test.use({ locale: 'es-ES' });

		test('lands on the Spanish UI', async ({ page }) => {
			await page.goto('/');
			await expect(page).toHaveURL(/\/es\/?$/);
			await expect(page.getByText(ES_HEADLINE)).toBeVisible();
		});
	});

	test.describe('browser prefers an unsupported language', () => {
		test.use({ locale: 'fr-FR' });

		test('falls back to English', async ({ page }) => {
			await page.goto('/');
			await expect(page.locator('html')).toHaveAttribute('lang', 'en');
			await expect(page.getByText(EN_HEADLINE)).toBeVisible();
		});
	});
});
