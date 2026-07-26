import { page } from 'vitest/browser';
import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { getLocale, overwriteGetLocale } from '$lib/paraglide/runtime';
import type { SessionSummary } from '$lib/engine/session';
import SessionSummaryView from './SessionSummary.svelte';

/**
 * Spec #12 §6: the save-failure notice is a single quiet statement on the summary, in EN
 * and ES. `npm run check:i18n` proves key parity; these assert the rendered strings.
 */
const summary: SessionSummary = {
	averageWpm: 62.4,
	overallAccuracy: 0.97,
	chunksCompleted: 3,
	totalActiveMs: 91_000
};

const noop = () => {};
// `pendingSaves: 0` is the spec #12 baseline these tests describe: every failure permanent,
// so `failedSaves - pendingSaves` is still the whole count and the wording is unchanged.
// The pending/lost split itself is Phase 7's to cover.
const baseProps = {
	summary,
	onRestartSession: noop,
	onPickAnother: noop,
	pendingSaves: 0,
	signedIn: true,
	next: '/type/test-book'
};

// `getLocale` is a mutable binding in the Paraglide runtime; capture the shipped
// implementation so each test restores it rather than leaking a locale to the next.
const shippedGetLocale = getLocale;

afterEach(() => {
	overwriteGetLocale(shippedGetLocale);
});

describe('SessionSummary.svelte — save-failure notice (spec #12 §6)', () => {
	it('states the failure count in English', async () => {
		overwriteGetLocale(() => 'en');

		render(SessionSummaryView, { ...baseProps, failedSaves: 2 });

		await expect
			.element(page.getByTestId('summary-save-failures'))
			.toHaveTextContent("2 passages couldn't be saved.");
	});

	it('states the failure count in Spanish', async () => {
		overwriteGetLocale(() => 'es');

		render(SessionSummaryView, { ...baseProps, failedSaves: 2 });

		await expect
			.element(page.getByTestId('summary-save-failures'))
			.toHaveTextContent('No se pudieron guardar 2 pasajes.');
	});

	it('renders no notice at all when nothing failed to save', async () => {
		render(SessionSummaryView, { ...baseProps, failedSaves: 0 });

		// The summary itself rendered — the notice is absent because the count is 0,
		// not because the component failed to mount.
		await expect.element(page.getByTestId('session-summary')).toBeInTheDocument();
		expect(page.getByTestId('summary-save-failures').query()).toBeNull();
	});
});
