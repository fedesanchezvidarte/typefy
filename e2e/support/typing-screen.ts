import { expect, type Page } from '@playwright/test';

/**
 * Shared assertions about the typing screen's chrome, so the ~70 places that check "which page am
 * I on" all point at one element.
 *
 * They needed a home when spec #50 redistributed that chrome. The page number used to read in the
 * header's figures line AND in the page navigator two lines below; the duplicate went and the
 * navigator kept it. Every position assertion routes through `expectPageIs` rather than through
 * `page-meta`, which now carries only the figures.
 */

/**
 * The active page, read off the **page navigator** — its jump box holds the current 1-based page
 * number and `page-nav-total` holds the book's length.
 */
export async function expectPageIs(page: Page, current: number | string, total?: number | string) {
	await expect(page.getByTestId('page-nav-jump')).toHaveValue(String(current));
	if (total !== undefined) {
		await expect(page.getByTestId('page-nav-total')).toContainText(`of ${total}`);
	}
}

/** The figures line: percent, and — outside Zen — WPM and accuracy. */
export function figures(page: Page) {
	return page.getByTestId('page-meta');
}
