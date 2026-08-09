import { page, userEvent } from 'vitest/browser';
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
			.toHaveTextContent("2 pages couldn't be saved.");
	});

	it('states the failure count in Spanish', async () => {
		overwriteGetLocale(() => 'es');

		render(SessionSummaryView, { ...baseProps, failedSaves: 2 });

		await expect
			.element(page.getByTestId('summary-save-failures'))
			.toHaveTextContent('No se pudieron guardar 2 páginas.');
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
			.toHaveTextContent('You read one page.');
		await expect
			.element(page.getByTestId('summary-save-failures'))
			.toHaveTextContent("One page couldn't be saved.");
		await expect
			.element(page.getByTestId('summary-sign-in-prompt'))
			.toHaveTextContent('Sign in to save the page you just typed');
	});

	it('reads the heading, the lost-save notice and the guest prompt in the singular in Spanish', async () => {
		overwriteGetLocale(() => 'es');

		render(SessionSummaryView, { ...singularProps, signedIn: false });

		await expect
			.element(page.getByTestId('session-summary'))
			.toHaveTextContent('Leíste una página.');
		await expect
			.element(page.getByTestId('summary-save-failures'))
			.toHaveTextContent('No se pudo guardar una página.');
		await expect
			.element(page.getByTestId('summary-sign-in-prompt'))
			.toHaveTextContent('Inicia sesión para guardar la página que acabas de escribir');
	});

	it('states a single pending save in the singular in English', async () => {
		overwriteGetLocale(() => 'en');

		render(SessionSummaryView, { ...baseProps, failedSaves: 1, pendingSaves: 1 });

		await expect
			.element(page.getByTestId('summary-save-pending'))
			.toHaveTextContent("One page will be saved when you're back online.");
		// The one failure was the pending one, so nothing is claimed as lost.
		expect(page.getByTestId('summary-save-failures').query()).toBeNull();
	});

	it('states a single pending save in the singular in Spanish', async () => {
		overwriteGetLocale(() => 'es');

		render(SessionSummaryView, { ...baseProps, failedSaves: 1, pendingSaves: 1 });

		await expect
			.element(page.getByTestId('summary-save-pending'))
			.toHaveTextContent('Una página se guardará cuando vuelvas a tener conexión.');
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
			.toHaveTextContent("One page will be saved when you're back online.");
		await expect
			.element(page.getByTestId('summary-save-failures'))
			.toHaveTextContent("3 pages couldn't be saved.");
	});

	it('states both counts separately in Spanish', async () => {
		overwriteGetLocale(() => 'es');

		render(SessionSummaryView, { ...baseProps, failedSaves: 4, pendingSaves: 1 });

		await expect
			.element(page.getByTestId('summary-save-pending'))
			.toHaveTextContent('Una página se guardará cuando vuelvas a tener conexión.');
		await expect
			.element(page.getByTestId('summary-save-failures'))
			.toHaveTextContent('No se pudieron guardar 3 páginas.');
	});

	it('reports nothing as lost when every failure was buffered', async () => {
		render(SessionSummaryView, { ...baseProps, failedSaves: 3, pendingSaves: 3 });

		await expect.element(page.getByTestId('summary-save-pending')).toBeInTheDocument();
		expect(page.getByTestId('summary-save-failures').query()).toBeNull();
	});
});

/**
 * Announcement semantics of the save notices (phase 8, WCAG 2.2 SC 4.1.3).
 *
 * The counts these notices render do not all exist at mount: the session's LAST passage is
 * completed by the keystroke that finishes the session, so its write is still in flight when
 * this component mounts and takes focus, and its outcome raises `pendingSaves`/`failedSaves`
 * a network round-trip later. `TypingSession.svelte.spec.ts` proves that ordering against the
 * real component; these tests pin the markup that makes the late arrival audible.
 *
 * The load-bearing assertion is that the region is present when EMPTY. A live region built at
 * the same moment its content arrives is not announced at all, so a wrapper guarded by the
 * counts would look correct and be silent — which is precisely the defect this replaced.
 */
describe('SessionSummary.svelte — the save notices are an announced status region', () => {
	/** The one region, addressed the way an assistive technology resolves it. */
	function statusRegion() {
		return page.getByTestId('session-summary').element().querySelector('[role="status"]');
	}

	it('renders the status region even when there is nothing to announce yet', async () => {
		render(SessionSummaryView, { ...baseProps, failedSaves: 0, pendingSaves: 0 });

		await expect.element(page.getByTestId('session-summary')).toBeInTheDocument();
		const region = statusRegion();
		expect(
			region,
			'the region must pre-exist its content or the insertion is silent'
		).not.toBeNull();
		// Present but saying nothing, and costing no vertical space.
		expect(region?.textContent?.trim()).toBe('');
		expect(region?.className).not.toContain('mb-3');
	});

	it('announces a notice that arrives after mount, in the region that was already there', async () => {
		// Mounted with no failure known yet — the state the summary is genuinely in while the
		// final passage's write is still outstanding.
		const screen = render(SessionSummaryView, {
			...baseProps,
			failedSaves: 0,
			pendingSaves: 0
		});
		const regionBefore = statusRegion();
		expect(regionBefore).not.toBeNull();

		// The write comes back transient, exactly as it does offline.
		await screen.rerender({ ...baseProps, failedSaves: 1, pendingSaves: 1 });

		await expect.element(page.getByTestId('summary-save-pending')).toBeInTheDocument();
		// The SAME node: the notice was inserted into an established region rather than
		// arriving with a freshly-built one, which is what makes it announceable.
		expect(statusRegion()).toBe(regionBefore);
		expect(statusRegion()?.className).toContain('mb-3');
	});

	it('keeps both notices inside the one region, so the pair is announced as a single status', async () => {
		render(SessionSummaryView, { ...baseProps, failedSaves: 4, pendingSaves: 1 });

		const region = statusRegion();
		expect(region?.querySelector('[data-testid="summary-save-pending"]')).not.toBeNull();
		expect(region?.querySelector('[data-testid="summary-save-failures"]')).not.toBeNull();
		// `role="status"` is implicitly atomic, so one region for both is what keeps a late
		// second notice from being read without the first.
		expect(region?.getAttribute('aria-live')).toBeNull(); // implicit from the role, not duplicated
	});

	it('places the notices between the figures and the buttons, so reading order is unchanged', async () => {
		render(SessionSummaryView, { ...baseProps, failedSaves: 2, pendingSaves: 1 });

		const section = page.getByTestId('session-summary').element();
		const order = [...section.querySelectorAll('h1, dl, [role="status"], button')].map(
			(node) => node.getAttribute('data-testid') ?? node.tagName.toLowerCase()
		);
		expect(order).toEqual([
			'h1',
			'dl',
			'div', // the status region — no test id of its own
			'summary-restart-session',
			'summary-pick-another'
		]);
	});

	it('adds nothing to the tab order — the notices are statements, not controls', async () => {
		render(SessionSummaryView, { ...baseProps, failedSaves: 4, pendingSaves: 2 });

		const region = statusRegion();
		expect(region?.querySelectorAll('a, button, input, [tabindex]')).toHaveLength(0);
	});
});

/**
 * Focus handling (phase 8). The typing surface unmounts when the session finishes, so without
 * this the caret dies on `<body>` and a keyboard-only user has nothing to tab from.
 */
describe('SessionSummary.svelte — focus on mount', () => {
	it('takes focus itself, and is labelled by its own heading', async () => {
		render(SessionSummaryView, { ...baseProps, failedSaves: 0 });

		const section = page.getByTestId('session-summary').element();
		expect(document.activeElement).toBe(section);
		// Focusable programmatically but never a tab stop of its own.
		expect(section.getAttribute('tabindex')).toBe('-1');
		const labelledBy = section.getAttribute('aria-labelledby');
		expect(labelledBy).toBe('session-summary-heading');
		expect(section.querySelector(`#${labelledBy}`)?.tagName).toBe('H1');
	});

	it('reaches both actions by keyboard from where focus lands', async () => {
		const restarted: string[] = [];
		render(SessionSummaryView, {
			...baseProps,
			failedSaves: 0,
			onRestartSession: () => restarted.push('restart')
		});

		// Tab from the focused section: the first stop is the primary action.
		await userEvent.tab();
		expect(document.activeElement).toBe(page.getByTestId('summary-restart-session').element());

		await userEvent.keyboard('{Enter}');
		expect(restarted).toEqual(['restart']);
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
			.toHaveTextContent('Sign in to save the 3 pages you just typed');
	});

	it('names exactly the cap at the cap', async () => {
		overwriteGetLocale(() => 'en');

		render(SessionSummaryView, {
			...guestProps,
			summary: { ...summary, chunksCompleted: ATTEMPT_BUFFER_CAP }
		});

		await expect
			.element(page.getByTestId('summary-sign-in-prompt'))
			.toHaveTextContent(`Sign in to save the ${ATTEMPT_BUFFER_CAP} pages you just typed`);
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
			.toHaveTextContent(`Sign in to save the ${ATTEMPT_BUFFER_CAP} pages you just typed`);
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
