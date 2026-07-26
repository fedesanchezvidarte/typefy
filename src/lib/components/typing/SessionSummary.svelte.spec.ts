import { page } from 'vitest/browser';
import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { getLocale, overwriteGetLocale } from '$lib/paraglide/runtime';
import type { SessionSummary } from '$lib/engine/session';
import { ATTEMPT_BUFFER_CAP } from '$lib/progress/buffer';
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

/** The same summary at a single completed passage — the `one` arm of every count message. */
const oneChunkSummary: SessionSummary = { ...summary, chunksCompleted: 1 };

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

/**
 * The `one` arm of every variant message on this summary, in both locales (spec #15 §9 and
 * the phase B2 amendment).
 *
 * Every other assertion in this file — and every one in `TypingSession.svelte.spec.ts` —
 * sits on the catch-all `countPlural=*` arm, so before these tests a missing or mistranslated
 * `one` arm rendered nothing anyone looked at. The variant-aware parity gate catches an
 * absent arm; only a rendering test catches an arm that exists and says the wrong thing, or
 * an arm the component never selects because it passed the wrong number. Hence both locales
 * for all four keys, asserted as whole strings rather than substrings.
 */
describe('SessionSummary.svelte — the singular arm of every count message (spec #15 §9)', () => {
	const singularProps = {
		...baseProps,
		summary: oneChunkSummary,
		failedSaves: 1,
		pendingSaves: 0
	};

	it('reads the heading, the lost-save notice and the guest prompt in the singular in English', async () => {
		overwriteGetLocale(() => 'en');

		render(SessionSummaryView, { ...singularProps, signedIn: false });

		await expect
			.element(page.getByTestId('session-summary'))
			.toHaveTextContent('You read one passage.');
		await expect
			.element(page.getByTestId('summary-save-failures'))
			.toHaveTextContent("One passage couldn't be saved.");
		await expect
			.element(page.getByTestId('summary-sign-in-prompt'))
			.toHaveTextContent('Sign in to save the passage you just typed');
	});

	it('reads the heading, the lost-save notice and the guest prompt in the singular in Spanish', async () => {
		overwriteGetLocale(() => 'es');

		render(SessionSummaryView, { ...singularProps, signedIn: false });

		await expect
			.element(page.getByTestId('session-summary'))
			.toHaveTextContent('Leíste un pasaje.');
		await expect
			.element(page.getByTestId('summary-save-failures'))
			.toHaveTextContent('No se pudo guardar un pasaje.');
		await expect
			.element(page.getByTestId('summary-sign-in-prompt'))
			.toHaveTextContent('Inicia sesión para guardar el pasaje que acabas de escribir');
	});

	it('states a single pending save in the singular in English', async () => {
		overwriteGetLocale(() => 'en');

		render(SessionSummaryView, { ...baseProps, failedSaves: 1, pendingSaves: 1 });

		await expect
			.element(page.getByTestId('summary-save-pending'))
			.toHaveTextContent("One passage will be saved when you're back online.");
		// The one failure was the pending one, so nothing is claimed as lost.
		expect(page.getByTestId('summary-save-failures').query()).toBeNull();
	});

	it('states a single pending save in the singular in Spanish', async () => {
		overwriteGetLocale(() => 'es');

		render(SessionSummaryView, { ...baseProps, failedSaves: 1, pendingSaves: 1 });

		await expect
			.element(page.getByTestId('summary-save-pending'))
			.toHaveTextContent('Un pasaje se guardará cuando vuelvas a tener conexión.');
		expect(page.getByTestId('summary-save-failures').query()).toBeNull();
	});
});

/**
 * The pending/lost split (spec #15 §9), which is the whole reason `failedSaves` and
 * `pendingSaves` are two props rather than one.
 */
describe('SessionSummary.svelte — the pending/lost split', () => {
	it('states both counts separately when a session has some of each', async () => {
		overwriteGetLocale(() => 'en');

		// Four failures, one of them buffered: 1 pending, 3 lost. The interesting case is
		// that neither notice may show the TOTAL — reporting 4 as pending would promise a
		// save that will never come, and reporting 4 as lost would bury a recoverable one.
		render(SessionSummaryView, { ...baseProps, failedSaves: 4, pendingSaves: 1 });

		await expect
			.element(page.getByTestId('summary-save-pending'))
			.toHaveTextContent("One passage will be saved when you're back online.");
		await expect
			.element(page.getByTestId('summary-save-failures'))
			.toHaveTextContent("3 passages couldn't be saved.");
	});

	it('states both counts separately in Spanish', async () => {
		overwriteGetLocale(() => 'es');

		render(SessionSummaryView, { ...baseProps, failedSaves: 4, pendingSaves: 1 });

		await expect
			.element(page.getByTestId('summary-save-pending'))
			.toHaveTextContent('Un pasaje se guardará cuando vuelvas a tener conexión.');
		await expect
			.element(page.getByTestId('summary-save-failures'))
			.toHaveTextContent('No se pudieron guardar 3 pasajes.');
	});

	it('reports nothing as lost when every failure was buffered', async () => {
		render(SessionSummaryView, { ...baseProps, failedSaves: 3, pendingSaves: 3 });

		await expect.element(page.getByTestId('summary-save-pending')).toBeInTheDocument();
		expect(page.getByTestId('summary-save-failures').query()).toBeNull();
	});
});

/**
 * The guest sign-in prompt's count (spec #15 §9), including the buffer-cap clamp — the one
 * place the summary makes a *promise* about what signing in will recover, so the number has
 * to be one the buffer can actually keep.
 */
describe('SessionSummary.svelte — the guest sign-in prompt count', () => {
	const guestProps = { ...baseProps, failedSaves: 0, pendingSaves: 0, signedIn: false };

	it('names the session count when it is below the buffer cap', async () => {
		overwriteGetLocale(() => 'en');

		render(SessionSummaryView, guestProps); // summary.chunksCompleted === 3

		await expect
			.element(page.getByTestId('summary-sign-in-prompt'))
			.toHaveTextContent('Sign in to save the 3 passages you just typed');
	});

	it('names exactly the cap at the cap', async () => {
		overwriteGetLocale(() => 'en');

		render(SessionSummaryView, {
			...guestProps,
			summary: { ...summary, chunksCompleted: ATTEMPT_BUFFER_CAP }
		});

		await expect
			.element(page.getByTestId('summary-sign-in-prompt'))
			.toHaveTextContent(`Sign in to save the ${ATTEMPT_BUFFER_CAP} passages you just typed`);
	});

	it('clamps to the cap past it, so the promise never exceeds what the buffer kept', async () => {
		overwriteGetLocale(() => 'en');

		// Past the cap `enqueue` evicts oldest-first, so a 57-passage session has exactly
		// `ATTEMPT_BUFFER_CAP` recoverable passages. Naming 57 would be a lie.
		render(SessionSummaryView, {
			...guestProps,
			summary: { ...summary, chunksCompleted: ATTEMPT_BUFFER_CAP + 7 }
		});

		const prompt = page.getByTestId('summary-sign-in-prompt');
		await expect
			.element(prompt)
			.toHaveTextContent(`Sign in to save the ${ATTEMPT_BUFFER_CAP} passages you just typed`);
		expect(prompt.element().textContent).not.toContain(String(ATTEMPT_BUFFER_CAP + 7));
	});

	it('falls back to the countless wording when nothing was completed', async () => {
		overwriteGetLocale(() => 'en');

		// Reachable: the summary also renders after a session restarted before any passage
		// finished, and "save the 0 passages you just typed" has no honest reading.
		render(SessionSummaryView, { ...guestProps, summary: { ...summary, chunksCompleted: 0 } });

		await expect
			.element(page.getByTestId('summary-sign-in-prompt'))
			.toHaveTextContent('Sign in to save your progress');
	});

	it('shows no prompt at all to a signed-in user', async () => {
		render(SessionSummaryView, { ...guestProps, signedIn: true });

		await expect.element(page.getByTestId('session-summary')).toBeInTheDocument();
		expect(page.getByTestId('summary-sign-in-prompt').query()).toBeNull();
	});
});
