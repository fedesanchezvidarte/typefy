import type { Page } from '@playwright/test';

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
