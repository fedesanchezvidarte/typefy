import AxeBuilder from '@axe-core/playwright';
import type { Page, Route } from '@playwright/test';
import { expect, guestTest as test } from './fixtures/auth';
import {
	isLocalStack,
	localSecretKey,
	secretClient,
	SUPABASE_URL,
	type AnyClient
} from './support/supabase';
import {
	arrangeProbeBook,
	retireProbeBook,
	setFeatured,
	type ProbeBook
} from './support/probe-books';
import { PREFETCH_THRESHOLD, WINDOW_SIZE } from '../src/lib/reading/window';
import { ATTEMPT_BUFFER_KEY, type BufferedChunkAttempt } from '../src/lib/progress/buffer';
import { prideAndPrejudiceExcerpt } from '../src/lib/fixtures/en';
import { tortoiseAndHare } from '../src/lib/fixtures/tortoise';

/**
 * Spec #18's UI & flow and a11y criteria — everything about a session that reaches the end
 * of the text it holds, and everything about what happens when the next window arrives, is
 * late, or never comes.
 *
 * What the unit and component suites already prove is deliberately not re-litigated.
 * `src/lib/reading/window.spec.ts` owns the clamp and the prefetch predicate;
 * `chunks.spec.ts` / `progress.spec.ts` own the two endpoints' contracts;
 * `TypingSession.svelte.spec.ts` owns the prefetch wiring, single flight and the awaiting
 * panel against a mocked `fetch`. These tests exist because a window boundary is a real
 * browser event: a real endpoint answering a real component's real `fetch`, a real
 * `localStorage` buffer, and a real reconnect.
 *
 * **The books.** No seeded fixture book is longer than one window (the longest is 6 chunks
 * against a window of 10) and spec #17's two full-length books are deliberately unpublished
 * — publishing them is §11, after final validation, and not a thing a test may do. So these
 * specs arrange their own published probe books on the LOCAL stack and retire them again in
 * `afterAll` (see `support/probe-books.ts`). They mint throwaway users too, so like every
 * database-touching spec here they refuse to run against anything but a local stack.
 */

/** Longer than one window, so the first window ends in the middle of the book. */
const LONG_CHUNK_COUNT = WINDOW_SIZE + 3;

/**
 * Short passages, because these tests type WHOLE BOOKS through the OS-level keyboard path
 * and the criteria are about boundaries, not about endurance. The index is embedded so a
 * test can assert WHICH passage is on screen, which is what makes the `?passage=N`
 * criterion ("opens the window containing N") checkable rather than merely plausible.
 */
function longChunk(index: number): string {
	return `probe passage ${index}.`;
}

/**
 * The payload probe's passages: realistic length (~520 characters, the size 3a's chunker
 * actually produces), and unique per index so the SSR measurement can prove WHICH chunks
 * were serialised rather than only how many bytes went out.
 */
function payloadChunk(index: number): string {
	const sentence =
		'The window carries only what the session can reach, and the rest of the book stays on the server until the reader gets there. ';
	return `Passage ${index} of the payload probe. ${sentence.repeat(4)}`.slice(0, 520);
}

/**
 * Enough chunks that the WHOLE text is comfortably past the 50 KB the SSR payload must stay
 * under. That is what stops the payload assertion being vacuous: under the whole-book load
 * spec #18 replaced, this book's page would have serialised ~62 KB of text and failed.
 */
const PAYLOAD_CHUNK_COUNT = 120;

const LONG_SLUG = 'window-probe-long';
const PAYLOAD_SLUG = 'window-probe-payload';

/**
 * The window endpoint, as the browser addresses it. A RegExp rather than a glob because the
 * query string carries the range and Playwright's glob does not treat `?` as a literal — and
 * because the sibling `/progress` route must NOT match: several tests below fail the window
 * fetch while leaving the progress fetch alone.
 */
const CHUNKS_ROUTE = /\/api\/books\/[^/]+\/chunks\?/;

const META = 'passage-meta';

function meta(page: Page) {
	return page.getByTestId(META);
}

function awaitingPanel(page: Page) {
	return page.getByTestId('passage-awaiting');
}

function typingInput(page: Page) {
	return page.getByTestId('typing-input');
}

/**
 * Type one whole passage through the OS-level keyboard path.
 *
 * The focus wait is not decoration: the surface focuses its hidden input from an attachment
 * after hydration, and keystrokes sent before that land on `<body>` and are lost silently —
 * the passage simply does not advance, which reads as a product bug rather than as the race
 * it is. (Same helper, same reason, as `progress-buffer.e2e.ts`.)
 */
async function typePassage(page: Page, text: string, delay = 0): Promise<void> {
	await expect(typingInput(page)).toBeFocused();
	await page.keyboard.type(text, { delay });
}

/**
 * Type passages `from`..`to` inclusive of a probe book.
 *
 * Each passage is waited for on the SHEET, not merely in the meta line. The distinction is
 * the whole feature: while a session is `awaiting`, the meta line already reads the index it
 * is waiting for while the sheet still holds the passage just finished (frozen, caret
 * nowhere). Keying the wait on the number alone would type the next passage into a session
 * that is dropping keystrokes, and the failure would look like a product bug rather than
 * like the race it is.
 */
async function typePassages(
	page: Page,
	book: ProbeBook,
	from: number,
	to: number,
	delay = 0
): Promise<void> {
	for (let index = from; index <= to; index += 1) {
		await expect(meta(page)).toContainText(`Passage ${index + 1} of ${book.chunkCount}`);
		await expect(page.getByTestId('typing-surface')).toContainText(book.contents[index]);
		await typePassage(page, book.contents[index], delay);
	}
}

/**
 * Per-keystroke delay for the ONE criterion that is about timing rather than about logic:
 * "typing continues past the boundary without a visible pause".
 *
 * Everything else here types at `delay: 0`, which is the right default — it is the harshest
 * input a reducer can get and it keeps whole-book tests short. But `delay: 0` sends the
 * three passages of cover `PREFETCH_THRESHOLD` buys in a few dozen milliseconds, which no
 * prefetch policy on any network could beat: the test would be measuring Playwright's
 * keystroke rate, not the product. 30 ms per character is still roughly 400 wpm — five times
 * the fastest human on record — so the statement stays strong while giving the prefetch the
 * kind of window a reader actually provides.
 */
const HUMAN_ISH_DELAY_MS = 30;

/**
 * How long a book's page gets to appear after `goto`.
 *
 * Deliberately generous, and deliberately applied ONLY to the first render. Locally the
 * suite runs against `vite dev`, where opening a route the server has not compiled yet can
 * take several seconds — once per server lifetime, invisible to any user, and nothing this
 * feature is about. Every BEHAVIOURAL assertion in this file keeps the default 5 s: a
 * passage that fails to advance, a panel that fails to appear or a state that fails to clear
 * must still fail fast, because those are the product.
 */
const PAGE_READY_TIMEOUT = 20_000;

/** Open a book and wait for its first passage to be on screen and ready to type. */
async function openBook(
	page: Page,
	book: { slug: string; chunkCount: number },
	options: { search?: string; passage?: number } = {}
): Promise<void> {
	await page.goto(`/type/${book.slug}${options.search ?? ''}`);
	await expect(meta(page)).toContainText(`Passage ${options.passage ?? 1} of ${book.chunkCount}`, {
		timeout: PAGE_READY_TIMEOUT
	});
}

/**
 * Watch for the awaiting panel ever entering the DOM, from now until it is read back.
 *
 * "Typing continues past the boundary WITHOUT A VISIBLE PAUSE" and "never enters `awaiting`"
 * are both negatives about a transient state, and a plain `toHaveCount(0)` after the fact
 * would pass just as happily over a panel that appeared and left again between two
 * assertions. A MutationObserver installed before the first keystroke cannot miss it.
 *
 * Re-install after any navigation: it lives on the document it was installed in.
 */
async function watchForAwaiting(page: Page): Promise<void> {
	await page.evaluate(() => {
		const state = { seen: 0 };
		(window as unknown as { __awaiting: typeof state }).__awaiting = state;
		if (document.querySelector('[data-testid="passage-awaiting"]')) state.seen += 1;
		new MutationObserver(() => {
			if (document.querySelector('[data-testid="passage-awaiting"]')) state.seen += 1;
		}).observe(document.body, { childList: true, subtree: true });
	});
}

async function awaitingSightings(page: Page): Promise<number> {
	return page.evaluate(
		() => (window as unknown as { __awaiting?: { seen: number } }).__awaiting?.seen ?? 0
	);
}

/** Record every window request the page issues, without changing what it gets back. */
async function recordWindowRequests(page: Page): Promise<string[]> {
	const urls: string[] = [];
	await page.route(CHUNKS_ROUTE, async (route: Route) => {
		urls.push(new URL(route.request().url()).search);
		await route.continue();
	});
	return urls;
}

/** The attempt buffer exactly as the browser holds it. Malformed storage reads as empty. */
async function readBuffer(page: Page): Promise<BufferedChunkAttempt[]> {
	const raw = await page.evaluate((key) => localStorage.getItem(key), ATTEMPT_BUFFER_KEY);
	if (raw === null) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? (parsed as BufferedChunkAttempt[]) : [];
	} catch {
		return [];
	}
}

/**
 * The SERIALISED SVELTEKIT DATA PAYLOAD of an SSR'd page, in bytes — not the HTML.
 *
 * Measuring the HTML would measure the wrong thing entirely: the typing surface renders one
 * `<span>` per character, so a page's markup is dominated by per-character spans whose size
 * has nothing to do with how much of the BOOK was shipped. What spec #18 bounds is the data
 * the load handed the client — `book`, `window.chunks`, `completedChunkIds` — which is
 * exactly the `data:` argument SvelteKit passes to `kit.start`.
 *
 * Fails loudly rather than returning 0 when the marker is absent: a silent 0 would satisfy
 * a "under 50 KB" assertion forever, including after a framework upgrade moved the payload.
 */
function ssrDataPayload(html: string): string {
	const match = html.match(/^\s*data: (\[.*\]),\s*$/m);
	expect(
		match,
		"could not find SvelteKit's serialised data payload in the SSR HTML — the hydration script's shape may have changed"
	).not.toBeNull();
	return match![1];
}

test.describe('windowed reading (spec #18)', () => {
	test.skip(
		!isLocalStack,
		`refusing to publish probe books against a non-local Supabase (${SUPABASE_URL})`
	);
	test.skip(
		!localSecretKey(),
		'needs the local secret key: no client role may publish a book, and none should'
	);

	let service: AnyClient;
	let long: ProbeBook;
	let payload: ProbeBook;

	test.beforeAll(async () => {
		service = secretClient()!;
		long = await arrangeProbeBook(service, {
			slug: LONG_SLUG,
			title: 'Window probe (long)',
			author: 'probe',
			language: 'en',
			contents: Array.from({ length: LONG_CHUNK_COUNT }, (_, index) => longChunk(index))
		});
		payload = await arrangeProbeBook(service, {
			slug: PAYLOAD_SLUG,
			title: 'Window probe (payload)',
			author: 'probe',
			language: 'en',
			contents: Array.from({ length: PAYLOAD_CHUNK_COUNT }, (_, index) => payloadChunk(index))
		});
	});

	test.afterAll(async () => {
		// Retired, not deleted: the ingestion role has no `delete` grant on `books`, on purpose.
		// Unpublished is enough — the publication policy makes them invisible to every client
		// role, so they cannot leak into another spec's catalog, and `db:reset` clears the rows.
		await retireProbeBook(service, LONG_SLUG);
		await retireProbeBook(service, PAYLOAD_SLUG);
		// The hero test features a seeded book; make sure a failure mid-test cannot leave the
		// landing page pointing somewhere the next run does not expect.
		await setFeatured(service, prideAndPrejudiceExcerpt.id, false);
	});

	test.describe('crossing a window boundary', () => {
		test('a full-length book types past the first window boundary with no visible pause', async ({
			page
		}) => {
			test.setTimeout(120_000);

			// Warm the endpoint before measuring anything that depends on how fast it answers.
			// Locally the suite runs against `vite dev`, where the FIRST request to a route also
			// pays for transforming its module graph — seconds, once per server lifetime, and
			// nothing a user ever experiences (CI runs the production build). Without this, the
			// one criterion here that is genuinely about timing occasionally measures Vite.
			// It weakens nothing: the component still has to issue its own request and consume
			// the response mid-passage for this test to pass.
			await page.request.get(`/api/books/${long.slug}/chunks?from=0&limit=1`);

			await openBook(page, long);
			await watchForAwaiting(page);

			// Chunks 0..9 are the SSR window; 10 is the first passage that only exists because a
			// second window arrived. Typing through 10 and into 11 proves the join is seamless.
			await typePassages(page, long, 0, LONG_CHUNK_COUNT - 2, HUMAN_ISH_DELAY_MS);
			await expect(meta(page)).toContainText(`Passage ${LONG_CHUNK_COUNT} of ${long.chunkCount}`);

			// The whole point: the boundary was crossed and the user never saw a waiting state.
			expect(
				await awaitingSightings(page),
				'the prefetch should have landed before the session ran out of window'
			).toBe(0);
			await expect(typingInput(page)).toBeFocused();
		});

		test('the prefetch fires at three passages remaining and never blocks input', async ({
			page
		}) => {
			test.setTimeout(120_000);

			// A gate, not a delay: the window response is held open until this test says so, so
			// "does not block input while in flight" is asserted against a request that is
			// provably still in flight rather than against a race with a fast local server.
			let release: () => void = () => {};
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			const requests: string[] = [];
			await page.route(CHUNKS_ROUTE, async (route: Route) => {
				requests.push(new URL(route.request().url()).search);
				await held;
				await route.continue();
			});

			await openBook(page, long);
			await watchForAwaiting(page);

			// Up to and including passage 6 (index 5): the active index is then 6, and with the
			// window loaded to 10 that is four passages of cover — one more than the threshold.
			const lastQuietIndex = WINDOW_SIZE - PREFETCH_THRESHOLD - 1;
			await typePassages(page, long, 0, lastQuietIndex - 1);
			await expect(meta(page)).toContainText(`Passage ${lastQuietIndex + 1} of ${long.chunkCount}`);
			expect(requests, 'nothing should be fetched while four passages of cover remain').toEqual([]);

			// One more completion puts the active index at exactly PREFETCH_THRESHOLD from the
			// loaded end, which is where the prefetch is specified to fire.
			await typePassage(page, long.contents[lastQuietIndex]);
			await expect
				.poll(() => requests, { message: 'the prefetch should fire at three passages remaining' })
				.toEqual([`?from=${WINDOW_SIZE}&limit=${WINDOW_SIZE}`]);

			// Still in flight — and typing carries on through two more whole passages regardless.
			await typePassages(page, long, lastQuietIndex + 1, lastQuietIndex + 2);
			await expect(meta(page)).toContainText(`Passage ${lastQuietIndex + 4} of ${long.chunkCount}`);
			expect(requests, 'single-flight: the threshold must not restart the request').toHaveLength(1);
			expect(await awaitingSightings(page)).toBe(0);

			release();
			// And once it lands the session simply carries on past the boundary.
			await typePassages(page, long, lastQuietIndex + 3, WINDOW_SIZE);
			await expect(meta(page)).toContainText(`Passage ${WINDOW_SIZE + 2} of ${long.chunkCount}`);
		});

		test('?passage=N beyond the first window opens the window containing N', async ({ page }) => {
			const requests = await recordWindowRequests(page);

			// 1-based in the URL: passage 12 is index 11, two windows into a 13-chunk book.
			const passage = LONG_CHUNK_COUNT - 1;
			const index = passage - 1;
			await openBook(page, long, { search: `?passage=${passage}`, passage });
			// The window OPENS AT the passage rather than at a grid-aligned origin, so the text on
			// screen is passage 12's own — this is the assertion that would fail if the load had
			// served window 1 and left the session to walk forward.
			await expect(page.getByTestId('typing-surface')).toContainText(long.contents[index]);
			await expect(typingInput(page)).toBeFocused();

			// And it cost no extra request: the tail of the book fits in the window that opened.
			expect(requests).toEqual([]);

			// Typing it is not blocked either — the passage is genuinely loaded, not a placeholder.
			await typePassage(page, long.contents[index]);
			await expect(meta(page)).toContainText(`Passage ${passage + 1} of ${long.chunkCount}`);
		});
	});

	test.describe('running out of window (spec §8)', () => {
		/**
		 * The window fetch fails and nothing else does. Deliberately narrower than
		 * `context.setOffline`: a guest has no write path to interfere, so failing exactly the
		 * one request under test leaves no doubt about which failure produced the state.
		 */
		async function failTheWindow(page: Page): Promise<void> {
			await page.route(CHUNKS_ROUTE, (route: Route) => route.abort('failed'));
		}

		/** Type a guest to the end of the SSR window, with the next window unreachable. */
		async function typeToTheEndOfTheWindow(page: Page): Promise<void> {
			await openBook(page, long);
			await typePassages(page, long, 0, WINDOW_SIZE - 1);
		}

		test('shows the end-of-window state, distinct from the finished-book summary', async ({
			page
		}) => {
			test.setTimeout(120_000);
			await failTheWindow(page);
			await typeToTheEndOfTheWindow(page);

			// The session says it ran out, and says WHICH of the two stopped states this is.
			await expect(awaitingPanel(page)).toBeVisible();
			await expect(awaitingPanel(page)).toHaveAttribute('data-state', 'stalled');
			await expect(page.getByTestId('passage-awaiting-hint')).toBeVisible();

			// Distinct from finishing the book: none of the summary exists.
			await expect(page.getByTestId('session-summary')).toHaveCount(0);
			await expect(page.getByTestId('summary-wpm')).toHaveCount(0);
			await expect(page.getByTestId('summary-restart-session')).toHaveCount(0);

			// And it is a pause, not an ending: the surface is still mounted and still focused,
			// so the moment the window lands the user types on without touching anything.
			await expect(page.getByTestId('typing-surface')).toBeVisible();
			await expect(typingInput(page)).toBeFocused();
		});

		test('clears itself once connectivity returns — no reload, no click', async ({ page }) => {
			test.setTimeout(120_000);
			await failTheWindow(page);
			await typeToTheEndOfTheWindow(page);
			await expect(awaitingPanel(page)).toHaveAttribute('data-state', 'stalled');

			// Connectivity comes back: the route works again and the browser says so. Nothing
			// else happens — no navigation, no keystroke, no button.
			//
			// Taking the interceptor down is NOT atomic with the page. `unrouteAll` tears it down
			// over the browser protocol, so an `online` dispatched in the same breath can still be
			// answered by the dying handler — and the component swallows a failed window fetch by
			// design (a mid-passage error must never reach the reader), leaving `inFlight` null
			// with no trigger left to retry it. The panel then stays up forever and the test reads
			// as "the product does not recover" when in fact the test never restored the network.
			//
			// `behavior: 'wait'` drains handlers already running; re-signalling until the state
			// clears covers the rest. That is faithful rather than lenient: a real reconnect means
			// the network is genuinely back, which is precisely what is being simulated here, and
			// the assertion still admits no reload, no click and no keystroke.
			await page.unrouteAll({ behavior: 'wait' });
			await expect(async () => {
				await page.evaluate(() => window.dispatchEvent(new Event('online')));
				await expect(awaitingPanel(page)).toHaveCount(0, { timeout: 2_000 });
			}).toPass();
			await expect(meta(page)).toContainText(`Passage ${WINDOW_SIZE + 1} of ${long.chunkCount}`);
			await expect(typingInput(page)).toBeFocused();

			// The recovered passage is real text, typeable straight away.
			await typePassage(page, long.contents[WINDOW_SIZE]);
			await expect(meta(page)).toContainText(`Passage ${WINDOW_SIZE + 2} of ${long.chunkCount}`);
		});

		/**
		 * The 2c regression guard, made real (spec #15 §3/§4, restated by #18 §8): running out
		 * of TEXT must never cost a completed PASSAGE. Every passage typed on the way to the end
		 * of the window is buffered while the network is gone, and drains when it returns.
		 *
		 * The first passage is completed while ONLINE on purpose. `progress-buffer.e2e.ts` owns
		 * the cold-import case and documents why it cannot recover in the same document: a
		 * failed dynamic import is cached as a failure for the life of the page, so a session
		 * that never loaded the write path has none to drain with. This test is about the other
		 * half — a session that was working and then lost the network — so it proves the write
		 * path was live (a real row) before taking the network away.
		 */
		test('completions typed before running out are buffered and drain on reconnect', async ({
			page,
			context,
			mintUser,
			session
		}) => {
			test.setTimeout(180_000);
			const user = await mintUser();
			await session.signInAs(user);

			const attempts = async () => {
				const { data, error } = await user.client
					.from('chunk_attempts')
					.select('chunk_id, user_id, completed')
					.eq('book_id', long.id);
				expect(error, `reading chunk_attempts failed: ${error?.message}`).toBeNull();
				return data ?? [];
			};

			await openBook(page, long);

			// One passage online: a persisted row is proof the lazy write path is loaded, which
			// is what makes the reconnect drain below a test of the buffer rather than of the
			// module map.
			await typePassage(page, long.contents[0]);
			await expect.poll(attempts, { message: 'the first passage should persist' }).toHaveLength(1);

			await context.setOffline(true);
			// The rest of the window: nine completions with nowhere to go, and then the end of
			// the text this device holds.
			await typePassages(page, long, 1, WINDOW_SIZE - 1);
			await expect(awaitingPanel(page)).toHaveAttribute('data-state', 'stalled');

			// Pending, not lost — and attributed to the user who typed them, not guest-authored:
			// they held a session, only the write failed.
			await expect.poll(() => readBuffer(page)).toHaveLength(WINDOW_SIZE - 1);
			const buffered = await readBuffer(page);
			expect(buffered.map((entry) => entry.userId)).toEqual(
				Array.from({ length: WINDOW_SIZE - 1 }, () => user.id)
			);
			expect(buffered.map((entry) => entry.chunkId)).toEqual(long.chunkIds.slice(1, WINDOW_SIZE));
			expect(buffered.every((entry) => entry.completed)).toBe(true);
			// Nothing reached the database while the network was gone.
			expect(await attempts()).toHaveLength(1);

			await context.setOffline(false);

			// Both halves of the reconnect, from the one event: the backlog drains…
			await expect
				.poll(attempts, { message: 'the buffered passages should drain on reconnect' })
				.toHaveLength(WINDOW_SIZE);
			await expect.poll(() => readBuffer(page)).toEqual([]);
			// …and the session that had run out of text picks up where it stopped.
			await expect(awaitingPanel(page)).toHaveCount(0);
			await expect(meta(page)).toContainText(`Passage ${WINDOW_SIZE + 1} of ${long.chunkCount}`);
		});

		/**
		 * `awaiting` discounts from the cumulative WPM (CONTEXT.md, Session; ADR-0004) — proved
		 * with a real gap in `awaiting`, not an inserted row. Spec #26, gap G4.
		 *
		 * The engine stamps every keystroke and every window event with `Date.now()` read live
		 * in the page (`TypingSession.svelte`), so the gap is produced with Playwright's clock
		 * (`page.clock`) rather than a real sleep: the browser's own `Date.now()` genuinely
		 * advances by several simulated minutes while the window request sits held open on a
		 * promise this test controls, and nothing in the test waits on wall-clock time to do it.
		 * Held-request gate, not `route.abort` — this is "the next window is merely slow", the
		 * same shape `windowed-reading.e2e.ts`'s prefetch test above already uses, reused here
		 * for a stall that reaches all the way to `awaiting` instead of resolving before it.
		 */
		test('a long stall in awaiting does not decay the cumulative WPM once typing resumes', async ({
			page
		}) => {
			test.setTimeout(120_000);
			await page.clock.install();

			let release: () => void = () => {};
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			await page.route(CHUNKS_ROUTE, async (route: Route) => {
				await held;
				await route.continue();
			});

			await openBook(page, long);
			await typePassages(page, long, 0, WINDOW_SIZE - 1, HUMAN_ISH_DELAY_MS);
			// Not `stalled`: the request is genuinely in flight, only held open — the state a
			// merely-slow network produces, distinct from the failure the sibling tests probe.
			await expect(awaitingPanel(page)).toHaveAttribute('data-state', 'loading');

			// Five simulated minutes of dead time the delivery layer owes, not the typist — with
			// zero real wall-clock time spent waiting for it.
			await page.clock.fastForward('05:00');

			release();
			await expect(awaitingPanel(page)).toHaveCount(0);
			await typePassage(page, long.contents[WINDOW_SIZE], HUMAN_ISH_DELAY_MS);
			await expect(meta(page)).toContainText(`Passage ${WINDOW_SIZE + 2} of ${long.chunkCount}`);

			const metaText = (await meta(page).textContent()) ?? '';
			const match = metaText.match(/(\d+)\s*wpm/);
			expect(match, `meta line should report a live wpm figure: "${metaText}"`).not.toBeNull();
			const wpm = Number(match![1]);

			// A plausibility bound, not an exact figure (CI jitter): every keystroke here was
			// typed at HUMAN_ISH_DELAY_MS, comfortably under 400 wpm and comfortably over a
			// crawl. If the five simulated minutes in `awaiting` had leaked into the elapsed
			// denominator, ~11 passages of real typing spread over five-plus minutes would read
			// as a single-digit wpm — this bound rules that failure mode out with headroom while
			// still admitting normal Playwright/CI timing variance on the typing side.
			expect(wpm, `cumulative wpm should reflect typing time only, got ${wpm}`).toBeGreaterThan(20);
			expect(wpm).toBeLessThan(1000);
		});
	});

	test.describe('a book shorter than one window', () => {
		/**
		 * The 3a fixture book exists for exactly this (spec #17 §9, #18 §9): it is shorter than
		 * a window, so it must complete end to end without ever asking for a second one and
		 * without ever entering `awaiting`. `shouldPrefetch`'s `loadedEnd < chunkCount` guard is
		 * what makes that true, and this is the end-to-end statement of it.
		 */
		test('completes end to end, never entering awaiting and never asking for a window', async ({
			page
		}) => {
			test.setTimeout(180_000);
			const requests = await recordWindowRequests(page);

			await openBook(page, { slug: tortoiseAndHare.id, chunkCount: tortoiseAndHare.chunkCount });
			await watchForAwaiting(page);

			for (const [index, chunk] of tortoiseAndHare.chunks.entries()) {
				await expect(meta(page)).toContainText(
					`Passage ${index + 1} of ${tortoiseAndHare.chunkCount}`
				);
				await typePassage(page, chunk.content);
			}

			// The book ends in the summary — the OTHER stopped state, and the one this book can
			// actually reach.
			const summary = page.getByTestId('session-summary');
			await expect(summary).toBeVisible();
			await expect(page.getByTestId('summary-chunks')).toHaveText(`${tortoiseAndHare.chunkCount}`);

			expect(await awaitingSightings(page), 'a book shorter than a window never waits').toBe(0);
			expect(requests, 'a book shorter than a window never asks for one').toEqual([]);
		});
	});

	test.describe('the SSR payload', () => {
		test('a full-length book ships under 50 KB of data, not the whole book', async ({ page }) => {
			const response = await page.request.get(`/type/${payload.slug}`);
			expect(response.status()).toBe(200);
			const data = ssrDataPayload(await response.text());
			const bytes = Buffer.byteLength(data, 'utf8');

			// Non-vacuous by construction: the book's own text is far past the bound, so under a
			// whole-book load this assertion fails rather than passing on a small fixture.
			const wholeBookBytes = payload.contents.reduce(
				(total, chunk) => total + Buffer.byteLength(chunk, 'utf8'),
				0
			);
			expect(
				wholeBookBytes,
				'the probe book must be big enough for this bound to mean something'
			).toBeGreaterThan(50 * 1024);

			expect(bytes, `SSR data payload was ${bytes} bytes`).toBeLessThan(50 * 1024);

			// And it is under the bound because only ONE WINDOW was serialised, not because the
			// text happened to compress: the last chunk of the window is in the payload and the
			// first chunk beyond it is not.
			expect(data).toContain(`Passage ${WINDOW_SIZE - 1} of the payload probe.`);
			expect(data).not.toContain(`Passage ${WINDOW_SIZE} of the payload probe.`);
		});
	});

	test.describe('the landing hero', () => {
		/**
		 * The hero reads `books.featured` (spec #18 §7, §10). Nothing in the seeded catalog
		 * carries the flag and the ingestion manifest sets it on neither book, so the hero has
		 * no book to render until something features one — this test features a SEEDED book for
		 * its duration and unfeatures it afterwards, so what the hero types is real content
		 * rather than probe filler.
		 */
		test.beforeAll(async () => {
			await setFeatured(service, prideAndPrejudiceExcerpt.id, true);
		});

		test.afterAll(async () => {
			await setFeatured(service, prideAndPrejudiceExcerpt.id, false);
		});

		test("renders the featured book's first chunk and responds to the first keystroke", async ({
			page
		}) => {
			const firstChunk = prideAndPrejudiceExcerpt.chunks[0].content;
			await page.goto('/');

			await expect(page.getByTestId('landing-hero')).toBeVisible();
			// The FEATURED book's first chunk, not the alphabetically-first book's: the hero is a
			// curated fact now, and this is the assertion that fails if it goes back to an
			// accident of the catalog.
			await expect(page.getByTestId('typing-surface')).toContainText(firstChunk.slice(0, 60));

			// Already focused, and live on the first keystroke — the hero explains the product by
			// being the product.
			await expect(typingInput(page)).toBeFocused();
			const chars = page.locator('[data-testid="typing-surface"] .char');
			await expect(async () => {
				await page.keyboard.type(firstChunk.slice(0, 2), { delay: 0 });
				await expect(chars.nth(0)).toHaveAttribute('data-state', 'correct', { timeout: 1000 });
			}).toPass();
			await expect(chars.nth(1)).toHaveAttribute('data-state', 'correct');
		});
	});

	/**
	 * Phase 8. Keyboard operability is not a checkbox in a typing app — it is the product —
	 * and the `awaiting` state is the one moment the app asks the user to wait, which is
	 * exactly where a focus bug would strand somebody who cannot see the screen.
	 */
	test.describe('accessibility (phase 8)', () => {
		/**
		 * Critical and serious axe violations only. Those are the gate; `moderate` and `minor`
		 * findings are reported by the run's output but do not fail it, because axe's moderate
		 * band is dominated by advisory landmark/heading-order rules whose "fix" would be to
		 * restructure a page around the tool rather than around the reader.
		 *
		 * No rule carve-outs (spec #25 §1, closes #21): `--muted` used to fail WCAG AA contrast
		 * in the two light palettes and was excluded here by rule name while #21 was open. The
		 * palette pass re-derived every foreground token to clear 4.5:1 against both `bg` and
		 * `sheet` on all four palettes (`src/lib/theme/theme.spec.ts`'s `WCAG AA contrast`
		 * block is the automated gate for that), so `color-contrast` runs like every other rule
		 * here now — nothing excluded.
		 */
		async function seriousViolations(page: Page) {
			const results = await new AxeBuilder({ page }).analyze();
			return results.violations
				.filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
				.map((violation) => `${violation.impact}: ${violation.id} — ${violation.help}`);
		}

		test('the typing screen has no serious violations while active, awaiting, or finished', async ({
			page
		}) => {
			test.setTimeout(180_000);

			// ── active ────────────────────────────────────────────────────────────────────────
			await page.route(CHUNKS_ROUTE, (route: Route) => route.abort('failed'));
			await openBook(page, long);
			await typePassage(page, long.contents[0].slice(0, 5));
			expect(await seriousViolations(page), 'axe: typing screen, active').toEqual([]);

			// ── awaiting ──────────────────────────────────────────────────────────────────────
			await page.keyboard.type(long.contents[0].slice(5), { delay: 0 });
			await typePassages(page, long, 1, WINDOW_SIZE - 1);
			await expect(awaitingPanel(page)).toHaveAttribute('data-state', 'stalled');
			expect(await seriousViolations(page), 'axe: typing screen, awaiting').toEqual([]);

			// ── finished ──────────────────────────────────────────────────────────────────────
			await page.unroute(CHUNKS_ROUTE);
			await openBook(page, {
				slug: tortoiseAndHare.id,
				chunkCount: tortoiseAndHare.chunkCount
			});
			for (const chunk of tortoiseAndHare.chunks) {
				await typePassage(page, chunk.content);
			}
			await expect(page.getByTestId('session-summary')).toBeVisible();
			expect(await seriousViolations(page), 'axe: typing screen, finished').toEqual([]);
		});

		test('the landing hero has no serious violations', async ({ page }) => {
			await setFeatured(service, prideAndPrejudiceExcerpt.id, true);
			try {
				await page.goto('/');
				await expect(page.getByTestId('landing-hero')).toBeVisible();
				expect(await seriousViolations(page), 'axe: landing hero').toEqual([]);
			} finally {
				await setFeatured(service, prideAndPrejudiceExcerpt.id, false);
			}
		});

		/**
		 * The 2c trap, restated by spec #18 §8: a live region inserted into the DOM in the same
		 * mutation as its content is never announced — the screen reader had nothing registered
		 * to watch when the text arrived.
		 *
		 * So presence is not the assertion. NODE IDENTITY is: the element holding the message
		 * must be the very same element that was already there, empty, before there was
		 * anything to say. A `{#if}` around this region would keep every presence assertion
		 * green and reproduce exactly the silence it exists to prevent.
		 */
		test('the end-of-window message lands in a live region that was already there', async ({
			page
		}) => {
			test.setTimeout(120_000);
			await page.route(CHUNKS_ROUTE, (route: Route) => route.abort('failed'));
			await openBook(page, long);

			const region = page.getByTestId('window-status');
			// Present from the first paint, correctly typed as a polite status, and saying
			// nothing — the three properties that make an announcement possible later.
			await expect(region).toHaveAttribute('role', 'status');
			await expect(region).toHaveAttribute('aria-live', 'polite');
			await expect(region).toHaveText('');

			// Remember the actual node, not a selector.
			await page.evaluate(() => {
				(window as unknown as { __region: Element | null }).__region = document.querySelector(
					'[data-testid="window-status"]'
				);
			});

			await typePassages(page, long, 0, WINDOW_SIZE - 1);
			await expect(awaitingPanel(page)).toHaveAttribute('data-state', 'stalled');
			await expect(region).not.toHaveText('');

			expect(
				await page.evaluate(
					() =>
						(window as unknown as { __region: Element | null }).__region ===
						document.querySelector('[data-testid="window-status"]')
				),
				'the live region must be the same node it was before the message existed'
			).toBe(true);

			// One region, not one per state: a second copy would announce twice or not at all.
			await expect(region).toHaveCount(1);
		});

		test('awaiting neither moves nor traps focus', async ({ page }) => {
			test.setTimeout(120_000);
			await page.route(CHUNKS_ROUTE, (route: Route) => route.abort('failed'));
			await openBook(page, long);
			await typePassages(page, long, 0, WINDOW_SIZE - 1);

			// Entering `awaiting` moved nothing: the hidden input still holds focus, so a user
			// who cannot see the panel is not stranded on `<body>` waiting for a cue.
			await expect(awaitingPanel(page)).toHaveAttribute('data-state', 'stalled');
			await expect(typingInput(page)).toBeFocused();

			// Nor is focus trapped there: Tab leaves for the ordinary page controls and
			// Shift+Tab comes back, exactly as it would while typing.
			await page.keyboard.press('Tab');
			await expect(typingInput(page)).not.toBeFocused();
			const escaped = await page.evaluate(
				() => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName
			);
			expect(escaped, 'Tab should reach a real control, not the body').toBeTruthy();
			expect(escaped).not.toBe('BODY');

			await page.keyboard.press('Shift+Tab');
			await expect(typingInput(page)).toBeFocused();

			// The panel itself takes no focus at all — it is a statement, not a dialog.
			await expect(awaitingPanel(page)).not.toBeFocused();
		});

		test('the whole flow is keyboard-only, including across a window boundary', async ({
			page
		}) => {
			test.setTimeout(180_000);
			await page.goto('/type');
			await expect(page.getByTestId('text-picker')).toBeVisible();

			// Tab from page load until focus lands on the probe book's card. Bounded, like
			// `typing.e2e.ts`'s walk: the header carries theme, language and auth controls first.
			const cardTestId = `text-picker-option-${long.slug}`;
			let reached = false;
			for (let i = 0; i < 30 && !reached; i += 1) {
				await page.keyboard.press('Tab');
				reached =
					(await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? '')) ===
					cardTestId;
			}
			expect(reached, `Tab should reach ${cardTestId} within 30 stops`).toBe(true);

			// Enter starts the session once hydrated — no pointer has been used, and none will be.
			await expect(async () => {
				await page.keyboard.press('Enter');
				await expect(page.getByTestId('typing-surface')).toBeVisible({ timeout: 2000 });
			}).toPass();
			await expect(typingInput(page)).toBeFocused();
			await watchForAwaiting(page);

			// Across the boundary, keyboard only, including a mistake and its correction — the
			// path a real typist takes.
			await typePassages(page, long, 0, WINDOW_SIZE - 1);
			await expect(meta(page)).toContainText(`Passage ${WINDOW_SIZE + 1} of ${long.chunkCount}`);
			await page.keyboard.type('x', { delay: 0 });
			await page.keyboard.press('Backspace');
			await typePassage(page, long.contents[WINDOW_SIZE]);
			await expect(meta(page)).toContainText(`Passage ${WINDOW_SIZE + 2} of ${long.chunkCount}`);
			await expect(typingInput(page)).toBeFocused();
		});
	});
});
