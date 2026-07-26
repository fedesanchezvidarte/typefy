import { page, userEvent } from 'vitest/browser';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import type { TypeableText } from '$lib/types';
import { ATTEMPT_BUFFER_KEY, type BufferedChunkAttempt } from '$lib/progress/buffer';
import TypingSession from './TypingSession.svelte';

/**
 * Component tests for spec #12 §4 (Display) and §6 (Save failures).
 *
 * The write path is reached ONLY through `await import('$lib/supabase/browser')` +
 * `await import('$lib/progress/client')` inside the component (brief §1.6 — a hard bundle
 * gate depends on that shape). Both are mocked here rather than injected as props, so the
 * component's dynamic-import boundary stays exactly as it ships. Nothing in this file can
 * reach a real Supabase client or a real database.
 */
const recordChunkAttempt = vi.hoisted(() => vi.fn());
const backfillChunkAttempt = vi.hoisted(() => vi.fn());
const getBrowserSupabase = vi.hoisted(() => vi.fn(() => ({ __mock: 'supabase-client' })));
const goto = vi.hoisted(() => vi.fn());
const invalidateAll = vi.hoisted(() => vi.fn());

vi.mock('$lib/supabase/browser', () => ({ getBrowserSupabase }));
// `backfillChunkAttempt` belongs in the factory even though this component never calls it:
// a successful write now fires `drainOnce`, whose dynamic `./drain` import resolves
// `backfillChunkAttempt` out of THIS mocked module. Without it, any test whose buffer is
// non-empty when a save succeeds would fail on `backfillChunkAttempt is not a function`
// rather than on anything it means to assert.
vi.mock('$lib/progress/client', () => ({ recordChunkAttempt, backfillChunkAttempt }));
// `goto` is mocked so "no re-authentication flow is triggered" (spec #12 §6) is assertable:
// a redirect out of the session would have to go through it. `invalidateAll` is mocked for
// the opposite reason — spec #15 §11 forbids the in-session drain trigger from calling it,
// and a spy is the only way to assert a call that must not happen. The component imports
// neither directly for the drain; `invalidateAll` is here because the module is mocked
// wholesale and `+layout.svelte`'s triggers are what may use it.
vi.mock('$app/navigation', () => ({ goto, invalidateAll }));

/** Reads the attempt buffer straight out of the real `localStorage` these tests run against. */
function bufferEntries(): BufferedChunkAttempt[] {
	const raw = localStorage.getItem(ATTEMPT_BUFFER_KEY);
	return raw === null ? [] : (JSON.parse(raw) as BufferedChunkAttempt[]);
}

/**
 * Puts one entry in the buffer before the component mounts, standing in for a passage
 * completed in an earlier session — the backlog the in-session drain trigger exists to
 * flush. Written through the real key rather than through `enqueue` so the test states the
 * stored shape it depends on outright.
 */
function seedBufferEntry(over: Partial<BufferedChunkAttempt> = {}): BufferedChunkAttempt {
	const entry: BufferedChunkAttempt = {
		userId: null,
		chunkId: 'chunk-from-an-earlier-session',
		bookId: 'book-uuid',
		completed: true,
		grossWpm: 44,
		accuracyRaw: 0.91,
		elapsedMs: 25_000,
		startedAt: Date.now() - 600_000,
		bufferedAt: Date.now() - 590_000,
		...over
	};
	localStorage.setItem(ATTEMPT_BUFFER_KEY, JSON.stringify([entry]));
	return entry;
}

/** Tiny books: a passage of `a b` completes in three keystrokes, one of them a word boundary. */
function makeBook(contents: readonly string[]): TypeableText {
	return {
		id: 'test-book',
		bookId: 'book-uuid',
		title: 'Test Book',
		author: 'Test Author',
		language: 'en',
		chunkCount: contents.length,
		coverUrl: null,
		chunks: contents.map((content, index) => ({
			id: `chunk-${index}`,
			textId: 'test-book',
			index,
			content,
			charCount: Array.from(content).length
		}))
	};
}

/** `n` two-word passages: 'a b', 'c d', … — enough to complete without a wall of keystrokes. */
function passages(n: number): string[] {
	return Array.from(
		{ length: n },
		(_, i) => `${String.fromCharCode(97 + i * 2)} ${String.fromCharCode(98 + i * 2)}`
	);
}

/** Real keystrokes through the hidden input the typing surface owns — no prop shortcuts. */
async function typeText(text: string) {
	(page.getByTestId('typing-input').element() as HTMLInputElement).focus();
	for (const char of Array.from(text)) {
		await userEvent.keyboard(char);
	}
}

function metaText(): string {
	return page.getByTestId('passage-meta').element().textContent ?? '';
}

/**
 * Lets every already-issued save settle, so an assertion about `failedSaves` is not racing
 * it. Deterministic, not a sleep: it awaits the very promises the mock handed the component,
 * then flushes the microtask turns its `await` continuation and Svelte's effects need.
 */
async function settleSaves() {
	await Promise.all(recordChunkAttempt.mock.results.map((result) => result.value));
	await tick();
	await tick();
}

beforeEach(() => {
	recordChunkAttempt.mockReset();
	recordChunkAttempt.mockResolvedValue({ saved: true });
	backfillChunkAttempt.mockReset();
	backfillChunkAttempt.mockResolvedValue({ saved: true });
	getBrowserSupabase.mockClear();
	goto.mockClear();
	invalidateAll.mockClear();
	// These run in a real browser against a real `localStorage`, and the component now
	// enqueues into it. Without this, one test's buffered entries survive into the next and
	// change what its drain trigger does — a shared-state leak, not a flake.
	localStorage.removeItem(ATTEMPT_BUFFER_KEY);
});

describe('TypingSession.svelte — book-lifetime progress display (spec #12 §4)', () => {
	it('shows the persisted book-lifetime percentage when resuming mid-book, not 0%', async () => {
		// Resuming at passage 7 of 11 with 6 passages already persisted: 6/11 = 55%.
		render(TypingSession, {
			book: makeBook(passages(11)),
			startIndex: 6,
			chunksCompleted: 6,
			completedChunkIds: ['chunk-0', 'chunk-1', 'chunk-2', 'chunk-3', 'chunk-4', 'chunk-5'],
			userId: 'user-1'
		});

		await expect
			.element(page.getByTestId('passage-meta'))
			.toHaveTextContent('Passage 7 of 11 · 55%');
	});

	it('advances the displayed figure when a not-previously-completed passage is completed, with no reload', async () => {
		render(TypingSession, {
			book: makeBook(passages(4)),
			startIndex: 1,
			chunksCompleted: 1,
			completedChunkIds: ['chunk-0'],
			userId: 'user-1'
		});

		await expect
			.element(page.getByTestId('passage-meta'))
			.toHaveTextContent('Passage 2 of 4 · 25%');

		await typeText('c d'); // completes chunk-1, which had no prior completion

		await expect
			.element(page.getByTestId('passage-meta'))
			.toHaveTextContent('Passage 3 of 4 · 50%');
	});

	it('does not advance the displayed figure when an already-completed passage is re-completed, and never exceeds 100%', async () => {
		// Every passage of this book is already persisted as complete: the figure starts at
		// 100% and re-typing must leave it there, not push it past.
		render(TypingSession, {
			book: makeBook(passages(3)),
			startIndex: 0,
			chunksCompleted: 3,
			completedChunkIds: ['chunk-0', 'chunk-1', 'chunk-2'],
			userId: 'user-1'
		});

		await expect
			.element(page.getByTestId('passage-meta'))
			.toHaveTextContent('Passage 1 of 3 · 100%');

		await typeText('a b');
		await expect
			.element(page.getByTestId('passage-meta'))
			.toHaveTextContent('Passage 2 of 3 · 100%');

		await typeText('c d');
		await expect
			.element(page.getByTestId('passage-meta'))
			.toHaveTextContent('Passage 3 of 3 · 100%');
	});

	it('clamps the figure at 100% when the persisted count exceeds the book chunk count', async () => {
		// A stale or inconsistent rollup must not render 167%: the figure is clamped, and a
		// completion inside the session cannot push it past the clamp either.
		render(TypingSession, {
			book: makeBook(passages(3)),
			startIndex: 0,
			chunksCompleted: 5,
			completedChunkIds: ['chunk-0', 'chunk-1', 'chunk-2'],
			userId: 'user-1'
		});

		await expect
			.element(page.getByTestId('passage-meta'))
			.toHaveTextContent('Passage 1 of 3 · 100%');

		await typeText('a b');

		await expect
			.element(page.getByTestId('passage-meta'))
			.toHaveTextContent('Passage 2 of 3 · 100%');
	});

	it('degrades a guest to the session-relative figure and attempts no write at all', async () => {
		render(TypingSession, {
			book: makeBook(passages(4)),
			startIndex: 0,
			chunksCompleted: 0,
			completedChunkIds: [],
			userId: null
		});

		await expect.element(page.getByTestId('passage-meta')).toHaveTextContent('Passage 1 of 4 · 0%');

		await typeText('a b');

		// Session-relative: one passage behind the cursor out of four.
		await expect
			.element(page.getByTestId('passage-meta'))
			.toHaveTextContent('Passage 2 of 4 · 25%');

		await settleSaves();
		expect(recordChunkAttempt).not.toHaveBeenCalled();
		// The guest gate sits above the dynamic import: no client is constructed either.
		expect(getBrowserSupabase).not.toHaveBeenCalled();
	});
});

describe('TypingSession.svelte — save failures (spec #12 §6)', () => {
	it('shows nothing during typing and states the failure count once on the summary', async () => {
		// `'permanent'` explicitly, not the old catch-all `'error'`: this test asserts the
		// *lost* wording, which spec #15 narrowed `summary_save_failures` to. A transient stub
		// would render the pending notice instead and this assertion would be exercising the
		// opposite path from the one it names.
		recordChunkAttempt.mockResolvedValue({ saved: false, reason: 'permanent' });

		render(TypingSession, {
			book: makeBook(passages(2)),
			startIndex: 0,
			chunksCompleted: 0,
			completedChunkIds: [],
			userId: 'user-1'
		});

		await typeText('a b');
		await expect.element(page.getByTestId('passage-meta')).toHaveTextContent('Passage 2 of 2');

		// The first insert has resolved as a failure by now — and still nothing is shown
		// while typing: no notice, no summary, no interruption of the passage.
		await expect.poll(() => recordChunkAttempt.mock.calls.length).toBe(1);
		await settleSaves();
		expect(page.getByTestId('summary-save-failures').query()).toBeNull();
		expect(page.getByTestId('session-summary').query()).toBeNull();
		await expect.element(page.getByTestId('typing-surface')).toBeInTheDocument();

		await typeText('c d');

		await expect
			.element(page.getByTestId('summary-save-failures'))
			.toHaveTextContent("2 passages couldn't be saved.");
		// One attempt per completion — two completions, two calls, no retry.
		await settleSaves();
		expect(recordChunkAttempt).toHaveBeenCalledTimes(2);
	});

	it('shows no notice on the summary when every insert saved', async () => {
		render(TypingSession, {
			book: makeBook(passages(2)),
			startIndex: 0,
			chunksCompleted: 0,
			completedChunkIds: [],
			userId: 'user-1'
		});

		await typeText('a b');
		await typeText('c d');

		await expect.element(page.getByTestId('session-summary')).toBeInTheDocument();
		await expect.poll(() => recordChunkAttempt.mock.calls.length).toBe(2);
		await settleSaves();
		expect(page.getByTestId('summary-save-failures').query()).toBeNull();
	});

	it('treats an expired token as a pending save: notice shown, no re-auth flow, no rollback of the figure', async () => {
		// An expired token is still not a distinct code path in the component — but spec #15
		// §11 classifies it TRANSIENT, because it is the exact condition the buffer exists to
		// survive. So the honest stub is `'transient'`, and the honest assertion is the
		// pending notice: those passages are buffered and will be written, not lost. What
		// spec #12 §6 fixed is unchanged and still asserted below — no re-auth flow, and the
		// optimistic figure is never rewound.
		recordChunkAttempt.mockResolvedValue({ saved: false, reason: 'transient' });
		const hrefBefore = window.location.href;

		render(TypingSession, {
			book: makeBook(passages(3)),
			startIndex: 0,
			chunksCompleted: 0,
			completedChunkIds: [],
			userId: 'user-1'
		});

		await typeText('a b');

		// Optimistically advanced to 1/3 — and NOT rewound once the failure lands.
		await expect
			.element(page.getByTestId('passage-meta'))
			.toHaveTextContent('Passage 2 of 3 · 33%');
		await expect.poll(() => recordChunkAttempt.mock.calls.length).toBe(1);
		await settleSaves();
		await expect
			.element(page.getByTestId('passage-meta'))
			.toHaveTextContent('Passage 2 of 3 · 33%');

		await typeText('c d');
		await typeText('e f');

		await expect
			.element(page.getByTestId('summary-save-pending'))
			.toHaveTextContent("3 passages will be saved when you're back online.");
		// Nothing is reported as lost: every failure here was transient and therefore buffered.
		expect(page.getByTestId('summary-save-failures').query()).toBeNull();
		// No re-authentication flow: nothing navigated, and no sign-in prompt was raised
		// (that prompt is the guest-only surface).
		expect(goto).not.toHaveBeenCalled();
		expect(window.location.href).toBe(hrefBefore);
	});
});

/**
 * The in-session drain trigger (spec #15 §4) and the one rule that separates it from the
 * layout's triggers (§11). The unit suite already proves what a drain *does*; what only this
 * component can prove is when it fires from the typing screen and what it must not do there.
 */
describe('TypingSession.svelte — the in-session drain trigger (spec #15 §4, §11)', () => {
	it('flushes a backlog after a successful write, stamping the draining user onto a guest-authored entry', async () => {
		const buffered = seedBufferEntry();

		render(TypingSession, {
			book: makeBook(passages(2)),
			startIndex: 0,
			chunksCompleted: 0,
			completedChunkIds: [],
			userId: 'user-1'
		});

		await typeText('a b');

		// The successful write proved there is connectivity and a valid token, which is the
		// signal the backlog can go out.
		await expect.poll(() => backfillChunkAttempt.mock.calls.length).toBe(1);
		expect(backfillChunkAttempt.mock.calls[0][1]).toMatchObject({
			// Stamped from the draining SESSION, never read off the entry — a guest-authored
			// entry belongs to whoever signs in next on this browser.
			userId: 'user-1',
			chunkId: buffered.chunkId,
			startedAt: buffered.startedAt
		});
		// `bufferedAt` is buffer bookkeeping and must never reach the database.
		expect(backfillChunkAttempt.mock.calls[0][1]).not.toHaveProperty('bufferedAt');
		await expect.poll(bufferEntries).toEqual([]);
	});

	it('never calls invalidateAll from the typing screen, however much the drain wrote', async () => {
		// Spec §11: on the typing screen `invalidateAll()` re-runs `safeGetSession()` and
		// re-serialises the whole book text mid-passage, to refresh figures the session has
		// already advanced optimistically. The mount and `online` triggers own that call.
		seedBufferEntry();

		render(TypingSession, {
			book: makeBook(passages(2)),
			startIndex: 0,
			chunksCompleted: 0,
			completedChunkIds: [],
			userId: 'user-1'
		});

		await typeText('a b');
		await expect.poll(() => backfillChunkAttempt.mock.calls.length).toBe(1);
		await expect.poll(bufferEntries).toEqual([]);
		await settleSaves();

		expect(invalidateAll).not.toHaveBeenCalled();
	});

	it('does not reach the drain at all when the buffer is empty', async () => {
		// The synchronous `readAll` gate inside `drainOnce` is what keeps the overwhelmingly
		// common case — an empty buffer — from costing a dynamic import of the Supabase chunk.
		render(TypingSession, {
			book: makeBook(passages(2)),
			startIndex: 0,
			chunksCompleted: 0,
			completedChunkIds: [],
			userId: 'user-1'
		});

		await typeText('a b');
		await expect.poll(() => recordChunkAttempt.mock.calls.length).toBe(1);
		await settleSaves();

		expect(backfillChunkAttempt).not.toHaveBeenCalled();
		expect(invalidateAll).not.toHaveBeenCalled();
	});

	it('does not drain after a failed write, however full the buffer is', async () => {
		// A failure is the opposite signal: there is no proof of connectivity to act on, and
		// replaying the backlog would only halt on the same condition.
		recordChunkAttempt.mockResolvedValue({ saved: false, reason: 'transient' });
		seedBufferEntry();

		render(TypingSession, {
			book: makeBook(passages(2)),
			startIndex: 0,
			chunksCompleted: 0,
			completedChunkIds: [],
			userId: 'user-1'
		});

		await typeText('a b');
		await expect.poll(() => recordChunkAttempt.mock.calls.length).toBe(1);
		await settleSaves();

		expect(backfillChunkAttempt).not.toHaveBeenCalled();
		// The failed passage joined the backlog rather than replacing it: both are waiting.
		expect(bufferEntries()).toHaveLength(2);
	});
});

/**
 * Enqueue at the two spec #12 drop points (spec #15 §3), read back off the real
 * `localStorage` these tests run against.
 */
describe('TypingSession.svelte — enqueue at the drop points (spec #15 §3)', () => {
	it('buffers a guest completion as guest-authored, with the genuine first-keystroke timestamp', async () => {
		const before = Date.now();

		render(TypingSession, {
			book: makeBook(passages(2)),
			startIndex: 0,
			chunksCompleted: 0,
			completedChunkIds: [],
			userId: null
		});

		await typeText('a b');

		await expect.poll(() => bufferEntries().length).toBe(1);
		const [entry] = bufferEntries();
		// `null` — not attributed to anybody yet, and therefore attributable to whoever signs
		// in next on this browser.
		expect(entry.userId).toBeNull();
		expect(entry.chunkId).toBe('chunk-0');
		expect(entry.completed).toBe(true);
		expect(entry.elapsedMs).toBeGreaterThan(0);
		// The first keystroke, not the buffering instant: it is what the database's unique
		// index dedupes a re-drained entry on.
		expect(entry.startedAt).toBeGreaterThanOrEqual(before);
		expect(entry.startedAt).toBeLessThanOrEqual(entry.bufferedAt);

		// And still no Supabase client and no write service on the guest path.
		await settleSaves();
		expect(recordChunkAttempt).not.toHaveBeenCalled();
		expect(getBrowserSupabase).not.toHaveBeenCalled();
	});

	it('buffers a signed-in transient failure under that user, never as guest-authored', async () => {
		recordChunkAttempt.mockResolvedValue({ saved: false, reason: 'transient' });

		render(TypingSession, {
			book: makeBook(passages(2)),
			startIndex: 0,
			chunksCompleted: 0,
			completedChunkIds: [],
			userId: 'user-1'
		});

		await typeText('a b');
		await settleSaves();

		await expect.poll(() => bufferEntries().map((entry) => entry.userId)).toEqual(['user-1']);
	});

	it('buffers nothing on a permanent failure — a refused row can never succeed', async () => {
		recordChunkAttempt.mockResolvedValue({ saved: false, reason: 'permanent' });

		render(TypingSession, {
			book: makeBook(passages(2)),
			startIndex: 0,
			chunksCompleted: 0,
			completedChunkIds: [],
			userId: 'user-1'
		});

		await typeText('a b');
		await expect.poll(() => recordChunkAttempt.mock.calls.length).toBe(1);
		await settleSaves();

		expect(bufferEntries()).toEqual([]);
	});

	it('buffers nothing on a successful write', async () => {
		render(TypingSession, {
			book: makeBook(passages(2)),
			startIndex: 0,
			chunksCompleted: 0,
			completedChunkIds: [],
			userId: 'user-1'
		});

		await typeText('a b');
		await expect.poll(() => recordChunkAttempt.mock.calls.length).toBe(1);
		await settleSaves();

		expect(bufferEntries()).toEqual([]);
	});
});

/**
 * The write path has to be FETCHED before it can fail, and that fetch can fail on its own
 * (spec #15 §3). Nothing above reaches this: every test so far has the lazy chunk resolving.
 *
 * The seam is `Promise.all`, because that is the one call `loadProgressModules` makes and —
 * measured, not assumed — the only `Promise.all` call in a whole render/type/save cycle here.
 * Rejecting it reproduces a failed dynamic import from the component's point of view, with the
 * one property a thrown `vi.mock` factory cannot give: the SAME import can succeed afterwards,
 * which is what makes the memo's behaviour observable.
 *
 * That last part is more permissive than a real browser, deliberately. Chromium records a
 * failed module fetch in the document's module map, so in production the retry below usually
 * fails again until the page is replaced — which is why the buffer, not the retry, is what
 * saves the passage (see the offline E2E). What this test pins is the memo's contract: it must
 * never hold a rejection, so every later completion gets a fresh, individually-handled attempt
 * instead of inheriting one dead promise for the rest of the session.
 */
describe('TypingSession.svelte — a write path that cannot be loaded (spec #15 §3)', () => {
	/** Makes the component's module load reject until `stop()` is called. */
	function failModuleLoads() {
		const realAll = Promise.all;
		let failing = true;
		const spy = vi
			.spyOn(Promise, 'all')
			.mockImplementation(((values: never) =>
				failing
					? Promise.reject(
							new TypeError(
								'Failed to fetch dynamically imported module: /src/lib/supabase/browser.ts'
							)
						)
					: realAll.call(Promise, values)) as typeof Promise.all);
		return {
			stop: () => {
				failing = false;
			},
			restore: () => spy.mockRestore()
		};
	}

	it('buffers a passage whose write path failed to load, and loads it again for the next passage', async () => {
		// Offline from before the first keystroke: the warm-up on the session's first `char`
		// fails too, so the completion instant arrives with no module and no way to get one.
		const network = failModuleLoads();

		try {
			render(TypingSession, {
				book: makeBook(passages(2)),
				startIndex: 0,
				chunksCompleted: 0,
				completedChunkIds: [],
				userId: 'user-1'
			});

			await typeText('a b');

			// Pending, not dropped. Before the fix this passage went nowhere at all: the rejection
			// escaped `void saveAttempt(...)` unhandled, so nothing was saved, counted or buffered.
			await expect.poll(() => bufferEntries().map((entry) => entry.chunkId)).toEqual(['chunk-0']);
			expect(bufferEntries()[0].userId).toBe('user-1');
			// Nothing was even attempted against the database — there was no client to attempt it with.
			expect(recordChunkAttempt).not.toHaveBeenCalled();

			// ── Connectivity returns, same session, next passage ──────────────────────────
			network.stop();

			await typeText('c d');

			// The memo did not keep the rejection: the import ran again and this passage was
			// written. Before the fix a single offline moment poisoned every later passage of
			// the session, because the rejected promise was cached under `??=`.
			await expect.poll(() => recordChunkAttempt.mock.calls.length).toBe(1);
			expect(recordChunkAttempt.mock.calls[0][1]).toMatchObject({
				userId: 'user-1',
				chunkId: 'chunk-1'
			});
			await settleSaves();
		} finally {
			network.restore();
		}

		// One passage pending, none reported lost: a chunk that would not download is a passage
		// waiting on the network, not a passage thrown away.
		await expect
			.element(page.getByTestId('summary-save-pending'))
			.toHaveTextContent("One passage will be saved when you're back online.");
		expect(page.getByTestId('summary-save-failures').query()).toBeNull();
	});
});

/**
 * Focus and announcement across the completion boundary (phase 8).
 *
 * The typing surface UNMOUNTS when the session finishes, so focus has to be handed to the
 * summary or it dies on `<body>` and a keyboard-only user is stranded. And the summary's save
 * notices are the one thing on it that does not exist yet at that moment — which is why they
 * live in a `role="status"` region rather than in plain reading order.
 */
describe('TypingSession.svelte — focus and announcement at the completion boundary', () => {
	it('hands focus from the typing surface to the summary when the session finishes', async () => {
		render(TypingSession, {
			book: makeBook(passages(1)),
			startIndex: 0,
			chunksCompleted: 0,
			completedChunkIds: [],
			userId: 'user-1'
		});

		expect(document.activeElement).toBe(page.getByTestId('typing-input').element());

		await typeText('a b');

		const summary = page.getByTestId('session-summary');
		await expect.element(summary).toBeInTheDocument();
		// Not `<body>`: the surface that held focus is gone, and nothing else would take it.
		expect(document.activeElement).toBe(summary.element());
		await settleSaves();
	});

	it('returns focus to the typing surface when the summary restarts the session', async () => {
		render(TypingSession, {
			book: makeBook(passages(1)),
			startIndex: 0,
			chunksCompleted: 0,
			completedChunkIds: [],
			userId: 'user-1'
		});

		await typeText('a b');
		await expect.element(page.getByTestId('session-summary')).toBeInTheDocument();
		await settleSaves();

		// Driven from the keyboard, the way the user this test is about would reach it.
		await userEvent.tab();
		expect(document.activeElement).toBe(page.getByTestId('summary-restart-session').element());
		await userEvent.keyboard('{Enter}');

		// The surface remounts and focuses itself from its own attachment; `surface` is still
		// null at the moment `restartSession` runs, so nothing else could have done it.
		await expect.element(page.getByTestId('typing-surface')).toBeInTheDocument();
		await expect
			.poll(() => document.activeElement?.getAttribute('data-testid'))
			.toBe('typing-input');
	});

	it('mounts the summary — focused, with the status region already in place — BEFORE the final save resolves', async () => {
		// This ordering is the whole reason the notices are a live region. The keystroke that
		// completes the last passage is also the one that finishes the session, so the summary
		// is on screen and holding focus while `recordChunkAttempt` is still outstanding.
		let release!: (outcome: { saved: false; reason: 'transient' }) => void;
		recordChunkAttempt.mockImplementation(
			() =>
				new Promise((resolve) => {
					release = resolve as typeof release;
				})
		);

		render(TypingSession, {
			book: makeBook(passages(1)),
			startIndex: 0,
			chunksCompleted: 0,
			completedChunkIds: [],
			userId: 'user-1'
		});

		await typeText('a b');

		const summary = page.getByTestId('session-summary');
		await expect.element(summary).toBeInTheDocument();
		expect(document.activeElement).toBe(summary.element());
		// Nothing to read yet — the outcome does not exist.
		expect(page.getByTestId('summary-save-pending').query()).toBeNull();
		// But the region that will carry it does. Captured now, compared after: this is the
		// assertion that fails if the wrapper is ever guarded by the counts again.
		const region = summary.element().querySelector('[role="status"]');
		expect(region, 'the status region must exist before the notice does').not.toBeNull();

		release({ saved: false, reason: 'transient' });

		await expect
			.element(page.getByTestId('summary-save-pending'))
			.toHaveTextContent("One passage will be saved when you're back online.");
		// Inserted into the established region, and focus was not disturbed to say so.
		expect(summary.element().querySelector('[role="status"]')).toBe(region);
		expect(document.activeElement).toBe(summary.element());
	});
});

describe('TypingSession.svelte — cumulative running metrics (spec #12 §5)', () => {
	it("keeps showing a WPM figure across a passage boundary and at the second passage's first word boundary", async () => {
		render(TypingSession, {
			book: makeBook(passages(3)),
			startIndex: 0,
			chunksCompleted: 0,
			completedChunkIds: [],
			userId: 'user-1'
		});

		await expect.element(page.getByTestId('passage-meta')).toHaveTextContent('— wpm');

		await typeText('a '); // first word boundary of the session
		await expect.poll(metaText).toMatch(/· \d+ wpm ·/);

		await typeText('b'); // completes passage 1; metrics must NOT reset to '—'
		await expect.element(page.getByTestId('passage-meta')).toHaveTextContent('Passage 2 of 3');
		expect(metaText()).toMatch(/· \d+ wpm ·/);

		await typeText('c '); // first word boundary of the SECOND passage
		expect(metaText()).toMatch(/· \d+ wpm ·/);
	});
});
