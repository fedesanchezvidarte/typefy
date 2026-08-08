import { expect, test, type Page } from '@playwright/test';
import {
	isLocalStack,
	localSecretKey,
	secretClient,
	SUPABASE_URL,
	type AnyClient
} from './support/supabase';
import { setFeatured } from './support/probe-books';
import { prideAndPrejudiceExcerpt } from '../src/lib/fixtures/en';

/**
 * The static prefix + first tail word ("book" / "un libro") — the ALWAYS-true accessible
 * name of the landing <h1> (spec #30), regardless of the animated tail's current frame.
 * The visible text now animates (book → page → passage → word, looping), so a literal
 * text-content assertion would be flaky/wrong; `getByRole('heading', { name })` resolves
 * through Playwright's accessible-name computation, which reads the `sr-only` span, not
 * the `aria-hidden` animated one.
 */
const EN_HEADLINE = 'Type through a book';
const ES_HEADLINE = 'Escribe un libro';

/**
 * The language switcher moved off the header row into the pencil trigger's ribbon panel
 * (spec #30 §2) — its buttons aren't interactable, let alone visible, until the panel is
 * opened. Retried: the click only takes effect once the page has hydrated.
 *
 * Opens via `data-testid`, not the trigger's accessible name: this test switches locale
 * mid-run (English → Spanish → English), and `header_pencil_aria_label` is itself localized
 * (see `messages/en.json` / `messages/es.json`), so a role-name lookup for the English string
 * would stop resolving the moment the UI is in Spanish. The testid is locale-invariant; the
 * accessible name itself is exercised in `account.e2e.ts`'s and `theme.e2e.ts`'s a11y specs.
 */
async function openPencilPanel(page: Page) {
	await expect(async () => {
		await page.getByTestId('pencil-trigger').click();
		await expect(page.getByRole('button', { name: 'English' })).toBeVisible({ timeout: 2000 });
	}).toPass();
}

test.describe('landing page', () => {
	test('/ renders the English UI', async ({ page }) => {
		await page.goto('/');
		await expect(page.locator('html')).toHaveAttribute('lang', 'en');
		await expect(page.getByRole('heading', { level: 1, name: EN_HEADLINE })).toBeVisible();
	});

	test('/es renders the Spanish UI', async ({ page }) => {
		await page.goto('/es');
		await expect(page.locator('html')).toHaveAttribute('lang', 'es');
		await expect(page.getByRole('heading', { level: 1, name: ES_HEADLINE })).toBeVisible();
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
		await openPencilPanel(page);

		// The click only works once the page has hydrated; retry until it takes effect.
		await expect(async () => {
			await page.getByRole('button', { name: 'Español' }).click();
			await expect(page).toHaveURL(/\/es\/?$/, { timeout: 2000 });
		}).toPass();

		await expect(page.locator('html')).toHaveAttribute('lang', 'es');
		await expect(page.getByRole('heading', { level: 1, name: ES_HEADLINE })).toBeVisible();

		// The saved preference (cookie) wins on a fresh unprefixed visit.
		await page.goto('/');
		await expect(page).toHaveURL(/\/es\/?$/);
		await expect(page.getByRole('heading', { level: 1, name: ES_HEADLINE })).toBeVisible();

		// Switching back to English updates the cookie too.
		await openPencilPanel(page);
		await expect(async () => {
			await page.getByRole('button', { name: 'English' }).click();
			await expect(page.locator('html')).toHaveAttribute('lang', 'en', { timeout: 2000 });
		}).toPass();
		await expect(page.getByRole('heading', { level: 1, name: EN_HEADLINE })).toBeVisible();
	});

	/**
	 * `AnimatedHeadline` gates its own type/backspace cycle behind
	 * `matchMedia('(prefers-reduced-motion: reduce)')` (see the component's `reducedMotion()`
	 * guard in its mount `$effect`) and its CSS disables the caret's blink keyframe under the
	 * same media query. Nothing in the existing landing-page or a11y specs sets
	 * `reducedMotion: 'reduce'`, so this is the only place that claim is actually exercised.
	 */
	test.describe('reduced motion', () => {
		test('the animated headline never starts its type/backspace cycle', async ({ page }) => {
			// `page.emulateMedia` rather than `test.use({ reducedMotion: 'reduce' })`: the
			// context-option form does not reach `matchMedia` in this Chromium/Playwright
			// combination (verified directly — `window.matchMedia('(prefers-reduced-motion:
			// reduce)').matches` stayed `false` under it), while `emulateMedia` before
			// navigation does.
			await page.emulateMedia({ reducedMotion: 'reduce' });
			await page.goto('/');
			const tail = page.locator('h1 .tail');
			const initialText = await tail.textContent();

			// The cycle's first hold is 1800ms (HOLD_MS) before it would start backspacing;
			// waiting past that plus a few character-interval steps is enough to catch a cycle
			// that ignored the media query, without coupling the test to the exact constant.
			await page.waitForTimeout(2500);

			await expect(tail).toHaveText(initialText ?? '');
			// The heading's accessible name (the sr-only span) is unaffected either way — a
			// static assertion, not one this test needs to repeat from the smoke test above.
			await expect(page.getByRole('heading', { level: 1, name: EN_HEADLINE })).toBeVisible();
		});
	});
});

test.describe('first-visit language negotiation', () => {
	test.describe('browser prefers Spanish', () => {
		test.use({ locale: 'es-ES' });

		test('lands on the Spanish UI', async ({ page }) => {
			await page.goto('/');
			await expect(page).toHaveURL(/\/es\/?$/);
			await expect(page.getByRole('heading', { level: 1, name: ES_HEADLINE })).toBeVisible();
		});
	});

	test.describe('browser prefers an unsupported language', () => {
		test.use({ locale: 'fr-FR' });

		test('falls back to English', async ({ page }) => {
			await page.goto('/');
			await expect(page.locator('html')).toHaveAttribute('lang', 'en');
			await expect(page.getByRole('heading', { level: 1, name: EN_HEADLINE })).toBeVisible();
		});
	});
});
