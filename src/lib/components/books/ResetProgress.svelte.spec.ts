import { page, userEvent } from 'vitest/browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import { PAGE_STATE_KEY, savePageState, readPageState } from '$lib/progress/page-state';
import { getAttemptStorage } from '$lib/progress/storage';

/**
 * The progress reset's two-step confirmation (spec #51 §6/§8).
 *
 * `use:enhance` is mocked down to "call the submit handler, then run what it returns", which is
 * exactly the seam this component depends on: it never inspects the response, it only needs the
 * callback to fire so the local page-state clear happens. The action itself is proved in
 * `src/routes/books/[slug]/page.server.spec.ts`, and the database rules in the migration's own
 * E2E — a component test cannot prove a trigger fired.
 */
/**
 * Actual SUBMISSIONS, not `enhance` attachments — the two are easy to conflate and only one of
 * them means "something was written". `enhance` runs the moment the confirmation renders, so
 * counting attachments would report a submit for merely opening the prompt.
 */
const submissions: string[] = [];

vi.mock('$app/forms', () => ({
	enhance: (form: HTMLFormElement, submit: (input: unknown) => unknown) => {
		const handler = async (event: Event) => {
			event.preventDefault();
			submissions.push(form.getAttribute('action') ?? '');
			const result = await submit({ form });
			if (typeof result === 'function') {
				// SvelteKit hands the returned callback `{ update, result, ... }`; the component
				// only ever calls `update`.
				await (result as (arg: unknown) => unknown)({ update: async () => {} });
			}
		};
		form.addEventListener('submit', handler);
		return { destroy: () => form.removeEventListener('submit', handler) };
	}
}));

import ResetProgress from './ResetProgress.svelte';

const BOOK_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const NOW = Date.now();

function draft(bookId: string, index: number) {
	return {
		bookId,
		chunkId: `chunk-${bookId}-${index}`,
		index,
		prefixLength: 120,
		savedTextLength: 1400,
		savedAt: NOW
	};
}

beforeEach(() => {
	submissions.length = 0;
	localStorage.clear();
});

afterEach(() => {
	localStorage.clear();
});

describe('ResetProgress.svelte', () => {
	const trigger = () => page.getByTestId('book-detail-reset');
	const confirm = () => page.getByTestId('book-detail-reset-confirm');
	const cancel = () => page.getByTestId('book-detail-reset-cancel');

	it('shows only the trigger until it is clicked', async () => {
		render(ResetProgress, { bookId: BOOK_ID });

		await expect.element(trigger()).toBeInTheDocument();
		expect(confirm().elements()).toHaveLength(0);
		expect(cancel().elements()).toHaveLength(0);
	});

	it('reveals the confirmation and puts focus on Cancel, not on the destructive control', async () => {
		render(ResetProgress, { bookId: BOOK_ID });

		await trigger().click();

		await expect.element(confirm()).toBeInTheDocument();
		// A stray Enter after the first click must not complete the action it opened.
		await expect.element(cancel()).toHaveFocus();
	});

	it('writes nothing on the first click', async () => {
		render(ResetProgress, { bookId: BOOK_ID });
		savePageState(getAttemptStorage(PAGE_STATE_KEY), draft(BOOK_ID, 3), NOW);

		await trigger().click();

		expect(submissions).toEqual([]);
		expect(
			readPageState(
				getAttemptStorage(PAGE_STATE_KEY),
				{ bookId: BOOK_ID, chunkId: `chunk-${BOOK_ID}-3`, index: 3, textLength: 1400 },
				NOW
			)
		).not.toBeNull();
	});

	it('Cancel returns to the trigger and restores focus to it', async () => {
		render(ResetProgress, { bookId: BOOK_ID });

		await trigger().click();
		await cancel().click();

		await expect.element(trigger()).toBeInTheDocument();
		expect(confirm().elements()).toHaveLength(0);
		await expect.element(trigger()).toHaveFocus();
	});

	it('Escape closes the confirmation, like every other dismissible surface', async () => {
		render(ResetProgress, { bookId: BOOK_ID });

		await trigger().click();
		await userEvent.keyboard('{Escape}');
		await tick();

		await expect.element(trigger()).toBeInTheDocument();
		expect(confirm().elements()).toHaveLength(0);
	});

	it('confirming clears this book’s drafts and leaves another book’s alone', async () => {
		const storage = getAttemptStorage(PAGE_STATE_KEY);
		savePageState(storage, draft(BOOK_ID, 0), NOW);
		savePageState(storage, draft(BOOK_ID, 4), NOW);
		savePageState(storage, draft('other-book', 2), NOW);
		render(ResetProgress, { bookId: BOOK_ID });

		await trigger().click();
		await confirm().click();
		await tick();

		const read = (bookId: string, index: number) =>
			readPageState(
				storage,
				{
					bookId,
					chunkId: `chunk-${bookId}-${index}`,
					index,
					textLength: 1400
				},
				NOW
			);
		expect(read(BOOK_ID, 0)).toBeNull();
		expect(read(BOOK_ID, 4)).toBeNull();
		// A reset is per book, never a wipe.
		expect(read('other-book', 2)).not.toBeNull();
	});

	it('posts to the reset action', async () => {
		render(ResetProgress, { bookId: BOOK_ID });

		await trigger().click();

		const form = confirm().element().closest('form')!;
		expect(form.getAttribute('method')?.toLowerCase()).toBe('post');
		expect(form.getAttribute('action')).toBe('?/reset');
	});

	it('Cancel is not a submit — it dismisses without posting', async () => {
		render(ResetProgress, { bookId: BOOK_ID });

		await trigger().click();
		await cancel().click();

		expect(submissions).toEqual([]);
	});
});
