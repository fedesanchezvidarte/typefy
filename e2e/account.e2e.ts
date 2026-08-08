import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, guestTest, test } from './fixtures/auth';
import { isLocalStack, SUPABASE_URL } from './support/supabase';

/**
 * Phase 5a (spec #30 §2): the avatar/account menu, relocated off the header row into
 * `AccountMenu`'s ribbon panel, and — the spec's own acceptance criterion — a full sign-out
 * flow driven through the UI (avatar open → Sign out click → signed-out state), which no
 * existing spec exercised before this pass (every other fixture manipulates cookies
 * directly; see `e2e/fixtures/auth.ts`'s file comment).
 */

function avatarTrigger(page: Page) {
	return page.getByTestId('avatar-trigger');
}

/** Opens the account menu via its trigger, retried for the same hydration-safe reason every
 *  other first-interaction click in this suite is retried. */
async function openAccountMenu(page: Page) {
	await expect(async () => {
		await avatarTrigger(page).click();
		await expect(page.getByTestId('auth-sign-out')).toBeVisible({ timeout: 2000 });
	}).toPass();
}

test.describe('account menu', () => {
	test.skip(
		!isLocalStack,
		`refusing to create throwaway users against a non-local Supabase (${SUPABASE_URL})`
	);

	test('shows the signed-in user’s name and email once opened', async ({ page, authUser }) => {
		await page.goto('/');
		await expect(avatarTrigger(page)).toHaveAttribute('aria-expanded', 'false');

		await openAccountMenu(page);
		await expect(avatarTrigger(page)).toHaveAttribute('aria-expanded', 'true');
		// A dedicated testid, not getByText(email): the e2e fixture's display name IS its
		// email (no full_name/name in user_metadata), so a text locator resolves to both the
		// name and email paragraphs and trips Playwright's strict mode.
		await expect(page.getByTestId('account-email')).toHaveText(authUser.email);
	});

	test('the Profile link opens the profile stub', async ({ page }) => {
		await page.goto('/');
		await openAccountMenu(page);

		await page.getByTestId('account-profile-link').click();
		await expect(page).toHaveURL(/\/profile\/?$/);
	});

	test('sign-out via the UI: open the avatar menu, click Sign out, land signed out', async ({
		page
	}) => {
		await page.goto('/type');
		await expect(page.getByTestId('text-picker')).toBeVisible();
		await openAccountMenu(page);

		await page.getByTestId('auth-sign-out').click();

		// Back on the page it started from (the "next" round-trip AuthControl always did),
		// but now signed out: the avatar trigger is gone and the guest Sign-in button is back.
		await expect(page).toHaveURL(/\/type\/?(\?.*)?$/);
		await expect(avatarTrigger(page)).toHaveCount(0);
		await expect(page.getByTestId('auth-sign-in')).toBeVisible();

		// The session is genuinely gone, not just the header's local state: a reload still
		// shows the guest header rather than a signed-in one that only *looked* logged out.
		await page.reload();
		await expect(page.getByTestId('auth-sign-in')).toBeVisible();
		await expect(avatarTrigger(page)).toHaveCount(0);
	});

	test('outside click and Escape both close the panel', async ({ page }) => {
		await page.goto('/');
		await openAccountMenu(page);
		await page.mouse.click(10, 10);
		await expect(page.getByTestId('auth-sign-out')).toBeHidden();

		await openAccountMenu(page);
		await page.keyboard.press('Escape');
		await expect(page.getByTestId('auth-sign-out')).toBeHidden();
		await expect(avatarTrigger(page)).toBeFocused();
	});
});

guestTest.describe('profile stub route', () => {
	guestTest('a guest hitting /profile directly is redirected to /', async ({ page }) => {
		await page.goto('/profile');
		await expect.poll(() => new URL(page.url()).pathname).toMatch(/^\/(es)?\/?$/);
	});
});

/**
 * Phase 8 (accessibility), same gate as `library.e2e.ts`'s and `windowed-reading.e2e.ts`'s
 * a11y blocks: zero critical/serious axe violations, no colour-contrast carve-out (spec #25
 * §1 removed it project-wide). Covers the two states unique to this pass — pencil panel open,
 * account menu open — plus a keyboard-only walk through both triggers.
 */
test.describe('header accessibility (phase 8)', () => {
	async function seriousViolations(page: Page) {
		const results = await new AxeBuilder({ page }).analyze();
		return results.violations
			.filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
			.map((violation) => `${violation.impact}: ${violation.id} — ${violation.help}`);
	}

	test('the pencil panel, open, has no serious violations', async ({ page }) => {
		await page.goto('/');
		await expect(async () => {
			await page.getByRole('button', { name: 'Theme and language settings' }).click();
			await expect(page.getByRole('button', { name: 'Sans' })).toBeVisible({ timeout: 2000 });
		}).toPass();
		expect(await seriousViolations(page), 'axe: /, pencil panel open').toEqual([]);
	});

	test('the account menu, open, has no serious violations', async ({ page }) => {
		await page.goto('/');
		await openAccountMenu(page);
		expect(await seriousViolations(page), 'axe: /, account menu open').toEqual([]);
	});

	/** Tabs forward until it lands on `name` (the element's accessible label), bounded so a
	 *  control dropped from the tab sequence fails loudly rather than hanging. */
	async function tabToRole(page: Page, name: string, budget: number) {
		for (let i = 0; i < budget; i += 1) {
			await page.keyboard.press('Tab');
			const activeName = await page.evaluate(
				() => document.activeElement?.getAttribute('aria-label') ?? ''
			);
			if (activeName === name) return true;
		}
		return false;
	}

	guestTest(
		'the library link and pencil trigger are reachable and operable by keyboard alone, guest',
		async ({ page }) => {
			await page.goto('/');

			expect(await tabToRole(page, 'Library', 10)).toBe(true);
			expect(await tabToRole(page, 'Theme and language settings', 3)).toBe(true);

			// Enter opens the pencil panel from the keyboard, not just a click. Retried: the
			// first keyboard interaction on a fresh navigation can race hydration, the same
			// reason every other first-interaction click in this suite is retried (see
			// `openPencilPanel`/`openAccountMenu`) — Enter is no exception, it just has no
			// existing helper to inherit the retry from.
			await expect(async () => {
				await page.keyboard.press('Enter');
				await expect(page.getByRole('button', { name: 'Sans' })).toBeVisible({ timeout: 500 });
			}).toPass();

			// Escape closes it and focus returns to the trigger — never lost to <body>.
			await page.keyboard.press('Escape');
			await expect(page.getByRole('button', { name: 'Theme and language settings' })).toBeFocused();

			// Signed out, the guest Sign-in button — not an avatar trigger — is the next stop,
			// and it is a plain submit button reachable the same way.
			await expect(async () => {
				await page.keyboard.press('Tab');
				await expect(page.getByTestId('auth-sign-in')).toBeFocused({ timeout: 500 });
			}).toPass();
		}
	);

	test('the avatar trigger is reachable and operable by keyboard alone, signed in', async ({
		page,
		authUser
	}) => {
		test.skip(
			!isLocalStack,
			`refusing to create throwaway users against a non-local Supabase (${SUPABASE_URL})`
		);
		void authUser;
		await page.goto('/');

		expect(await tabToRole(page, 'Account menu', 15)).toBe(true);
		// Retried for the same hydration-race reason as the guest test above.
		await expect(async () => {
			await page.keyboard.press('Enter');
			await expect(page.getByTestId('auth-sign-out')).toBeVisible({ timeout: 500 });
		}).toPass();

		// Escape closes it and focus returns to the trigger — never lost to <body>.
		await page.keyboard.press('Escape');
		await expect(page.getByRole('button', { name: 'Account menu' })).toBeFocused();
	});
});
