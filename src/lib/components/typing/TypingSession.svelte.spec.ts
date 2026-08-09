import { page, userEvent } from 'vitest/browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import type { Chunk, ChunkWindow, TypeableTextSummary } from '$lib/types';
import { ATTEMPT_BUFFER_KEY, type BufferedChunkAttempt } from '$lib/progress/buffer';
import { PAGE_STATE_KEY, savePageState, type PageState } from '$lib/progress/page-state';
import { getAttemptStorage } from '$lib/progress/storage';
import { PREFETCH_THRESHOLD, seekWindow, WINDOW_SIZE } from '$lib/reading/window';
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
// Hoisted (not inlined in the factory below) so the navigator tests can assert on calls: a
// shallow-routing jump (spec #32 §10 D1) is only observable through `pushState`, since the
// component never remounts and therefore never re-runs a load the way a `goto` would.
const pushState = vi.hoisted(() => vi.fn());
const beforeNavigateHandlers = vi.hoisted(() => [] as Array<() => void>);
const beforeNavigate = vi.hoisted(() =>
	vi.fn((handler: () => void) => {
		beforeNavigateHandlers.push(handler);
	})
);

/**
 * The window path is a plain `fetch` to a first-party endpoint — NOT a Supabase client call
 * (spec #18 §9, the guest bundle guarantee). So the seam is `fetch` itself, stubbed globally
 * rather than injected, which is also the only way to prove the component issues nothing at
 * all when there is nothing to fetch.
 */
const fetchMock = vi.hoisted(() => vi.fn<typeof fetch>());

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
//
// `beforeNavigate` and `pushState` are stubbed too (spec #32 §10 D1): the module is mocked
// wholesale, so any real export the component calls at init (`beforeNavigate`, registered
// unconditionally) or on a page-navigator jump (`pushState`) must exist here or the whole
// component throws on mount. Neither is asserted on by name in this file — that is Phase 7's
// navigator coverage — this is only what keeps the pre-existing spec #12/#15/#18/#24
// coverage in this file loading a real component.
vi.mock('$app/navigation', () => ({
	goto,
	invalidateAll,
	beforeNavigate,
	pushState
}));

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

/**
 * Book METADATA only. Since spec #18 the component is never handed a whole book: the text
 * arrives as `ChunkWindow`s, and `chunkCount` — the book's real length — is what tells the
 * session whether there is more of it than it currently holds.
 */
function makeBook(chunkCount: number): TypeableTextSummary {
	return {
		id: 'test-book',
		bookId: 'book-uuid',
		title: 'Test Book',
		author: 'Test Author',
		language: 'en',
		chunkCount,
		coverUrl: null
	};
}

/** Chunks at ABSOLUTE indices `from..from + contents.length - 1`. */
function makeChunks(contents: readonly string[], from = 0): Chunk[] {
	return contents.map((content, offset) => ({
		id: `chunk-${from + offset}`,
		textId: 'test-book',
		index: from + offset,
		content,
		charCount: Array.from(content).length
	}));
}

/** A window of `contents` opening at `from`, over a book `chunkCount` passages long. */
function makeWindow(contents: readonly string[], chunkCount: number, from = 0): ChunkWindow {
	return { from, chunks: makeChunks(contents, from), chunkCount };
}

/**
 * `mode` is a REQUIRED prop since spec #24, and every test in this file describes a fully
 * Normal session — that is the regression guarantee the spec asks for ("byte-identical
 * behaviour and figures to today"). Carried on the two fixture helpers rather than repeated at
 * thirty render sites, so it says once, in one place, what these tests are about; a Zen
 * fixture states its own mode at the call site instead.
 */
const NORMAL = 'normal' as const;

/**
 * The two props that used to be one. A book short enough to hold whole: every passage is
 * loaded, `chunkCount` equals what the window carries, so nothing here can prefetch or
 * await — which is exactly what every test written before spec #18 assumed.
 */
function loaded(contents: readonly string[]) {
	return {
		book: makeBook(contents.length),
		window: makeWindow(contents, contents.length),
		mode: NORMAL
	};
}

/**
 * A book LONGER than its first window: `contents` is loaded, `chunkCount` says there is more.
 * This is the shape that makes the prefetch, `awaiting` and the end-of-window state reachable.
 */
function windowed(contents: readonly string[], chunkCount: number) {
	return { book: makeBook(chunkCount), window: makeWindow(contents, chunkCount), mode: NORMAL };
}

/** `n` two-word passages: 'a b', 'c d', … — enough to complete without a wall of keystrokes. */
function passages(n: number): string[] {
	return Array.from(
		{ length: n },
		(_, i) => `${String.fromCharCode(97 + i * 2)} ${String.fromCharCode(98 + i * 2)}`
	);
}

/** A 200 with a JSON body, the way the two window endpoints answer. */
function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'content-type': 'application/json' }
	});
}

/** The chunks-endpoint requests issued so far, in order. */
function chunkRequests(): string[] {
	return fetchMock.mock.calls
		.map(([input]) => String(input))
		.filter((url) => url.includes('/chunks?'));
}

function progressRequests(): string[] {
	return fetchMock.mock.calls
		.map(([input]) => String(input))
		.filter((url) => url.includes('/progress?'));
}

/** Real keystrokes through the hidden input the typing surface owns — no prop shortcuts. */
async function typeText(text: string) {
	(page.getByTestId('typing-input').element() as HTMLInputElement).focus();
	for (const char of Array.from(text)) {
		await userEvent.keyboard(char);
	}
}

function metaText(): string {
	return page.getByTestId('page-meta').element().textContent ?? '';
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
	pushState.mockClear();
	beforeNavigateHandlers.length = 0;
	// Rejecting by default: a test that does not set up a window is asserting that none is
	// asked for, and if one is asked for anyway the component must swallow it rather than
	// surface it. Both properties are checked by this default, not hidden by it.
	fetchMock.mockReset();
	fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
	vi.stubGlobal('fetch', fetchMock);
	// These run in a real browser against a real `localStorage`, and the component now
	// enqueues into it. Without this, one test's buffered entries survive into the next and
	// change what its drain trigger does — a shared-state leak, not a flake.
	localStorage.removeItem(ATTEMPT_BUFFER_KEY);
	localStorage.removeItem(PAGE_STATE_KEY);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('TypingSession.svelte — book-lifetime progress display (spec #12 §4)', () => {
	it('shows the persisted book-lifetime percentage when resuming mid-book, not 0%', async () => {
		// Resuming at passage 7 of 11 with 6 passages already persisted: 6/11 = 55%.
		render(TypingSession, {
			...loaded(passages(11)),
			startIndex: 6,
			chunksCompleted: 6,
			completedChunkIds: ['chunk-0', 'chunk-1', 'chunk-2', 'chunk-3', 'chunk-4', 'chunk-5'],
			userId: 'user-1'
		});

		await expect.element(page.getByTestId('page-meta')).toHaveTextContent('Page 7 of 11 · 55%');
	});

	it('advances the displayed figure when a not-previously-completed passage is completed, with no reload', async () => {
		render(TypingSession, {
			...loaded(passages(4)),
			startIndex: 1,
			chunksCompleted: 1,
			completedChunkIds: ['chunk-0'],
			userId: 'user-1'
		});

		await expect.element(page.getByTestId('page-meta')).toHaveTextContent('Page 2 of 4 · 25%');

		await typeText('c d'); // completes chunk-1, which had no prior completion

		await expect.element(page.getByTestId('page-meta')).toHaveTextContent('Page 3 of 4 · 50%');
	});

	it('does not advance the displayed figure when an already-completed passage is re-completed, and never exceeds 100%', async () => {
		// Every passage of this book is already persisted as complete: the figure starts at
		// 100% and re-typing must leave it there, not push it past.
		render(TypingSession, {
			...loaded(passages(3)),
			startIndex: 0,
			chunksCompleted: 3,
			completedChunkIds: ['chunk-0', 'chunk-1', 'chunk-2'],
			userId: 'user-1'
		});

		await expect.element(page.getByTestId('page-meta')).toHaveTextContent('Page 1 of 3 · 100%');

		await typeText('a b');
		await expect.element(page.getByTestId('page-meta')).toHaveTextContent('Page 2 of 3 · 100%');

		await typeText('c d');
		await expect.element(page.getByTestId('page-meta')).toHaveTextContent('Page 3 of 3 · 100%');
	});

	it('clamps the figure at 100% when the persisted count exceeds the book chunk count', async () => {
		// A stale or inconsistent rollup must not render 167%: the figure is clamped, and a
		// completion inside the session cannot push it past the clamp either.
		render(TypingSession, {
			...loaded(passages(3)),
			startIndex: 0,
			chunksCompleted: 5,
			completedChunkIds: ['chunk-0', 'chunk-1', 'chunk-2'],
			userId: 'user-1'
		});

		await expect.element(page.getByTestId('page-meta')).toHaveTextContent('Page 1 of 3 · 100%');

		await typeText('a b');

		await expect.element(page.getByTestId('page-meta')).toHaveTextContent('Page 2 of 3 · 100%');
	});

	it('degrades a guest to the session-relative figure and attempts no write at all', async () => {
		render(TypingSession, {
			...loaded(passages(4)),
			startIndex: 0,
			chunksCompleted: 0,
			completedChunkIds: [],
			userId: null
		});

		await expect.element(page.getByTestId('page-meta')).toHaveTextContent('Page 1 of 4 · 0%');

		await typeText('a b');

		// Session-relative: one passage behind the cursor out of four.
		await expect.element(page.getByTestId('page-meta')).toHaveTextContent('Page 2 of 4 · 25%');

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
			...loaded(passages(2)),
			startIndex: 0,
			chunksCompleted: 0,
			completedChunkIds: [],
			userId: 'user-1'
		});

		await typeText('a b');
		await expect.element(page.getByTestId('page-meta')).toHaveTextContent('Page 2 of 2');

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
			.toHaveTextContent("2 pages couldn't be saved.");
		// One attempt per completion — two completions, two calls, no retry.
		await settleSaves();
		expect(recordChunkAttempt).toHaveBeenCalledTimes(2);
	});

	it('shows no notice on the summary when every insert saved', async () => {
		render(TypingSession, {
			...loaded(passages(2)),
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
			...loaded(passages(3)),
			startIndex: 0,
			chunksCompleted: 0,
			completedChunkIds: [],
			userId: 'user-1'
		});

		await typeText('a b');

		// Optimistically advanced to 1/3 — and NOT rewound once the failure lands.
		await expect.element(page.getByTestId('page-meta')).toHaveTextContent('Page 2 of 3 · 33%');
		await expect.poll(() => recordChunkAttempt.mock.calls.length).toBe(1);
		await settleSaves();
		await expect.element(page.getByTestId('page-meta')).toHaveTextContent('Page 2 of 3 · 33%');

		await typeText('c d');
		await typeText('e f');

		await expect
			.element(page.getByTestId('summary-save-pending'))
			.toHaveTextContent("3 pages will be saved when you're back online.");
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
			...loaded(passages(2)),
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
			...loaded(passages(2)),
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
			...loaded(passages(2)),
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
			...loaded(passages(2)),
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
			...loaded(passages(2)),
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
			...loaded(passages(2)),
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
			...loaded(passages(2)),
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
			...loaded(passages(2)),
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
				...loaded(passages(2)),
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
			.toHaveTextContent("One page will be saved when you're back online.");
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
			...loaded(passages(1)),
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
			...loaded(passages(1)),
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
			...loaded(passages(1)),
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
			.toHaveTextContent("One page will be saved when you're back online.");
		// Inserted into the established region, and focus was not disturbed to say so.
		expect(summary.element().querySelector('[role="status"]')).toBe(region);
		expect(document.activeElement).toBe(summary.element());
	});
});

describe('TypingSession.svelte — cumulative running metrics (spec #12 §5)', () => {
	it("keeps showing a WPM figure across a passage boundary and at the second passage's first word boundary", async () => {
		render(TypingSession, {
			...loaded(passages(3)),
			startIndex: 0,
			chunksCompleted: 0,
			completedChunkIds: [],
			userId: 'user-1'
		});

		await expect.element(page.getByTestId('page-meta')).toHaveTextContent('— wpm');

		await typeText('a '); // first word boundary of the session
		await expect.poll(metaText).toMatch(/· \d+ wpm ·/);

		await typeText('b'); // completes passage 1; metrics must NOT reset to '—'
		await expect.element(page.getByTestId('page-meta')).toHaveTextContent('Page 2 of 3');
		expect(metaText()).toMatch(/· \d+ wpm ·/);

		await typeText('c '); // first word boundary of the SECOND passage
		expect(metaText()).toMatch(/· \d+ wpm ·/);
	});
});

/**
 * Windowed reading: the prefetch, `awaiting`, and the end-of-window state (spec #18 §6, §8).
 *
 * Every book below is LONGER than the window it was handed, which is the only way any of
 * this is reachable. The seam is the global `fetch` — a plain first-party request, never a
 * Supabase client call, which is itself part of what these tests hold in place (§9).
 */
describe('TypingSession.svelte — the window prefetch (spec #18 §6)', () => {
	/** Eight passages, of which the session is handed the first WINDOW_SIZE (spec #32 retune). */
	const all = passages(8);
	const loadedCount = WINDOW_SIZE;
	/** How many passages must complete before PREFETCH_THRESHOLD remain loaded. */
	const typedBeforeFire = loadedCount - PREFETCH_THRESHOLD;

	/** The chunks endpoint's answer for the second window: passages loadedCount..7. */
	function secondWindow(): Response {
		return jsonResponse({
			from: loadedCount,
			chunks: makeChunks(all.slice(loadedCount), loadedCount),
			chunkCount: 8
		});
	}

	it('fires when PREFETCH_THRESHOLD passages remain loaded, and not before', async () => {
		fetchMock.mockImplementation(async () => secondWindow());

		render(TypingSession, {
			...windowed(all.slice(0, loadedCount), 8),
			startIndex: 0,
			chunksCompleted: 0,
			completedChunkIds: [],
			userId: null
		});

		// A freshly landed window loaded and none typed: this is the refire check `window.ts`
		// documents — the gap must stay ABOVE the threshold, or nothing here would ever be
		// testable as "not before".
		await expect.element(page.getByTestId('page-meta')).toHaveTextContent('Page 1 of 8');
		expect(chunkRequests()).toEqual([]);

		for (let i = 0; i < typedBeforeFire - 1; i += 1) {
			await typeText(all[i]);
			expect(chunkRequests()).toEqual([]); // still short of the threshold
		}
		await typeText(all[typedBeforeFire - 1]); // crosses the threshold

		await expect
			.poll(chunkRequests)
			.toEqual([`/api/books/test-book/chunks?from=${loadedCount}&limit=${WINDOW_SIZE}`]);
	});

	it('does not block input while the window is in flight', async () => {
		// A request that never settles. Typing has to carry on regardless — the fetch is behind
		// the typing path, never in front of it.
		fetchMock.mockImplementation(() => new Promise<Response>(() => {}));

		render(TypingSession, {
			...windowed(all.slice(0, loadedCount), 8),
			startIndex: 0,
			chunksCompleted: 0,
			completedChunkIds: [],
			userId: null
		});

		for (let i = 0; i < typedBeforeFire; i += 1) {
			await typeText(all[i]); // the last of these crosses the threshold
		}
		await expect.poll(() => chunkRequests().length).toBe(1);

		// The last loaded passage is still live and accepting keystrokes against a request
		// that has not come back.
		await expect
			.element(page.getByTestId('page-meta'))
			.toHaveTextContent(`Page ${loadedCount} of 8`);
		await expect
			.element(page.getByTestId('typing-surface'))
			.toHaveTextContent(all[loadedCount - 1]);
		expect(page.getByTestId('page-awaiting').query()).toBeNull();
	});

	it('is single-flight: overlapping triggers join one request', async () => {
		fetchMock.mockImplementation(() => new Promise<Response>(() => {}));

		render(TypingSession, {
			...windowed(all.slice(0, loadedCount), 8),
			startIndex: 0,
			chunksCompleted: 0,
			completedChunkIds: [],
			userId: null
		});

		for (let i = 0; i < typedBeforeFire; i += 1) {
			await typeText(all[i]); // trigger 1: the last of these crosses the threshold
		}
		await expect.poll(() => chunkRequests().length).toBe(1);

		await typeText(all[typedBeforeFire]); // trigger 2: completes the last loaded chunk → awaiting
		window.dispatchEvent(new Event('online')); // trigger 3: connectivity
		window.dispatchEvent(new Event('online')); // and again, for good measure
		await tick();

		// One in-flight request, joined by every trigger — the `drainOnce` shape. Without it
		// these would race four copies of the same window into the reducer.
		expect(chunkRequests()).toHaveLength(1);
	});

	it('merges arriving completed ids into the optimistic set rather than replacing it', async () => {
		fetchMock.mockImplementation(async (input) => {
			if (String(input).includes('/chunks?')) {
				return secondWindow();
			}
			// The server does not yet know about the passages just completed — their inserts
			// are still in flight. Replacing the set with this answer would drop them.
			return jsonResponse({
				from: loadedCount,
				limit: loadedCount,
				completedChunkIds: ['chunk-5', 'chunk-6']
			});
		});

		render(TypingSession, {
			...windowed(all.slice(0, loadedCount), 8),
			startIndex: 0,
			chunksCompleted: 0,
			completedChunkIds: [],
			userId: 'user-1'
		});

		for (let i = 0; i < typedBeforeFire; i += 1) {
			await typeText(all[i]);
		}

		// typedBeforeFire completed this session + the two arriving ids, of eight total. A
		// replacement would read the two arriving ids alone — fewer completed than this
		// session alone has already done — which is the reading this test exists to fail on.
		const completed = typedBeforeFire + 2;
		const percent = Math.round((100 * completed) / 8);
		await expect
			.element(page.getByTestId('page-meta'))
			.toHaveTextContent(`Page ${typedBeforeFire + 1} of 8 · ${percent}%`);
		expect(progressRequests()).toEqual([
			`/api/books/test-book/progress?from=${loadedCount}&limit=${loadedCount}`
		]);
		await settleSaves();
	});

	it('issues no progress request at all for a guest', async () => {
		fetchMock.mockImplementation(async () => secondWindow());

		render(TypingSession, {
			...windowed(all.slice(0, loadedCount), 8),
			startIndex: 0,
			chunksCompleted: 0,
			completedChunkIds: [],
			userId: null
		});

		for (let i = 0; i < typedBeforeFire; i += 1) {
			await typeText(all[i]);
		}
		await expect.poll(() => chunkRequests().length).toBe(1);
		await tick();

		// The window is public and shared-cacheable; progress is private and is not a guest's
		// concern. The guest gate is the acceptance criterion, not an optimisation.
		expect(progressRequests()).toEqual([]);
	});

	it('never invalidates the load, however many windows arrive', async () => {
		// Spec §6, restating #15 §11: on the typing screen a load invalidation re-runs the book
		// read and re-serialises mid-passage. Windows arrive through the endpoint into
		// component state, and nothing else.
		fetchMock.mockImplementation(async () => secondWindow());

		render(TypingSession, {
			...windowed(all.slice(0, loadedCount), 8),
			startIndex: 0,
			chunksCompleted: 0,
			completedChunkIds: [],
			userId: null
		});

		for (let i = 0; i < loadedCount; i += 1) {
			await typeText(all[i]);
		}
		// Past the window boundary, into chunks only the endpoint could have supplied.
		await expect
			.element(page.getByTestId('page-meta'))
			.toHaveTextContent(`Page ${loadedCount + 1} of 8`);

		expect(invalidateAll).not.toHaveBeenCalled();
	});

	it('asks for nothing when the whole book is already loaded', async () => {
		// The 3-chunk fixture book is shorter than one window (spec §9): it must open, complete
		// end to end, and never reach for a window that does not exist.
		render(TypingSession, {
			...loaded(passages(3)),
			startIndex: 0,
			chunksCompleted: 0,
			completedChunkIds: [],
			userId: null
		});

		await typeText('a b');
		await typeText('c d');
		expect(page.getByTestId('page-awaiting').query()).toBeNull();
		await typeText('e f');

		await expect.element(page.getByTestId('session-summary')).toBeInTheDocument();
		expect(chunkRequests()).toEqual([]);
	});
});

describe('TypingSession.svelte — awaiting and the end of the window (spec #18 §8)', () => {
	const all = passages(8);

	/** A book of eight passages holding only the first: the boundary is one passage away. */
	function oneLoaded() {
		return windowed(all.slice(0, 1), 8);
	}

	function awaitingPanel() {
		return page.getByTestId('page-awaiting');
	}

	function statusRegion(): Element | null {
		return document.querySelector('[data-testid="window-status"]');
	}

	function statusText(): string {
		return statusRegion()?.textContent?.trim() ?? '';
	}

	it('shows the loading state while the window is on its way, without moving focus', async () => {
		let release!: () => void;
		fetchMock.mockImplementation(
			() =>
				new Promise<Response>((resolve) => {
					release = () =>
						resolve(jsonResponse({ from: 1, chunks: makeChunks(all.slice(1), 1), chunkCount: 8 }));
				})
		);

		render(TypingSession, {
			...oneLoaded(),
			startIndex: 0,
			chunksCompleted: 0,
			completedChunkIds: [],
			userId: null
		});

		await typeText('a b'); // the only loaded passage — the session runs out of text

		await expect.element(awaitingPanel()).toHaveAttribute('data-state', 'loading');
		await expect.element(awaitingPanel()).toHaveTextContent('Loading the next page');
		expect(statusText()).toBe('Loading the next page…');
		// Not the finished-book summary: the session has more book to go.
		expect(page.getByTestId('session-summary').query()).toBeNull();
		// Focus was neither moved nor trapped: the hidden input is still mounted and still has
		// it, so the moment the window lands the user types on without touching anything.
		await expect.element(page.getByTestId('typing-surface')).toBeInTheDocument();
		expect(document.activeElement).toBe(page.getByTestId('typing-input').element());

		release();

		await expect.element(page.getByTestId('typing-surface')).toHaveTextContent('c d');
		expect(awaitingPanel().query()).toBeNull();
		expect(statusText()).toBe('');
		expect(document.activeElement).toBe(page.getByTestId('typing-input').element());
	});

	it('says so when it has typed to the end of what it holds, distinctly from finishing the book', async () => {
		// `fetchMock` rejects by default: offline, from before the first keystroke.
		render(TypingSession, {
			...oneLoaded(),
			startIndex: 0,
			chunksCompleted: 0,
			completedChunkIds: [],
			userId: null
		});

		// The live region is in the accessibility tree from mount, EMPTY. Captured now and
		// compared after the message lands: a region built in the same mutation as its content
		// is never announced, which is the exact trap spec #15 phase 2c hit.
		const region = statusRegion();
		expect(region, 'the live region must exist before the message does').not.toBeNull();
		expect(region?.getAttribute('role')).toBe('status');
		expect(region?.getAttribute('aria-live')).toBe('polite');

		// The prefetch has already failed by now, and nothing says so: a failure is never
		// surfaced mid-passage (spec §6).
		await expect.poll(() => chunkRequests().length).toBe(1);
		expect(awaitingPanel().query()).toBeNull();
		expect(statusText()).toBe('');

		await typeText('a b'); // out of text

		await expect.element(awaitingPanel()).toHaveAttribute('data-state', 'stalled');
		await expect
			.element(awaitingPanel())
			.toHaveTextContent('as far as this book is loaded on this device');
		await expect
			.element(page.getByTestId('page-awaiting-hint'))
			.toHaveTextContent('as soon as you');
		// Announced through the region that was already there — the same node, not a new one.
		expect(statusRegion()).toBe(region);
		expect(statusText()).toBe("That's as far as this book is loaded on this device.");

		// And distinct from "you finished the book": no summary, no figures, no restart.
		expect(page.getByTestId('session-summary').query()).toBeNull();
		expect(page.getByTestId('summary-wpm').query()).toBeNull();
		expect(page.getByTestId('summary-restart-session').query()).toBeNull();
	});

	it('clears itself when connectivity returns', async () => {
		render(TypingSession, {
			...oneLoaded(),
			startIndex: 0,
			chunksCompleted: 0,
			completedChunkIds: [],
			userId: null
		});

		await typeText('a b');
		await expect.element(awaitingPanel()).toHaveAttribute('data-state', 'stalled');

		// The network comes back, and the browser says so. Nothing is clicked and nothing is
		// reloaded: the `online` retry resolves the state on its own (spec §8).
		fetchMock.mockImplementation(async () =>
			jsonResponse({ from: 1, chunks: makeChunks(all.slice(1), 1), chunkCount: 8 })
		);
		window.dispatchEvent(new Event('online'));

		await expect.element(page.getByTestId('typing-surface')).toHaveTextContent('c d');
		expect(awaitingPanel().query()).toBeNull();
		expect(statusText()).toBe('');
		await expect.element(page.getByTestId('page-meta')).toHaveTextContent('Page 2 of 8');
	});

	it('retries on the next completion after a failure, and keeps every completed passage buffered', async () => {
		// Two loaded passages, offline. The first completion's prefetch fails; the second
		// completion is the retry point (spec §6) — and both passages are buffered, because 2c's
		// guarantee about completions is untouched by running out of text.
		render(TypingSession, {
			...windowed(all.slice(0, 2), 8),
			startIndex: 0,
			chunksCompleted: 0,
			completedChunkIds: [],
			userId: null
		});

		await typeText('a b');
		await expect.poll(() => chunkRequests().length).toBeGreaterThan(0);
		const afterFirst = chunkRequests().length;

		await typeText('c d');

		// The completion is a retry point, not a one-shot: a stall is re-attempted every time
		// the session reaches a boundary, which is what makes the end-of-window state clear
		// itself on its own the moment the network is back.
		await expect.poll(() => chunkRequests().length).toBeGreaterThan(afterFirst);
		await expect.element(awaitingPanel()).toHaveAttribute('data-state', 'stalled');
		await expect
			.poll(() => bufferEntries().map((entry) => entry.chunkId))
			.toEqual(['chunk-0', 'chunk-1']);
	});
});

describe('TypingSession.svelte — the page navigator, A′ seek (spec #32 §10 D1)', () => {
	function nextButton() {
		return page.getByTestId('page-nav-next');
	}

	function jumpBox() {
		return page.getByTestId('page-nav-jump');
	}

	/** The last `?page=` pushState was called with, or null if it never was. */
	function lastPushedPage(): string | null {
		const call = pushState.mock.calls.at(-1) as [string, unknown] | undefined;
		if (!call) return null;
		const url = new URL(call[0], 'http://localhost');
		return url.searchParams.get('page');
	}

	it('an in-window jump updates the URL via pushState and issues no fetch — the same session continues', async () => {
		// Every page of a WINDOW_SIZE-long book is already loaded (chunkCount === contents.length),
		// so "next" is a jump the session can serve entirely from what it already has: nothing
		// outside the loaded map, and therefore nothing for `seekWindow` to go and fetch.
		const all = passages(WINDOW_SIZE);
		render(TypingSession, {
			...loaded(all),
			startIndex: 0,
			chunksCompleted: 0,
			completedChunkIds: [],
			userId: null
		});

		await expect.element(page.getByTestId('page-meta')).toHaveTextContent('Page 1 of');
		await userEvent.click(nextButton());

		await expect
			.element(page.getByTestId('page-meta'))
			.toHaveTextContent(`Page 2 of ${WINDOW_SIZE}`);
		await expect.element(page.getByTestId('typing-surface')).toHaveTextContent(all[1]);
		// The whole point of A′ over a remount: a jump the window already covers costs no
		// request at all — `seekWindow` is never even asked to compute bounds.
		expect(chunkRequests()).toEqual([]);
		expect(lastPushedPage()).toBe('2');
		// Typing on the page landed on proves the session is still the same live reducer, not a
		// fresh one seeded at index 1 — a remount would also show "Page 2 of N", so this is the
		// assertion that actually distinguishes the two.
		await typeText(all[1]);
		await expect
			.element(page.getByTestId('page-meta'))
			.toHaveTextContent(`Page 3 of ${WINDOW_SIZE}`);
	});

	it('a jump outside the loaded window fetches a fresh window anchored at the target, then renders it', async () => {
		const loadedCount = WINDOW_SIZE;
		const chunkCount = WINDOW_SIZE + 3;
		const all = passages(chunkCount);
		const targetIndex = chunkCount - 1; // well past the first loaded window

		const bounds = seekWindow(targetIndex, chunkCount);
		fetchMock.mockImplementation(async () =>
			jsonResponse({
				from: bounds.from,
				chunks: makeChunks(all.slice(bounds.from, bounds.from + bounds.limit), bounds.from),
				chunkCount
			})
		);

		render(TypingSession, {
			...windowed(all.slice(0, loadedCount), chunkCount),
			startIndex: 0,
			chunksCompleted: 0,
			completedChunkIds: [],
			userId: null
		});
		await expect.element(page.getByTestId('page-meta')).toHaveTextContent('Page 1 of');

		await userEvent.fill(jumpBox(), String(targetIndex + 1));
		await userEvent.keyboard('{Enter}');

		// The seek's OWN fetch is anchored at the target with locally-clamped bounds
		// (`seekWindow`). A plain "next page is one keystroke away" prefetch can ALSO fire
		// concurrently off the same state update (`navigateToIndex`'s own comment: not routed
		// through the single-flight lane, "an acceptable trade" against a second lane) — so the
		// request list may hold more than one entry, and asserting on it is about the seek's
		// request being IN there, not about being the only one.
		await expect
			.poll(() =>
				chunkRequests().some(
					(url) => url === `/api/books/test-book/chunks?from=${bounds.from}&limit=${bounds.limit}`
				)
			)
			.toBe(true);
		await expect
			.element(page.getByTestId('page-meta'))
			.toHaveTextContent(`Page ${targetIndex + 1} of ${chunkCount}`);
		await expect.element(page.getByTestId('typing-surface')).toHaveTextContent(all[targetIndex]);
		expect(lastPushedPage()).toBe(String(targetIndex + 1));
	});

	it('flushes a debounced in-page-restore save before the seek, via beforeNavigate', async () => {
		// A save still in flight when a jump fires would otherwise race the seek and could write
		// against the wrong index (TypingSession's own comment on `navigateToIndex`). This proves
		// the flush actually happens rather than trusting the comment: `beforeNavigate`'s
		// registered handler must exist and must not throw when the seek path calls it directly.
		const all = passages(WINDOW_SIZE);
		render(TypingSession, {
			...loaded(all),
			startIndex: 0,
			chunksCompleted: 0,
			completedChunkIds: [],
			userId: null
		});
		expect(beforeNavigate).toHaveBeenCalled();

		await typeText(all[0].slice(0, 1)); // one keystroke, short of completion — schedules a debounced save
		await userEvent.click(nextButton());

		// The jump's own immediate flush (not the 2s debounce) is what actually wrote this —
		// proven by it being present well before the debounce could have fired.
		const raw = localStorage.getItem(PAGE_STATE_KEY);
		expect(
			raw,
			'the half-typed first page should have been flushed before the jump'
		).not.toBeNull();
		const saved = JSON.parse(raw!) as PageState[];
		expect(saved.find((entry) => entry.index === 0)?.prefixLength).toBe(1);
	});
});

describe('TypingSession.svelte — in-page restore (spec #32 §8)', () => {
	it('restores a saved prefix as already-correct-but-unjudged, and measures only the new span', async () => {
		const content = 'abcdefghij';
		const book = makeBook(1);
		savePageState(
			getAttemptStorage(PAGE_STATE_KEY),
			{
				bookId: book.bookId,
				chunkId: 'chunk-0',
				index: 0,
				prefixLength: 4,
				savedTextLength: content.length,
				savedAt: Date.now()
			},
			Date.now()
		);

		render(TypingSession, {
			book,
			window: makeWindow([content], 1),
			startIndex: 0,
			chunksCompleted: 0,
			completedChunkIds: [],
			mode: NORMAL,
			userId: 'user-1'
		});

		// The restored prefix renders correct immediately, with no keystroke typed this sitting.
		function chars(): NodeListOf<HTMLElement> {
			return page.getByTestId('typing-surface').element().querySelectorAll<HTMLElement>('.char');
		}
		await expect.poll(() => chars().length).toBeGreaterThan(4);
		for (let i = 0; i < 4; i += 1) {
			expect(chars()[i].dataset.state).toBe('correct');
		}
		expect(chars()[4].className).toMatch(/caret/); // cursor sits right after the prefix

		// Finish the page by typing only the remaining span.
		recordChunkAttempt.mockResolvedValue({ saved: true });
		await typeText(content.slice(4));

		await expect.poll(() => recordChunkAttempt.mock.calls.length).toBe(1);
		const [, attempt] = recordChunkAttempt.mock.calls[0] as [unknown, { measuredChars: number }];
		// Only the six characters typed THIS sitting are measured — the restored four are
		// correct-but-unjudged and contribute to neither the numerator nor the denominator.
		expect(attempt.measuredChars).toBe(6);
	});

	it('an untouched saved page is cleared once its attempt is recorded, so a later visit does not restore a finished page', async () => {
		const content = 'ab';
		const book = makeBook(1);
		savePageState(
			getAttemptStorage(PAGE_STATE_KEY),
			{
				bookId: book.bookId,
				chunkId: 'chunk-0',
				index: 0,
				prefixLength: 1,
				savedTextLength: content.length,
				savedAt: Date.now()
			},
			Date.now()
		);

		render(TypingSession, {
			book,
			window: makeWindow([content], 1),
			startIndex: 0,
			chunksCompleted: 0,
			completedChunkIds: [],
			mode: NORMAL,
			userId: null
		});

		await typeText(content.slice(1)); // completes the page
		await expect.element(page.getByTestId('session-summary')).toBeInTheDocument();

		const raw = localStorage.getItem(PAGE_STATE_KEY);
		const saved = raw === null ? [] : (JSON.parse(raw) as PageState[]);
		expect(saved.find((entry) => entry.index === 0)).toBeUndefined();
	});
});
