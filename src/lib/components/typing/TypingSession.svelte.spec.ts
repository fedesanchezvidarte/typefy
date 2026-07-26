import { page, userEvent } from 'vitest/browser';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import type { TypeableText } from '$lib/types';
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
const getBrowserSupabase = vi.hoisted(() => vi.fn(() => ({ __mock: 'supabase-client' })));
const goto = vi.hoisted(() => vi.fn());

vi.mock('$lib/supabase/browser', () => ({ getBrowserSupabase }));
vi.mock('$lib/progress/client', () => ({ recordChunkAttempt }));
// Mocked purely so "no re-authentication flow is triggered" (spec §6) is assertable:
// a redirect out of the session would have to go through `goto`.
vi.mock('$app/navigation', () => ({ goto }));

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
	getBrowserSupabase.mockClear();
	goto.mockClear();
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
		recordChunkAttempt.mockResolvedValue({ saved: false, reason: 'error' });

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

	it('treats an expired token as an ordinary save failure: notice shown, no re-auth flow, no rollback of the figure', async () => {
		// An expired token is not a distinct code path — `recordChunkAttempt` reports the
		// refused insert the same way it reports any other (spec §6).
		recordChunkAttempt.mockResolvedValue({ saved: false, reason: 'error' });
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
			.element(page.getByTestId('summary-save-failures'))
			.toHaveTextContent("3 passages couldn't be saved.");
		// No re-authentication flow: nothing navigated, and no sign-in prompt was raised
		// (that prompt is the guest-only surface).
		expect(goto).not.toHaveBeenCalled();
		expect(window.location.href).toBe(hrefBefore);
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
