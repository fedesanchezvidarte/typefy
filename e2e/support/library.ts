import { expect, type Page } from '@playwright/test';

/**
 * Container-scoped card locators for `/type` (spec #19, phase 7).
 *
 * `BookCard` is byte-identical whether it renders inside the continue-reading section or the
 * main grid, and a book legitimately appears in both at once — a signed-in user with progress
 * on a book sees it once above the fold (continue reading) and once in the alphabetical grid.
 * That means `data-testid="text-picker-option-<slug>"` is not unique on the page for that user,
 * and a bare `page.getByTestId(...)` throws Playwright's strict-mode "resolved to 2 elements"
 * error instead of failing on the assertion that actually matters.
 *
 * The fix is to scope through the container the spec already gives each section:
 * `text-picker` for the grid, `continue-reading` for the section above it. Use these two
 * helpers instead of a bare `getByTestId('text-picker-option-...')` on `/type` in any spec
 * where the signed-in user might have in-progress books.
 */

export function gridCard(page: Page, slug: string) {
	return page.getByTestId('text-picker').getByTestId(`text-picker-option-${slug}`);
}

export function sectionCard(page: Page, slug: string) {
	return page.getByTestId('continue-reading').getByTestId(`text-picker-option-${slug}`);
}

/* ────────────────────────────────────────────────────────────────────────────────────────
 * Library → detail → typing (spec #34)
 *
 * Since #34 a book card leads to `/books/[slug]`, not straight into `/type/[slug]`: the
 * detail screen is the book's canonical page and the typing surface is what it links INTO.
 * Every spec that previously clicked a card and expected the surface therefore needs one
 * extra hop, through the detail screen's primary action.
 *
 * That hop lives HERE, in one helper, rather than being inlined at each call site. The point
 * is not brevity — it is that the next time the route between the library and the typing
 * surface changes shape, exactly one file has to know. A dozen copies of "click the card,
 * then click the start button" would each be a separate place to forget.
 *
 * These helpers are about REACHING the typing surface. Specs that assert on the detail screen
 * itself (`book-detail.e2e.ts`) address it directly and do not go through here.
 * ──────────────────────────────────────────────────────────────────────────────────────── */

/** The detail screen's primary action — "Start typing" / "Continue typing". */
export function primaryAction(page: Page) {
	return page.getByTestId('book-detail-start');
}

/** A chapter row on the detail screen, addressed by its 0-based chapter index. */
export function chapterRow(page: Page, index: number) {
	return page.getByTestId(`chapter-row-${index}`);
}

/**
 * Click a book card and land on that book's detail screen.
 *
 * Retried, like every other card click in the suite: the card is an `<a>` that SvelteKit
 * intercepts only once the page has hydrated, so an early click either does nothing or
 * performs a full navigation, and both settle into the same place on a retry.
 */
export async function openDetailFromCard(page: Page, slug: string) {
	await expect(async () => {
		await gridCard(page, slug).click();
		await expect(primaryAction(page)).toBeVisible({ timeout: 2000 });
	}).toPass();
}

/**
 * Take the detail screen's primary action and wait until the book is typeable.
 *
 * Resolves with the hidden input focused, which is the same postcondition the pre-#34
 * `pickText` guaranteed — so a caller that swapped one for the other did not quietly lose
 * the "ready to type" part of its arrangement.
 */
export async function startTypingFromDetail(page: Page) {
	await expect(async () => {
		await primaryAction(page).click();
		await expect(page.getByTestId('typing-surface')).toBeVisible({ timeout: 2000 });
	}).toPass();
	await expect(page.getByTestId('typing-input')).toBeFocused();
}

/**
 * The whole library → detail → typing walk for a book already visible in the grid.
 *
 * This is the drop-in replacement for a bare `getByTestId('text-picker-option-…').click()`
 * in any spec whose subject is what happens AFTER the book opens. It deliberately does not
 * navigate first: several callers arrive at `/type` with a query string (`?lang=all`, a
 * search) that is part of their own arrangement.
 */
export async function openBookFromCard(page: Page, slug: string) {
	await openDetailFromCard(page, slug);
	await startTypingFromDetail(page);
}

/** The focused element's `data-testid`, or `''` when focus is on `<body>`. */
export function focusedTestId(page: Page) {
	return page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? '');
}

/**
 * Tab forward until focus lands on `testId`, up to `budget` stops. Returns whether it did.
 *
 * Bounded rather than unbounded so a broken tab order fails as "never reached it in N stops"
 * instead of hanging. The budget is the caller's, because what sits ahead of the target
 * differs per screen.
 */
export async function tabToTestId(page: Page, testId: string, budget: number): Promise<boolean> {
	for (let i = 0; i < budget; i += 1) {
		await page.keyboard.press('Tab');
		if ((await focusedTestId(page)) === testId) return true;
	}
	return false;
}

/**
 * The keyboard-only half of {@link startTypingFromDetail}: Tab to the primary action from
 * wherever the detail screen put initial focus, then Enter.
 *
 * The budget is generous because the walk starts at the top of a freshly loaded document and
 * crosses the whole header (palette, font, language, nav, auth) before reaching `<main>`. Any
 * spec asserting the flow is operable without a pointer goes through here, so the assertion
 * about the detail screen's own reachability lives in one place too.
 */
export async function startTypingByKeyboard(page: Page, budget = 30) {
	await expect(primaryAction(page)).toBeVisible();
	const reached = await tabToTestId(page, 'book-detail-start', budget);
	expect(
		reached,
		`Tab should reach the book detail screen's primary action within ${budget} stops`
	).toBe(true);
	await expect(async () => {
		await page.keyboard.press('Enter');
		await expect(page.getByTestId('typing-surface')).toBeVisible({ timeout: 2000 });
	}).toPass();
	await expect(page.getByTestId('typing-input')).toBeFocused();
}
