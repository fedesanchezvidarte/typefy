import { expect, guestTest as test } from './fixtures/auth';
import {
	isLocalStack,
	localSecretKey,
	secretClient,
	SUPABASE_URL,
	type AnyClient
} from './support/supabase';
import { arrangeProbeBook, retireProbeBook, type ProbeBook } from './support/probe-books';
import { BEST_MEASURED_CHARS_FLOOR } from '../src/lib/progress/client';

/**
 * The 100-character best floor (spec #24 §5, `BEST_MEASURED_CHARS_FLOOR`), proved from a real
 * keystroke rather than an inserted row — spec #26, gap G2.
 *
 * `progress.e2e.ts`'s "the best guard is a floor at 100 measured characters, tested on both
 * sides of it" already pins the RULE by inserting `chunk_attempts` rows directly. What it
 * cannot prove is that the ENGINE ever produces a short measured span in the first place: a
 * chunk this short is not something any seeded fixture or probe book elsewhere holds, and the
 * app's own `measured_chars` accounting (word-boundary live figures, the completion payload)
 * is a client computation no direct insert exercises. This file types the passage for real,
 * through the OS-level keyboard path, in Normal mode, and reads back what the trigger did with
 * what the browser actually wrote.
 */

const SLUG = 'best-floor-probe';

/** Well under the floor — the whole point of the probe. */
const SHORT_CONTENT = 'The quick fox darts past the old barn.';

test.describe('a measured span under the best floor', () => {
	test.skip(
		!isLocalStack,
		`refusing to publish a probe book against a non-local Supabase (${SUPABASE_URL})`
	);
	test.skip(
		!localSecretKey(),
		'needs the local secret key: no client role may publish a book, and none should'
	);

	let service: AnyClient;
	let book: ProbeBook;

	test.beforeAll(async () => {
		expect(
			[...SHORT_CONTENT].length,
			'the probe passage must stay under BEST_MEASURED_CHARS_FLOOR for this test to mean anything'
		).toBeLessThan(BEST_MEASURED_CHARS_FLOOR);

		service = secretClient()!;
		book = await arrangeProbeBook(service, {
			slug: SLUG,
			title: 'Best floor probe',
			author: 'probe',
			language: 'en',
			contents: [SHORT_CONTENT]
		});
	});

	test.afterAll(async () => {
		await retireProbeBook(service, SLUG);
	});

	test('never sets a best_wpm or best_accuracy_raw, even though the attempt completes with a plausible gross_wpm', async ({
		page,
		mintUser,
		session
	}) => {
		test.setTimeout(60_000);

		const user = await mintUser();
		await session.signInAs(user);

		await page.goto(`/type/${book.slug}`);
		await expect(page.getByTestId('typing-surface')).toBeVisible();
		await expect(page.getByTestId('typing-input')).toBeFocused();
		// Default mode is Normal (no cookie set) — the whole-clean-traversal rule needs this to
		// be a genuine measured span, not a Zen one that would set no figures for a different
		// reason entirely.
		await expect(page.getByTestId('zen-toggle')).toHaveAttribute('aria-pressed', 'false');

		await page.keyboard.type(SHORT_CONTENT, { delay: 0 });

		// The book is one chunk long, so completion ends the session — the summary is the
		// stopped state to wait on rather than the meta line, which this book never reaches a
		// "next passage" state to update.
		await expect(page.getByTestId('session-summary')).toBeVisible();

		// The attempt row itself: a real, non-null gross_wpm and a measured span under the
		// floor — proving the short span is what the app actually recorded, not an assumption.
		const attempt = async () => {
			const { data, error } = await user.client
				.from('chunk_attempts')
				.select('completed, mode, gross_wpm, accuracy_raw, measured_chars')
				.eq('book_id', book.id);
			expect(error, `reading chunk_attempts failed: ${error?.message}`).toBeNull();
			return data ?? [];
		};
		await expect
			.poll(async () => (await attempt()).length, {
				message: 'the completion should have written exactly one attempt row'
			})
			.toBe(1);
		const [row] = await attempt();
		expect(row.completed).toBe(true);
		expect(row.mode).toBe('normal');
		expect(
			Number(row.gross_wpm),
			'a whole-clean Normal traversal should carry a real wpm'
		).toBeGreaterThan(0);
		expect(Number(row.accuracy_raw)).toBeGreaterThan(0);
		expect(
			row.measured_chars,
			'the measured span must actually be under the floor for this test to be non-vacuous'
		).toBeLessThan(BEST_MEASURED_CHARS_FLOOR);

		// The rollup the floor guards: a plausible attempt on record, but no best set from it.
		const { data: rollup, error: rollupError } = await user.client
			.from('chunk_progress')
			.select('best_wpm, best_accuracy_raw, attempt_count')
			.eq('book_id', book.id)
			.maybeSingle();
		expect(rollupError, `reading chunk_progress failed: ${rollupError?.message}`).toBeNull();
		expect(
			rollup,
			'the trigger should have written a chunk_progress row for the attempt'
		).not.toBeNull();
		expect(rollup!.attempt_count).toBe(1);
		expect(rollup!.best_wpm, 'a span under the floor must never set best_wpm').toBeNull();
		expect(
			rollup!.best_accuracy_raw,
			'a span under the floor must never set best_accuracy_raw'
		).toBeNull();
	});
});
