import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { guestTest, type AuthUser } from './fixtures/auth';
import { isLocalStack } from './support/supabase';
import { gridCard } from './support/library';
import { prideAndPrejudiceExcerpt } from '../src/lib/fixtures/en';
import { tortoiseAndHare } from '../src/lib/fixtures/tortoise';

/**
 * Mode as the measurement axis (spec #24 §§10-12): the cookie is read SERVER-side, the
 * toggle owns the axis from mount on, and a session with any Zen time in it produces a
 * summary with two tiles instead of four.
 *
 * What only a browser can prove — and therefore what lives here rather than in Vitest:
 *
 * - **First paint.** `mode.spec.ts` proves the cookie parses and `page.server.spec.ts`
 *   proves the load returns it; neither can see the HTML that leaves the server. The §10
 *   criterion is about a document that arrives ALREADY in Zen and does not change under
 *   hydration, so the assertions below read the raw server response and then watch the DOM
 *   through hydration with a MutationObserver installed before the app's own scripts run.
 * - **Durability.** A cookie surviving a reload and a client-side navigation is a browser
 *   fact, not a module fact.
 * - **Keyboard operability** of the toggle, and the a11y pass over both modes (phase 8).
 *
 * The short book is used wherever a whole session is needed: three passages, ~1.3k
 * characters, all inside one window, so the summary is reachable without an `awaiting`
 * detour and without the four-minute budget the ES book needs.
 */

const EN_ID = prideAndPrejudiceExcerpt.id;
const SHORT_ID = tortoiseAndHare.id;
const MODE_COOKIE = 'typefy-mode';

/** The single meta line under the sheet: "Passage N of M · pct% [· wpm · accuracy]". */
function meta(page: Page) {
	return page.getByTestId('passage-meta');
}

function zenToggle(page: Page) {
	return page.getByTestId('zen-toggle');
}

async function type(page: Page, text: string) {
	await page.keyboard.type(text, { delay: 0 });
}

/** Put the mode cookie on the context, exactly as the client-side toggle would write it. */
async function setModeCookie(page: Page, baseURL: string, value: string) {
	await page.context().addCookies([{ name: MODE_COOKIE, value, url: baseURL }]);
}

/**
 * Opens a book and waits until it is typeable. Same retry shape as `typing.e2e.ts` —
 * the picker click only registers once the page has hydrated.
 */
async function openBook(page: Page, slug: string) {
	await page.goto(`/type/${slug}`);
	await expect(page.getByTestId('typing-surface')).toBeVisible();
	await expect(page.getByTestId('typing-input')).toBeFocused();
}

/**
 * The HTML the SERVER produced, fetched through the browser context so it carries the
 * same cookies the page would send. No JavaScript runs on it: whatever is asserted here
 * is what the user's first paint shows.
 */
async function serverHtml(page: Page, path: string): Promise<string> {
	const response = await page.context().request.get(path);
	expect(response.ok(), `GET ${path} → ${response.status()}`).toBe(true);
	return response.text();
}

/** The rendered text of the meta line inside a raw HTML document. */
function metaFromHtml(html: string): string {
	const match = html.match(/data-testid="passage-meta"[^>]*>([\s\S]*?)<\/p>/);
	expect(match, 'the server HTML contains no passage-meta line').not.toBeNull();
	// SSR interleaves hydration markers (`<!--[-->`) with the text; strip markup and
	// entities so the assertion reads what a person would see.
	return match![1]
		.replace(/<[^>]*>/g, '')
		.replace(/&middot;|&#183;/g, '·')
		.trim();
}

/** The Zen toggle's opening tag inside a raw HTML document. */
function zenToggleTagFromHtml(html: string): string {
	const match = html.match(/<button[^>]*data-testid="zen-toggle"[^>]*>/);
	expect(match, 'the server HTML contains no zen-toggle button').not.toBeNull();
	return match![0];
}

/**
 * Record the meta line's text on every DOM mutation, starting before the app's own
 * scripts run. This is what turns "does not change after hydration" into an assertion:
 * a server-rendered Zen line that hydration replaces with a metric-bearing one would be
 * invisible to any settled-DOM check, because the app settles back into Zen either way.
 */
async function recordMetaThroughHydration(page: Page) {
	await page.addInitScript(() => {
		const seen: string[] = [];
		(window as unknown as { __metaTexts: string[] }).__metaTexts = seen;
		const record = () => {
			const element = document.querySelector('[data-testid="passage-meta"]');
			if (element) seen.push(element.textContent ?? '');
		};
		// `document` always exists at init-script time; `documentElement` does not.
		new MutationObserver(record).observe(document, {
			subtree: true,
			childList: true,
			characterData: true
		});
	});
}

function recordedMetaTexts(page: Page): Promise<string[]> {
	return page.evaluate(() => (window as unknown as { __metaTexts: string[] }).__metaTexts ?? []);
}

test.describe('the mode cookie is read server-side', () => {
	test('a Zen cookie reaches the first paint, and hydration never flashes the metrics', async ({
		page,
		baseURL
	}) => {
		await setModeCookie(page, baseURL!, 'zen');

		// ── first paint: the document the server sent ──────────────────────────────────────
		const html = await serverHtml(page, `/type/${EN_ID}`);
		expect(metaFromHtml(html), 'the server-rendered meta line').toBe('Passage 1 of 6 · 0%');
		expect(zenToggleTagFromHtml(html)).toContain('aria-pressed="true"');

		// ── hydration: every intermediate state, not just the settled one ──────────────────
		await recordMetaThroughHydration(page);
		await openBook(page, EN_ID);
		await expect(meta(page)).toHaveText('Passage 1 of 6 · 0%');

		const texts = await recordedMetaTexts(page);
		expect(texts.length, 'the observer recorded nothing at all').toBeGreaterThan(0);
		expect(
			texts.filter((text) => /wpm|accuracy/.test(text)),
			'the metrics must never appear, not even for one frame'
		).toEqual([]);

		// Typing does not resurrect them: in Zen nothing is derived at all, so crossing a
		// word boundary — the event that flips the figures to numbers in Normal — is quiet.
		await type(page, 'It is ');
		await expect(meta(page)).toHaveText('Passage 1 of 6 · 0%');
		expect((await recordedMetaTexts(page)).filter((text) => /wpm|accuracy/.test(text))).toEqual([]);
	});

	test('no cookie means normal', async ({ page, baseURL }) => {
		// Explicitly: no mode cookie at all on this context.
		const before = await page.context().cookies(baseURL!);
		expect(before.filter((cookie) => cookie.name === MODE_COOKIE)).toEqual([]);

		const html = await serverHtml(page, `/type/${EN_ID}`);
		expect(metaFromHtml(html)).toContain('— wpm');
		expect(zenToggleTagFromHtml(html)).toContain('aria-pressed="false"');

		await openBook(page, EN_ID);
		await expect(meta(page)).toContainText('— wpm');
		await expect(zenToggle(page)).toHaveAttribute('aria-pressed', 'false');
	});

	test('an unrecognised cookie value falls back to normal rather than breaking the page', async ({
		page,
		baseURL
	}) => {
		// A hand-edited or stale cookie must still open the book (`parseMode` returns null
		// and the load's `?? 'normal'` supplies the default).
		await setModeCookie(page, baseURL!, 'zen-page');

		const html = await serverHtml(page, `/type/${EN_ID}`);
		expect(metaFromHtml(html)).toContain('— wpm');
		expect(zenToggleTagFromHtml(html)).toContain('aria-pressed="false"');
	});
});

test.describe('the choice is durable', () => {
	test('the toggle writes the cookie; the mode survives a reload and a navigation to another book', async ({
		page,
		baseURL
	}) => {
		await openBook(page, EN_ID);
		await expect(meta(page)).toContainText('wpm');

		await zenToggle(page).click();
		await expect(zenToggle(page)).toHaveAttribute('aria-pressed', 'true');
		await expect(meta(page)).not.toContainText('wpm');

		const cookies = await page.context().cookies(baseURL!);
		expect(cookies.find((cookie) => cookie.name === MODE_COOKIE)?.value).toBe('zen');

		// A reload arrives already in Zen — the server, not the client, decided that.
		await page.reload();
		expect(metaFromHtml(await serverHtml(page, `/type/${EN_ID}`))).toBe('Passage 1 of 6 · 0%');
		await expect(zenToggle(page)).toHaveAttribute('aria-pressed', 'true');
		await expect(meta(page)).not.toContainText('wpm');

		// And a CLIENT-side navigation to another book too: `/type/[slug]`'s load re-runs
		// over the fetch, reads the same cookie, and the `{#key}` remounts the session in it.
		await page.getByTestId('pick-another').click();
		await expect(page.getByTestId('text-picker')).toBeVisible();
		await expect(async () => {
			await page.getByTestId(`text-picker-option-${SHORT_ID}`).click();
			await expect(page.getByTestId('typing-surface')).toBeVisible({ timeout: 2000 });
		}).toPass();
		await expect(zenToggle(page)).toHaveAttribute('aria-pressed', 'true');
		await expect(meta(page)).toHaveText(`Passage 1 of ${tortoiseAndHare.chunkCount} · 0%`);

		// Leaving Zen is equally durable, and equally server-visible.
		await zenToggle(page).click();
		await expect(zenToggle(page)).toHaveAttribute('aria-pressed', 'false');
		await page.reload();
		expect(metaFromHtml(await serverHtml(page, `/type/${SHORT_ID}`))).toContain('— wpm');
		await expect(meta(page)).toContainText('— wpm');
	});

	/**
	 * §10: guests and signed-in users behave identically — no profile column, no
	 * cookie-vs-profile precedence rule. `guestTest` is the fixture that can be both in one
	 * browser: it does NOT override `storageState`, so the test opens as a guest and
	 * acquires a session partway through, on the same context and the same cookie jar.
	 */
	guestTest(
		'a guest and a signed-in user get identical mode behaviour',
		async ({ page, baseURL, mintUser, session }) => {
			guestTest.skip(!isLocalStack, 'throwaway users are only created against a local stack');

			// ── as a guest ────────────────────────────────────────────────────────────────
			await openBook(page, EN_ID);
			await zenToggle(page).click();
			await expect(zenToggle(page)).toHaveAttribute('aria-pressed', 'true');
			const guestMeta = await meta(page).textContent();
			const guestServerMeta = metaFromHtml(await serverHtml(page, `/type/${EN_ID}`));

			// ── the same browser, now signed in ───────────────────────────────────────────
			// `signInAs` clears every cookie first, so the mode cookie is re-set afterwards:
			// the claim under test is that the SAME cookie produces the SAME behaviour for
			// both audiences, not that a session survives being wiped.
			await session.signInAs(await mintUser());
			await setModeCookie(page, baseURL!, 'zen');
			await openBook(page, EN_ID);

			expect(metaFromHtml(await serverHtml(page, `/type/${EN_ID}`))).toBe(guestServerMeta);
			await expect(zenToggle(page)).toHaveAttribute('aria-pressed', 'true');
			expect(await meta(page).textContent()).toBe(guestMeta);
			await expect(meta(page)).not.toContainText('wpm');

			// And the toggle still owns the axis for a signed-in user.
			await zenToggle(page).click();
			await expect(zenToggle(page)).toHaveAttribute('aria-pressed', 'false');
			await expect(meta(page)).toContainText('wpm');
			expect(metaFromHtml(await serverHtml(page, `/type/${EN_ID}`))).toContain('— wpm');
		}
	);
});

/**
 * The seam nothing else covers: from a real keystroke to a real row.
 *
 * `client.spec.ts` proves the write path builds the right payload against a mocked
 * `SupabaseClient`, and `progress.e2e.ts` proves the trigger's rules against rows inserted
 * by hand. Neither proves the two meet — that a passage actually TYPED in Zen, through the
 * browser, by a signed-in user, arrives in `chunk_attempts` as `mode='zen'` with NULL
 * metrics. A payload that matched the mock and was refused by the column grant would pass
 * both of those suites and lose every Zen completion in production.
 *
 * `guestTest` rather than the `test` fixture: this file also runs guest specs, and the
 * authenticated fixture overrides `storageState` for every test in its file.
 */
test.describe('what a typed passage writes', () => {
	/**
	 * The one row this user has, with everything spec #24 added to it.
	 *
	 * Polled rather than read once. The completing keystroke and the insert are not the same
	 * turn — `recordChunkAttempt` is dispatched from the completion, goes through a dynamic
	 * `import()` of the Supabase client, and only then reaches the network — so a read taken
	 * the instant the passage counter advances can legitimately arrive first. Polling a
	 * CONDITION (the row exists) rather than sleeping keeps that deterministic; a fresh
	 * throwaway user per test is what makes "exactly one" the right condition to poll for.
	 */
	async function readAttempt(user: { client: AuthUser['client'] }) {
		const select = async () => {
			const { data, error } = await user.client
				.from('chunk_attempts')
				.select(
					'mode, gross_wpm, accuracy_raw, elapsed_ms, measured_ms, measured_chars, completed'
				);
			expect(error, `attempt read failed: ${error?.message}`).toBeNull();
			return data ?? [];
		};
		let row: Awaited<ReturnType<typeof select>>[number] | undefined;
		await expect(async () => {
			const rows = await select();
			expect(rows, 'the completion should have written exactly one attempt row').toHaveLength(1);
			row = rows[0];
		}).toPass({ timeout: 15_000 });
		return row!;
	}

	guestTest(
		'a passage typed wholly in Zen is written with mode zen and no figures at all',
		async ({ page, baseURL, mintUser, session }) => {
			guestTest.skip(!isLocalStack, 'throwaway users are only created against a local stack');
			guestTest.setTimeout(120_000);

			const user = await mintUser();
			await session.signInAs(user);
			await setModeCookie(page, baseURL!, 'zen');

			await openBook(page, SHORT_ID);
			await expect(zenToggle(page)).toHaveAttribute('aria-pressed', 'true');
			await type(page, tortoiseAndHare.chunks[0].content);
			await expect(meta(page)).toContainText(`Passage 2 of ${tortoiseAndHare.chunkCount}`);

			const row = await readAttempt(user);
			expect(row.completed).toBe(true);
			expect(row.mode).toBe('zen');
			// The whole point of the axis: nothing was measured, so nothing is recorded.
			expect(row.gross_wpm).toBeNull();
			expect(row.accuracy_raw).toBeNull();
			expect(row.measured_chars).toBe(0);
			expect(row.measured_ms).toBe(0);
			// §5's invariant, on a row the app itself wrote rather than one a test composed.
			expect(row.measured_ms).toBeLessThanOrEqual(row.elapsed_ms);
			// And it is still a real traversal: the wall clock ran.
			expect(row.elapsed_ms).toBeGreaterThan(0);
		}
	);

	/**
	 * "Zen progress is progress" (CONTEXT.md, Zen mode), proved through the UI rather than only
	 * at the row — spec #26, gap G3. The test above already pins that the completion writes
	 * `mode='zen'` with no figures; what it does not touch is whether that write actually moves
	 * the two things a reader cares about: the book's completion percentage on its library card,
	 * and where the NEXT visit resumes. A rollup trigger that folded a Zen completion into
	 * `book_progress.chunks_completed` but a resume function that silently required `gross_wpm`
	 * to be non-null would pass every test above and still strand a Zen reader on the same
	 * passage forever.
	 */
	guestTest(
		'Zen progress is progress: the library card and the next visit both reflect a Zen completion',
		async ({ page, baseURL, mintUser, session }) => {
			guestTest.skip(!isLocalStack, 'throwaway users are only created against a local stack');
			guestTest.setTimeout(120_000);

			const user = await mintUser();
			await session.signInAs(user);
			await setModeCookie(page, baseURL!, 'zen');

			await openBook(page, SHORT_ID);
			await expect(zenToggle(page)).toHaveAttribute('aria-pressed', 'true');
			await type(page, tortoiseAndHare.chunks[0].content);
			await expect(meta(page)).toContainText(`Passage 2 of ${tortoiseAndHare.chunkCount}`);

			// Wait for the write to actually land — the library card reads the persisted
			// rollup, not the session's own optimistic state, so this must be a real row.
			// `SHORT_ID` is the book's SLUG (what the route and TypeableTextSummary use), not
			// its `chunk_attempts.book_id` uuid, so — like `readAttempt` above — this is scoped
			// by the fresh throwaway user rather than by book: a user this test just minted has
			// exactly one attempt row no matter which book it is against.
			await expect(async () => {
				const { data, error } = await user.client.from('chunk_attempts').select('completed');
				expect(error, `attempt read failed: ${error?.message}`).toBeNull();
				expect(data).toHaveLength(1);
			}).toPass({ timeout: 15_000 });

			// The library card: book-lifetime completion, incremented by a Zen completion
			// exactly like a Normal one (CONTEXT.md, Progress/sync).
			const percent = Math.round((100 * 1) / tortoiseAndHare.chunkCount);
			await page.goto('/type?lang=all');
			await expect(gridCard(page, SHORT_ID)).toContainText(`${percent}%`);

			// The next visit: resume is past the Zen-completed passage, not back at passage 1.
			await page.goto(`/type/${SHORT_ID}`);
			await expect(meta(page)).toContainText(`Passage 2 of ${tortoiseAndHare.chunkCount}`);
			await expect(meta(page)).toContainText(`${percent}%`);
		}
	);

	guestTest(
		'a passage typed wholly in Normal is written with figures and measured_ms = elapsed_ms',
		async ({ page, mintUser, session }) => {
			guestTest.skip(!isLocalStack, 'throwaway users are only created against a local stack');
			guestTest.setTimeout(120_000);

			const user = await mintUser();
			await session.signInAs(user);

			await openBook(page, SHORT_ID);
			await expect(zenToggle(page)).toHaveAttribute('aria-pressed', 'false');
			await type(page, tortoiseAndHare.chunks[0].content);
			await expect(meta(page)).toContainText(`Passage 2 of ${tortoiseAndHare.chunkCount}`);

			const row = await readAttempt(user);
			expect(row.completed).toBe(true);
			expect(row.mode).toBe('normal');
			expect(Number(row.gross_wpm)).toBeGreaterThan(0);
			expect(Number(row.accuracy_raw)).toBeGreaterThan(0);
			// Equal exactly when the whole traversal was Normal (§5) — the regression guard
			// for a span accounting that starts discounting time it should not.
			expect(row.measured_ms).toBe(row.elapsed_ms);
			expect(row.measured_chars).toBe(tortoiseAndHare.chunks[0].charCount);
		}
	);

	guestTest(
		'a passage with a mid-way switch keeps its measured span but files no figures',
		async ({ page, mintUser, session }) => {
			guestTest.skip(!isLocalStack, 'throwaway users are only created against a local stack');
			guestTest.setTimeout(120_000);

			const user = await mintUser();
			await session.signInAs(user);

			const passage = tortoiseAndHare.chunks[0].content;
			await openBook(page, SHORT_ID);
			// Half in Normal, then the rest in Zen: a persisted row requires a WHOLE clean
			// traversal (§4), so this one carries no figures however much of it was measured.
			await type(page, passage.slice(0, 200));
			await zenToggle(page).click();
			await expect(zenToggle(page)).toHaveAttribute('aria-pressed', 'true');
			await type(page, passage.slice(200));
			await expect(meta(page)).toContainText(`Passage 2 of ${tortoiseAndHare.chunkCount}`);

			const row = await readAttempt(user);
			expect(row.completed).toBe(true);
			expect(row.mode).toBe('zen');
			expect(row.gross_wpm).toBeNull();
			expect(row.accuracy_raw).toBeNull();
			// But the span it DID measure is still on the row — that is what §5 exists for.
			expect(row.measured_chars).toBe(200);
			expect(row.measured_ms).toBeGreaterThan(0);
			expect(row.measured_ms).toBeLessThanOrEqual(row.elapsed_ms);
		}
	);
});

test.describe('the toggle', () => {
	test('is reachable and operable by keyboard alone, and exposes its state via aria-pressed', async ({
		page
	}) => {
		await openBook(page, EN_ID);
		await expect(zenToggle(page)).toHaveAttribute('aria-pressed', 'false');

		// Tab from the typing input until focus lands on the toggle (bounded walk — the
		// same shape `typing.e2e.ts` uses for the library cards).
		async function tabToToggle() {
			for (let i = 0; i < 20; i++) {
				await page.keyboard.press('Tab');
				const testId = await page.evaluate(
					() => document.activeElement?.getAttribute('data-testid') ?? ''
				);
				if (testId === 'zen-toggle') return true;
			}
			return false;
		}

		expect(await tabToToggle(), 'Tab should reach the Zen toggle within 20 stops').toBe(true);
		await expect(zenToggle(page)).toBeFocused();

		// Space activates it — a real <button>, so the native activation behaviour is the
		// assertion, not a keydown handler of our own.
		await page.keyboard.press('Space');
		await expect(zenToggle(page)).toHaveAttribute('aria-pressed', 'true');
		await expect(meta(page)).not.toContainText('wpm');

		// Toggling chrome must never strand focus: it returns to the input, so the next
		// keystroke types instead of re-activating the button.
		await expect(page.getByTestId('typing-input')).toBeFocused();
		await type(page, 'It');
		await expect(page.locator('[data-testid="typing-surface"] .char').nth(0)).toHaveAttribute(
			'data-state',
			'correct'
		);

		// Enter works too, and returns to Normal.
		expect(await tabToToggle(), 'Tab should reach the Zen toggle again').toBe(true);
		await page.keyboard.press('Enter');
		await expect(zenToggle(page)).toHaveAttribute('aria-pressed', 'false');
		await expect(meta(page)).toContainText('wpm');
		await expect(page.getByTestId('typing-input')).toBeFocused();
	});
});

test.describe('the session summary', () => {
	/** Types every passage of the short book, optionally switching mode partway. */
	async function readShortBook(page: Page, toggleBeforePassage: number | null) {
		for (const [index, chunk] of tortoiseAndHare.chunks.entries()) {
			await expect(meta(page)).toContainText(
				`Passage ${index + 1} of ${tortoiseAndHare.chunkCount}`
			);
			if (index === toggleBeforePassage) {
				await zenToggle(page).click();
				await expect(zenToggle(page)).toHaveAttribute('aria-pressed', 'true');
				await expect(page.getByTestId('typing-input')).toBeFocused();
			}
			await type(page, chunk.content);
		}
	}

	test('after ANY Zen time the WPM and accuracy tiles are absent — and everything else is not', async ({
		page
	}) => {
		test.setTimeout(180_000);

		// The strongest reading of "any Zen time": the session STARTS measured, so the
		// engine has real figures in hand, and gives them up the moment Zen is entered.
		await openBook(page, SHORT_ID);
		await readShortBook(page, 1);

		const summary = page.getByTestId('session-summary');
		await expect(summary).toBeVisible();
		await expect(summary).toBeFocused();

		// ABSENT, not empty: a tile that advertises the number Zen refused is worse than no
		// tile (§11). `toHaveCount(0)` is the assertion that distinguishes the two —
		// `not.toContainText` would pass just as happily on an em-dash placeholder.
		await expect(page.getByTestId('summary-wpm')).toHaveCount(0);
		await expect(page.getByTestId('summary-accuracy')).toHaveCount(0);
		await expect(summary).not.toContainText('Average speed');
		await expect(summary).not.toContainText('Accuracy');

		// Everything §11 says must still be there.
		await expect(summary).toContainText(`You read ${tortoiseAndHare.chunkCount} passages.`);
		await expect(page.getByTestId('summary-chunks')).toHaveText(String(tortoiseAndHare.chunkCount));
		await expect(page.getByTestId('summary-time')).toContainText(/\d{2}:\d{2}/);
		await expect(page.getByTestId('summary-time')).not.toContainText('00:00');
		await expect(page.getByTestId('summary-zen-note')).toBeVisible();
		await expect(page.getByTestId('summary-sign-in-prompt')).toBeVisible();
		await expect(page.getByTestId('summary-restart-session')).toBeVisible();
		await expect(page.getByTestId('summary-pick-another')).toBeVisible();

		// The actions still work, and the restart carries the mode over — it is a
		// cookie-backed preference, not session state.
		await page.getByTestId('summary-restart-session').click();
		await expect(meta(page)).toHaveText(`Passage 1 of ${tortoiseAndHare.chunkCount} · 0%`);
		await expect(zenToggle(page)).toHaveAttribute('aria-pressed', 'true');
		await expect(page.getByTestId('typing-input')).toBeFocused();
	});

	test('a fully-Normal session is unchanged: all four tiles, no Zen note', async ({ page }) => {
		test.setTimeout(180_000);

		await openBook(page, SHORT_ID);
		await expect(zenToggle(page)).toHaveAttribute('aria-pressed', 'false');
		await readShortBook(page, null);

		const summary = page.getByTestId('session-summary');
		await expect(summary).toBeVisible();
		await expect(page.getByTestId('summary-wpm')).toContainText(/^[1-9]\d*/);
		await expect(page.getByTestId('summary-accuracy')).toHaveText('100%');
		await expect(page.getByTestId('summary-chunks')).toHaveText(String(tortoiseAndHare.chunkCount));
		await expect(page.getByTestId('summary-time')).toContainText(/\d{2}:\d{2}/);
		await expect(page.getByTestId('summary-zen-note')).toHaveCount(0);
		await expect(page.getByTestId('summary-sign-in-prompt')).toBeVisible();
	});

	test('a session typed entirely in Zen reports its passages and no figures', async ({
		page,
		baseURL
	}) => {
		test.setTimeout(180_000);

		// Opened in Zen from the cookie, so not one keystroke of this session was measured.
		await setModeCookie(page, baseURL!, 'zen');
		await openBook(page, SHORT_ID);
		await expect(zenToggle(page)).toHaveAttribute('aria-pressed', 'true');
		await readShortBook(page, null);

		await expect(page.getByTestId('session-summary')).toBeVisible();
		await expect(page.getByTestId('summary-wpm')).toHaveCount(0);
		await expect(page.getByTestId('summary-accuracy')).toHaveCount(0);
		await expect(page.getByTestId('summary-chunks')).toHaveText(String(tortoiseAndHare.chunkCount));
		await expect(page.getByTestId('summary-zen-note')).toBeVisible();
	});
});

/**
 * Phase 8. Keyboard operability is not a checkbox in a typing app — it is the product — and
 * mode adds a control that changes what the chrome says while the user is mid-passage.
 */
test.describe('accessibility (phase 8)', () => {
	/**
	 * Critical and serious violations only. No rule carve-outs (spec #25 §1, closes #21):
	 * `--muted` used to fail WCAG AA contrast in the two light palettes and was excluded here
	 * by rule name while #21 was open. The palette pass re-derived every foreground token to
	 * clear 4.5:1 against both `bg` and `sheet` on all four palettes
	 * (`src/lib/theme/theme.spec.ts`'s `WCAG AA contrast` block is the automated gate for
	 * that), so `color-contrast` runs like every other rule here now.
	 */
	async function seriousViolations(page: Page) {
		const results = await new AxeBuilder({ page }).analyze();
		return results.violations
			.filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
			.map((violation) => `${violation.impact}: ${violation.id} — ${violation.help}`);
	}

	test('the typing screen has no serious violations in either mode, nor does a Zen summary', async ({
		page
	}) => {
		test.setTimeout(180_000);

		// ── Normal ────────────────────────────────────────────────────────────────────────
		await openBook(page, SHORT_ID);
		await type(page, tortoiseAndHare.chunks[0].content.slice(0, 12));
		expect(await seriousViolations(page), 'axe: typing screen, normal').toEqual([]);

		// ── Zen ───────────────────────────────────────────────────────────────────────────
		await zenToggle(page).click();
		await expect(zenToggle(page)).toHaveAttribute('aria-pressed', 'true');
		expect(await seriousViolations(page), 'axe: typing screen, zen').toEqual([]);

		// ── the Zen summary, whose tile count differs from every other summary ────────────
		for (const [index, chunk] of tortoiseAndHare.chunks.entries()) {
			await type(page, index === 0 ? chunk.content.slice(12) : chunk.content);
		}
		await expect(page.getByTestId('session-summary')).toBeVisible();
		expect(await seriousViolations(page), 'axe: session summary, zen').toEqual([]);
	});

	/**
	 * The whole flow with the mouse unplugged: open a book from the library, switch mode,
	 * type, switch back. The failure this guards against is not a missing attribute but a
	 * stranded focus — a toggle that moves focus to `<body>` ends the session for anyone
	 * navigating by keyboard, and no axe rule would report it.
	 */
	test('the typing flow is fully keyboard-operable and the mode switch never strands focus', async ({
		page
	}) => {
		await page.goto('/type');
		await expect(page.getByTestId('text-picker')).toBeVisible();

		// 30, not 20: spec #25 §2 added the sort control and the search form ahead of the grid
		// (language filter, sort pills, search input + submit — 8 stops), on top of the header
		// chrome (palette, font, language switcher, nav, auth — ~12 stops). 20 was correct
		// before that control group existed; the budget still bounds the walk, it just accounts
		// for the controls the spec deliberately put there.
		let reached = false;
		for (let i = 0; i < 30 && !reached; i++) {
			await page.keyboard.press('Tab');
			const testId = await page.evaluate(
				() => document.activeElement?.getAttribute('data-testid') ?? ''
			);
			reached = testId.startsWith('text-picker-option-');
		}
		expect(reached, 'Tab should reach a book card within 30 stops').toBe(true);

		await expect(async () => {
			await page.keyboard.press('Enter');
			await expect(page.getByTestId('typing-surface')).toBeVisible({ timeout: 2000 });
		}).toPass();
		await expect(page.getByTestId('typing-input')).toBeFocused();

		/** Where focus is right now, as a test id — '' would mean it fell to `<body>`. */
		const focusedTestId = () =>
			page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? '');

		async function tabTo(testId: string) {
			for (let i = 0; i < 20; i++) {
				await page.keyboard.press('Tab');
				if ((await focusedTestId()) === testId) return true;
			}
			return false;
		}

		expect(await tabTo('zen-toggle')).toBe(true);
		await page.keyboard.press('Enter');
		await expect(zenToggle(page)).toHaveAttribute('aria-pressed', 'true');
		expect(await focusedTestId(), 'focus must not fall to <body> on a mode switch').toBe(
			'typing-input'
		);

		// Typing continues immediately, in Zen, with no pointer involved anywhere. The text
		// is read off the surface rather than assumed: this test arrives at whichever book
		// the first card happens to be, and a hardcoded opening would pin the catalog's
		// ordering to a focus test that has no opinion about it.
		const opening = (
			(await page.locator('[data-testid="typing-surface"] .passage').textContent()) ?? ''
		).slice(0, 6);
		expect(opening.length, 'the surface rendered no text to type').toBe(6);
		await type(page, opening);
		await expect(page.locator('[data-testid="typing-surface"] .char').nth(5)).toHaveAttribute(
			'data-state',
			'correct'
		);

		// Restarting the passage from the keyboard, then leaving Zen: still no stranding.
		await page.keyboard.press('Escape');
		await expect(page.locator('[data-testid="typing-surface"] .char').nth(0)).toHaveAttribute(
			'data-state',
			'pending'
		);
		expect(await tabTo('zen-toggle')).toBe(true);
		await page.keyboard.press('Enter');
		await expect(zenToggle(page)).toHaveAttribute('aria-pressed', 'false');
		expect(await focusedTestId()).toBe('typing-input');
		await expect(meta(page)).toContainText('wpm');
	});
});
