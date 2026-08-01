import { expect, test } from '@playwright/test';
import {
	isLocalStack,
	localSecretKey,
	secretClient,
	SUPABASE_URL,
	type AnyClient
} from './support/supabase';
import { setFeatured } from './support/probe-books';
import { prideAndPrejudiceExcerpt } from '../src/lib/fixtures/en';

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

	/**
	 * The hero exists only when a book is FEATURED (spec #18 §7).
	 *
	 * Before 3b the hero was whichever English book sorted first, so it was there on any
	 * seeded database and this test needed no arrangement. It reads `books.featured` now, and
	 * nothing seeds that flag — not the seed migration, not the ingestion manifest — so on a
	 * freshly reset stack `getHeroBook` returns null, the route takes its defined no-hero
	 * fallback, and there is simply no hero to smoke-test.
	 *
	 * Seeding `featured` is deliberately NOT the fix. The generated seed migration ships to
	 * production too (ADR-0006's 3a amendment), so a featured `en` fixture would collide with
	 * `books_featured_per_language_idx` the moment §11 publishes `pride-and-prejudice` — and
	 * Phase 4's "refusing to move the landing hero" guard would fail that publish run loudly.
	 * A heroless dev landing page is the cheaper problem, so the TEST arranges its own hero,
	 * exactly as `windowed-reading.e2e.ts` does.
	 *
	 * A SEEDED book rather than a probe: this is a smoke test of the real landing route, and it
	 * should exercise real catalog content. Pride and Prejudice is `en`, so every
	 * English-language assertion in this file still holds, and its first chunk opens with
	 * "It" — which is what makes the two keystrokes below the right input.
	 */
	test.describe('the hero', () => {
		test.skip(
			!isLocalStack,
			`refusing to feature a book against a non-local Supabase (${SUPABASE_URL})`
		);
		test.skip(
			!localSecretKey(),
			'needs the local secret key: no client role may feature a book, and none should'
		);

		let service: AnyClient;

		test.beforeAll(async () => {
			service = secretClient()!;
			await setFeatured(service, prideAndPrejudiceExcerpt.id, true);
		});

		test.afterAll(async () => {
			// Unconditional, so a failure inside the test body cannot leave the single featured-EN
			// slot taken: `resume-rpc.e2e.ts` pins that index and would fail on a slot this file
			// never released, in a file that never touched the hero.
			await setFeatured(service, prideAndPrejudiceExcerpt.id, false);
		});

		test('is a live typing surface: focused on load, first keystrokes fill in', async ({
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
