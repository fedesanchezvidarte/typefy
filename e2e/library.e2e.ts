import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, guestTest, test } from './fixtures/auth';
import {
	isLocalStack,
	localSecretKey,
	secretClient,
	SUPABASE_URL,
	type AnyClient
} from './support/supabase';
import { arrangeProbeBook, retireProbeBook, type ProbeBook } from './support/probe-books';
import { gridCard, sectionCard } from './support/library';
import { prideAndPrejudiceExcerpt } from '../src/lib/fixtures/en';
import { donQuijoteExcerpt } from '../src/lib/fixtures/es';
import { tortoiseAndHare } from '../src/lib/fixtures/tortoise';

/**
 * Spec #19 §4 (language filter) and §5 (continue reading), and spec #25 §2 (catalog search and
 * sort), end to end.
 *
 * The pure filter/search/sort rules (`parseLanguageFilter`, `DEFAULT_LANGUAGE_FILTER`,
 * `parseSearchQuery`, `matchesSearch`, `parseBookSort`, `sortBooks`, `libraryHref`) and the pure
 * selection rule (`selectContinueReading`) already have unit coverage under `src/lib/`; nothing
 * here re-litigates them. What only a real browser can prove is that the URL, the server load
 * and the rendered library actually agree: the default resolves from the UI locale, an
 * unrecognised value fails open rather than 400ing, the active option is keyboard-reachable and
 * exposed to assistive tech, a signed-in user's in-progress books appear (or do not) exactly
 * where §5 says they should, and — the new §2 surface — that all three controls (`?lang`, `?q`,
 * `?sort`) compose without ever silently dropping one another, that search results are already
 * correct in the document the SERVER sends (no post-hydration flash), and that back/forward
 * restores the whole state together.
 *
 * The three seeded fixtures are exactly what local `db:reset` provides — the shelf holding 12
 * books is a production fact, not a local-stack one — so every search/sort assertion below is
 * built against these three, not against a round number from the spec's prose.
 */

const EN_ID = prideAndPrejudiceExcerpt.id; // "Pride and Prejudice (excerpt)", Jane Austen, en, 6 chunks
const ES_ID = donQuijoteExcerpt.id; // "Don Quijote de la Mancha (fragmento)", Miguel de Cervantes, es, 5 chunks
const SHORT_ID = tortoiseAndHare.id; // "The Tortoise and the Hare", Aesop, en, 3 chunks

function filterOption(page: Page, value: 'en' | 'es' | 'all') {
	return page.getByTestId(`library-language-filter-${value}`);
}

function sortOption(page: Page, value: 'default' | 'title' | 'length') {
	return page.getByTestId(`library-sort-${value}`);
}

/**
 * Retried, not a plain `page.goto`: on a local `npm run dev` server (not CI, which builds and
 * serves a production preview) the very first request for a route Vite has not compiled yet
 * can abort the navigation instead of completing it — a dev-server cold-start artefact, not
 * app behaviour. `toPass` gives that first compile somewhere to land without flaking the
 * assertion that actually matters.
 */
async function gotoLibrary(page: Page, path: string) {
	await expect(async () => {
		await page.goto(path);
		await expect(page.getByTestId('text-picker')).toBeVisible({ timeout: 2000 });
	}).toPass();
}

/**
 * The grid's book slugs in DOM order — what `sortBooks` actually produced, as rendered, not as
 * asserted against in isolation by `sort.spec.ts`.
 */
async function gridOrder(page: Page): Promise<string[]> {
	const cards = page.getByTestId('text-picker').locator('[data-testid^="text-picker-option-"]');
	const ids: string[] = [];
	for (let i = 0; i < (await cards.count()); i += 1) {
		ids.push((await cards.nth(i).getAttribute('data-testid'))!.replace('text-picker-option-', ''));
	}
	return ids;
}

/**
 * Fills and submits the search form, retried.
 *
 * On the local `npm run dev` server the SSR'd markup (including this input, already carrying
 * its server-resolved value) paints well before hydration attaches — Vite serves the app as
 * ~40 unbundled modules there. A `.fill()` landing inside that window sets the DOM value, but
 * the moment hydration claims the node it re-applies `value={query ?? ''}` from props and the
 * typed text is silently gone by the time `submit` is clicked — not a `libraryHref`/search bug,
 * a pre-hydration race the same shape `smoke.e2e.ts` and `typing.e2e.ts` already retry around
 * for their own hydration-dependent interactions. Retrying the whole fill+submit+assert unit
 * means a first attempt lost to the race simply tries again once hydration has settled.
 */
async function submitSearch(page: Page, query: string) {
	await expect(async () => {
		await page.getByTestId('library-search-input').fill(query);
		await page.getByTestId('library-search-submit').click();
		await expect(page).toHaveURL(new RegExp(`q=${query}`), { timeout: 2000 });
	}).toPass();
}

/**
 * The HTML the SERVER produced, fetched through the browser context so it carries the same
 * cookies/locale the page would. No JavaScript runs on it: whatever is asserted here is what
 * the user's first paint shows — the thing that makes "no post-hydration flash" a checkable
 * claim rather than an assumption about timing.
 */
async function serverHtml(page: Page, path: string): Promise<string> {
	const response = await page.context().request.get(path);
	expect(response.ok(), `GET ${path} → ${response.status()}`).toBe(true);
	return response.text();
}

test.describe('language filter', () => {
	test('defaults to `all` at /type — the whole library, not the UI locale', async ({ page }) => {
		await gotoLibrary(page, '/type');
		await expect(filterOption(page, 'all')).toHaveAttribute('aria-current', 'page');
		await expect(filterOption(page, 'en')).not.toHaveAttribute('aria-current', 'page');
		await expect(page.getByTestId(`text-picker-option-${EN_ID}`)).toBeVisible();
		await expect(page.getByTestId(`text-picker-option-${SHORT_ID}`)).toBeVisible();
		await expect(page.getByTestId(`text-picker-option-${ES_ID}`)).toBeVisible();
	});

	test('defaults to `all` at /es/type too — the default is locale-independent', async ({
		page
	}) => {
		await gotoLibrary(page, '/es/type');
		await expect(filterOption(page, 'all')).toHaveAttribute('aria-current', 'page');
		await expect(filterOption(page, 'es')).not.toHaveAttribute('aria-current', 'page');
		await expect(page.getByTestId(`text-picker-option-${ES_ID}`)).toBeVisible();
		await expect(page.getByTestId(`text-picker-option-${EN_ID}`)).toBeVisible();
	});

	test('?lang=all shows every seeded language at once', async ({ page }) => {
		await page.goto('/type?lang=all');
		await expect(filterOption(page, 'all')).toHaveAttribute('aria-current', 'page');
		await expect(page.getByTestId(`text-picker-option-${EN_ID}`)).toBeVisible();
		await expect(page.getByTestId(`text-picker-option-${ES_ID}`)).toBeVisible();
		await expect(page.getByTestId(`text-picker-option-${SHORT_ID}`)).toBeVisible();
	});

	test('an unrecognised ?lang value falls back silently to the default, never a 400', async ({
		page
	}) => {
		const response = await page.goto('/type?lang=fr');
		expect(response?.status()).toBe(200);
		// Falls back to DEFAULT_LANGUAGE_FILTER ('all'), exactly as an unfiltered '/type' would.
		await expect(filterOption(page, 'all')).toHaveAttribute('aria-current', 'page');
		await expect(page.getByTestId(`text-picker-option-${EN_ID}`)).toBeVisible();
		await expect(page.getByTestId(`text-picker-option-${ES_ID}`)).toBeVisible();
	});

	test('the control is keyboard-operable and back/forward restores the previous filter', async ({
		page
	}) => {
		// Starts on the 'all' default, narrows to 'en' by keyboard, and comes back.
		await page.goto('/type');
		await filterOption(page, 'en').focus();
		await expect(filterOption(page, 'en')).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(page).toHaveURL(/\?lang=en/);
		await expect(filterOption(page, 'en')).toHaveAttribute('aria-current', 'page');
		await expect(page.getByTestId(`text-picker-option-${ES_ID}`)).not.toBeVisible();

		await page.goBack();
		await expect(page).not.toHaveURL(/\?lang=en/);
		await expect(filterOption(page, 'all')).toHaveAttribute('aria-current', 'page');
		await expect(page.getByTestId(`text-picker-option-${ES_ID}`)).toBeVisible();
	});

	test('the `en` pill names the language in the UI locale, not its own — exonym, not endonym (spec #39, mirrors #38)', async ({
		page
	}) => {
		// Under EN the exonym and LanguageSwitcher's endonym happen to coincide ("English"), so
		// this half alone couldn't have caught the regression — it's here for symmetry with the
		// ES assertion below, which is the one that actually proves it.
		await gotoLibrary(page, '/type');
		await expect(filterOption(page, 'en')).toContainText('English');

		// Under ES the two diverge: the content-language pill is chrome describing the book to
		// the reader, so it turns over with the UI locale even though the language it names does
		// not. It must read the exonym "Inglés", never the language-switcher's endonym
		// "English" — asserting the negative too, because rendering the endonym is exactly the
		// bug #39 fixed (same class of regression as GeneratedCover's badge, spec #38).
		await gotoLibrary(page, '/es/type');
		await expect(filterOption(page, 'en')).toContainText('Inglés');
		await expect(filterOption(page, 'en')).not.toContainText('English');
	});
});

test.describe('continue reading', () => {
	test('a guest sees no continue-reading section at all', async ({ page }) => {
		await page.goto('/type?lang=all');
		await expect(page.getByTestId('text-picker')).toBeVisible();
		await expect(page.getByTestId('continue-reading')).toHaveCount(0);
	});

	test('a signed-in user with no in-progress books sees no section either', async ({
		page,
		authUser
	}) => {
		test.skip(
			!isLocalStack,
			`refusing to create throwaway users against a non-local Supabase (${SUPABASE_URL})`
		);
		void authUser;
		await page.goto('/type?lang=all');
		await expect(page.getByTestId('text-picker')).toBeVisible();
		await expect(page.getByTestId('continue-reading')).toHaveCount(0);
	});

	test('an in-progress book appears in both the section and the grid, and the two cards do not collide', async ({
		page,
		authUser
	}) => {
		test.skip(
			!isLocalStack,
			`refusing to create throwaway users against a non-local Supabase (${SUPABASE_URL})`
		);
		const book = await authUser.completePassages(EN_ID, [0]);
		const percent = Math.round((100 * 1) / book.chunkCount);

		await page.goto('/type?lang=all');
		await expect(page.getByTestId('continue-reading')).toBeVisible();
		await expect(sectionCard(page, EN_ID)).toContainText(`${percent}%`);
		await expect(gridCard(page, EN_ID)).toContainText(`${percent}%`);
	});

	test('a fully completed book is excluded even though it has progress', async ({
		page,
		authUser
	}) => {
		test.skip(
			!isLocalStack,
			`refusing to create throwaway users against a non-local Supabase (${SUPABASE_URL})`
		);
		// The short fixture is 3 chunks — cheap to finish entirely.
		await authUser.completePassages(SHORT_ID, [0, 1, 2]);

		await page.goto('/type?lang=all');
		await expect(page.getByTestId('continue-reading')).toHaveCount(0);
		// Still in the grid, at 100% — completion is not the same as removal from the catalog.
		await expect(gridCard(page, SHORT_ID)).toContainText('100%');
	});

	test('at most 3 books show, most recently active first', async ({ page, authUser }) => {
		test.skip(
			!isLocalStack,
			`refusing to create throwaway users against a non-local Supabase (${SUPABASE_URL})`
		);
		// Sequential inserts (completePassages awaits each one) give each book a strictly
		// later `chunk_attempts.created_at`, which is what `last_active_at` is derived from —
		// so the arrival order below is also the expected display order, most recent first.
		await authUser.completePassages(EN_ID, [0]);
		await authUser.completePassages(ES_ID, [0]);
		await authUser.completePassages(SHORT_ID, [0]);

		await page.goto('/type?lang=all');
		const section = page.getByTestId('continue-reading');
		await expect(section).toBeVisible();
		const cards = section.locator('[data-testid^="text-picker-option-"]');
		await expect(cards).toHaveCount(3);
		await expect(cards.nth(0)).toHaveAttribute('data-testid', `text-picker-option-${SHORT_ID}`);
		await expect(cards.nth(1)).toHaveAttribute('data-testid', `text-picker-option-${ES_ID}`);
		await expect(cards.nth(2)).toHaveAttribute('data-testid', `text-picker-option-${EN_ID}`);
	});

	test('respects the active language filter, so the page never contradicts itself', async ({
		page,
		authUser
	}) => {
		test.skip(
			!isLocalStack,
			`refusing to create throwaway users against a non-local Supabase (${SUPABASE_URL})`
		);
		await authUser.completePassages(EN_ID, [0]);
		await authUser.completePassages(ES_ID, [0]);

		// 'en': only the EN book is offered to continue.
		await page.goto('/type?lang=en');
		await expect(sectionCard(page, EN_ID)).toBeVisible();
		await expect(
			page.getByTestId('continue-reading').getByTestId(`text-picker-option-${ES_ID}`)
		).toHaveCount(0);

		// 'es': only the ES book.
		await page.goto('/type?lang=es');
		await expect(sectionCard(page, ES_ID)).toBeVisible();
		await expect(
			page.getByTestId('continue-reading').getByTestId(`text-picker-option-${EN_ID}`)
		).toHaveCount(0);

		// 'all': both.
		await page.goto('/type?lang=all');
		await expect(sectionCard(page, EN_ID)).toBeVisible();
		await expect(sectionCard(page, ES_ID)).toBeVisible();
	});
});

/**
 * Cover fallback on load failure (CONTEXT.md, Cover: "A `cover_url` that fails to load
 * degrades to the generated cover... the database still holds the dead URL, which is an
 * operator problem, not a rendering one"). `typing.e2e.ts` already proves every SEEDED book
 * renders `generated-cover` because none of them carry supplied art at all; what it cannot
 * prove is the FALLBACK path — a book that DOES carry a `cover_url` whose image request fails.
 * Spec #26, gap G6.
 */
test.describe('cover fallback on load failure', () => {
	test.skip(
		!isLocalStack,
		`refusing to publish a probe book against a non-local Supabase (${SUPABASE_URL})`
	);
	test.skip(
		!localSecretKey(),
		'needs the local secret key: no client role may publish a book, and none should'
	);

	const SLUG = 'cover-fallback-probe';
	const DEAD_COVER_URL = 'https://example.invalid/covers/cover-fallback-probe.jpg';

	let service: AnyClient;
	let book: ProbeBook;

	test.beforeAll(async () => {
		service = secretClient()!;
		book = await arrangeProbeBook(service, {
			slug: SLUG,
			title: 'Cover fallback probe',
			author: 'probe',
			language: 'en',
			contents: ['Probe passage for the cover fallback test.'],
			coverUrl: DEAD_COVER_URL
		});
	});

	test.afterAll(async () => {
		await retireProbeBook(service, SLUG);
	});

	test('a cover_url whose image request fails falls back to the generated cover, not a broken image', async ({
		page
	}) => {
		await page.route(DEAD_COVER_URL, (route) => route.abort('failed'));

		await gotoLibrary(page, '/type?lang=all');
		const card = gridCard(page, book.slug);
		await expect(card).toBeVisible();

		// The generated cover takes over — present, not merely a lack of console noise — and
		// no broken-image box is left in its place.
		await expect(card.getByTestId('generated-cover')).toBeVisible();
		await expect(card.locator('img')).toHaveCount(0);
	});

	/**
	 * The same guarantee on the BOOK DETAIL SCREEN (spec #34).
	 *
	 * Spec #34 extracted the card's cover-with-fallback into `BookCover` precisely so the
	 * detail screen could not grow a second implementation that drifts out from under the
	 * test above. That argument is only worth anything if something actually exercises the
	 * second consumer: a shared component with one covered call site is indistinguishable
	 * from a duplicated one until the day it is edited.
	 *
	 * Deliberately in this file rather than in `book-detail.e2e.ts` — it is the same
	 * criterion, the same probe book and the same dead URL, and splitting the pair across two
	 * files is how one half quietly stops being maintained with the other.
	 */
	test('the same dead cover_url falls back to the generated cover on the book detail screen too', async ({
		page
	}) => {
		await page.route(DEAD_COVER_URL, (route) => route.abort('failed'));

		await page.goto(`/books/${book.slug}`);
		await expect(page.getByTestId('book-detail-start')).toBeVisible();

		// Scoped to `<main>`: the header carries no cover, but scoping states the claim as
		// "the screen's own cover", which is what the criterion is about.
		const main = page.getByRole('main');
		await expect(main.getByTestId('generated-cover')).toBeVisible();
		await expect(main.locator('img')).toHaveCount(0);
	});
});

guestTest.describe('continue reading issues no progress query for a guest', () => {
	guestTest('no book_progress request leaves the page when signed out', async ({ page }) => {
		const progressRequests: string[] = [];
		page.on('request', (request) => {
			if (request.url().includes('book_progress')) {
				progressRequests.push(`${request.method()} ${request.url()}`);
			}
		});

		await page.goto('/type?lang=all');
		await expect(page.getByTestId('text-picker')).toBeVisible();
		await page.waitForLoadState('networkidle');

		expect(progressRequests, 'a guest load must issue no book_progress request').toEqual([]);
	});
});

/**
 * Spec #25 §2: `?q` catalog search, server-resolved, matching title or author.
 */
test.describe('search', () => {
	test('matches title and author case-insensitively, resolved server-side with no post-hydration flash', async ({
		page
	}) => {
		// Read the raw response the SERVER sent — no JS has run on it — so a pass here proves
		// the filtering already happened in the load, not that the browser narrowed it after.
		const html = await serverHtml(page, '/type?lang=all&q=QUIJOTE');
		expect(html).toContain(`text-picker-option-${ES_ID}`);
		expect(html).not.toContain(`text-picker-option-${EN_ID}`);
		expect(html).not.toContain(`text-picker-option-${SHORT_ID}`);

		// Author, not just title, and mixed case.
		const byAuthor = await serverHtml(page, '/type?lang=all&q=austen');
		expect(byAuthor).toContain(`text-picker-option-${EN_ID}`);
		expect(byAuthor).not.toContain(`text-picker-option-${ES_ID}`);
	});

	test('matches accent-insensitively — a query carrying accents the source text does not still matches', async ({
		page
	}) => {
		// "Cervantes" itself carries no accent; the query adds one on each side deliberately, so
		// a pass here can only be explained by both sides folding through normalizeForSearch,
		// not by a lucky literal match.
		const html = await serverHtml(page, `/type?lang=all&q=${encodeURIComponent('Cérvantès')}`);
		expect(html).toContain(`text-picker-option-${ES_ID}`);
	});

	test('composes with ?lang= — narrows within the language rather than resetting it', async ({
		page
	}) => {
		await gotoLibrary(page, '/type?lang=es&q=quijote');
		await expect(gridCard(page, ES_ID)).toBeVisible();
		expect(await gridOrder(page)).toEqual([ES_ID]);
		await expect(filterOption(page, 'es')).toHaveAttribute('aria-current', 'page');
	});

	test('?lang= and ?q= never contradict — a language-appropriate query with no match in that language is the empty state, not the other language leaking in', async ({
		page
	}) => {
		// "tortoise" matches the EN-only fixture by title; under lang=es it must match nothing
		// rather than falling back to the unfiltered catalog.
		await page.goto('/type?lang=es&q=tortoise');
		await expect(page.getByTestId('library-empty-state')).toBeVisible();
		await expect(page.getByTestId('text-picker')).toHaveCount(0);
	});

	test('a whitespace-only q behaves as no search — the full list, not the empty state', async ({
		page
	}) => {
		await gotoLibrary(page, '/type?lang=all&q=%20%20%20');
		await expect(page.getByTestId('library-empty-state')).toHaveCount(0);
		await expect(gridCard(page, EN_ID)).toBeVisible();
		await expect(gridCard(page, ES_ID)).toBeVisible();
		await expect(gridCard(page, SHORT_ID)).toBeVisible();
	});

	test('a query matching nothing renders the empty state, not a blank grid, and its reset link clears only the search', async ({
		page
	}) => {
		await page.goto('/type?lang=all&q=frankenstein');
		await expect(page.getByTestId('text-picker')).toHaveCount(0);
		const empty = page.getByTestId('library-empty-state');
		await expect(empty).toBeVisible();
		await expect(empty).toContainText('frankenstein');

		await page.getByTestId('library-empty-reset').click();
		await expect(page).not.toHaveURL(/q=/);
		// The reset link only clears the search — it must not also silently drop lang=all.
		await expect(page).toHaveURL(/lang=all/);
		await expect(page.getByTestId('library-empty-state')).toHaveCount(0);
		await expect(gridCard(page, EN_ID)).toBeVisible();
		await expect(gridCard(page, ES_ID)).toBeVisible();
	});

	test('the search input is keyboard-operable: type and submit reach the same URL a click would', async ({
		page
	}) => {
		await gotoLibrary(page, '/type?lang=all');
		// Hydration-safe retry (see `submitSearch`'s comment): typed text landing before
		// hydration attaches is silently overwritten, so the whole type+submit+assert unit
		// retries rather than the keystrokes alone.
		await expect(async () => {
			await page.getByTestId('library-search-input').focus();
			await page.keyboard.press('Control+A');
			await page.keyboard.type('quijote');
			await page.keyboard.press('Enter');
			await expect(page).toHaveURL(/q=quijote/, { timeout: 2000 });
		}).toPass();
		await expect(gridCard(page, ES_ID)).toBeVisible();
	});
});

/**
 * Spec #25 §2: `?sort` catalog ordering, server-resolved, composing with filter and search.
 */
test.describe('sort', () => {
	test('?sort=title reorders the grid with locale-aware collation', async ({ page }) => {
		await gotoLibrary(page, '/type?lang=all&sort=title');
		// "Don Quijote…" < "Pride…" < "The Tortoise…"
		expect(await gridOrder(page)).toEqual([ES_ID, EN_ID, SHORT_ID]);
		await expect(sortOption(page, 'title')).toHaveAttribute('aria-current', 'page');
	});

	test('?sort=length reorders the grid ascending by chunk count', async ({ page }) => {
		await gotoLibrary(page, '/type?lang=all&sort=length');
		// tortoise (3) < don-quijote (5) < pride-and-prejudice (6)
		expect(await gridOrder(page)).toEqual([SHORT_ID, ES_ID, EN_ID]);
		await expect(sortOption(page, 'length')).toHaveAttribute('aria-current', 'page');
	});

	test('an unrecognised ?sort falls back silently to default, never an error page', async ({
		page
	}) => {
		const response = await page.goto('/type?lang=all&sort=bogus');
		expect(response?.status()).toBe(200);
		// Default: listBooks' own order (language, then title) — en before es.
		expect(await gridOrder(page)).toEqual([EN_ID, SHORT_ID, ES_ID]);
		await expect(sortOption(page, 'default')).toHaveAttribute('aria-current', 'page');
	});
});

/**
 * Spec #25 §2: the three controls compose — changing one never silently drops the other two —
 * and back/forward restores the whole state together, not just the URL of whichever control was
 * clicked last.
 */
test.describe('filter, search and sort compose', () => {
	test('changing the sort preserves an active search and language filter', async ({ page }) => {
		await gotoLibrary(page, '/type?lang=all&q=quijote');
		await expect(gridCard(page, ES_ID)).toBeVisible();

		await sortOption(page, 'title').click();
		await expect(page).toHaveURL(/\/type\?lang=all&sort=title&q=quijote$/);
		expect(await gridOrder(page)).toEqual([ES_ID]);
		await expect(filterOption(page, 'all')).toHaveAttribute('aria-current', 'page');
		await expect(page.getByTestId('library-search-input')).toHaveValue('quijote');
	});

	test('changing the language filter preserves an active search and sort', async ({ page }) => {
		await gotoLibrary(page, '/type?lang=all&sort=length&q=o');
		const before = await gridOrder(page);
		expect(before.length).toBeGreaterThan(1); // "o" matches more than one seeded title/author

		await filterOption(page, 'en').click();
		await expect(page).toHaveURL(/\/type\?lang=en&sort=length&q=o$/);
		await expect(sortOption(page, 'length')).toHaveAttribute('aria-current', 'page');
		await expect(page.getByTestId('library-search-input')).toHaveValue('o');
	});

	test('changing the search preserves the active language filter and sort', async ({ page }) => {
		await gotoLibrary(page, '/type?lang=all&sort=title');
		await submitSearch(page, 'don');
		// A GET form serialises fields in DOM order (q, then the hidden lang/sort) — unlike the
		// `libraryHref`-built links elsewhere, which are always lang, sort, q. Both orders carry
		// the same three values; only the link-click tests above can assert an exact order.
		await expect(page).toHaveURL(/\/type\?q=don&lang=all&sort=title$/);
		expect(await gridOrder(page)).toEqual([ES_ID]);
		await expect(sortOption(page, 'title')).toHaveAttribute('aria-current', 'page');
	});

	test('back/forward restores filter, search and sort together', async ({ page }) => {
		await gotoLibrary(page, '/type'); // state 0: default (all, sort=default, no query)

		await filterOption(page, 'all').click(); // state 1: lang=all, now explicit in the URL
		await expect(page).toHaveURL(/lang=all/);

		await sortOption(page, 'length').click(); // state 2: lang=all, sort=length
		await expect(page).toHaveURL(/sort=length/);
		expect(await gridOrder(page)).toEqual([SHORT_ID, ES_ID, EN_ID]);

		await submitSearch(page, 'don'); // state 3: + q=don
		expect(await gridOrder(page)).toEqual([ES_ID]);

		// One step back restores state 2: the filter and sort stay, the search is gone.
		//
		// The URL updates on `popstate` synchronously; the re-render from the load it triggers
		// does not. Waiting for a card the search had excluded to reappear is what turns "the
		// address bar changed" into "the page actually shows the restored state" before reading
		// the grid's order — and it is also why this test steps back/forward ONE state at a
		// time rather than queuing several history moves before asserting: a second navigation
		// fired before the first has settled races the load it triggered.
		await page.goBack();
		await expect(page).toHaveURL(/sort=length/);
		await expect(page).not.toHaveURL(/q=don/);
		await expect(gridCard(page, SHORT_ID)).toBeVisible();
		expect(await gridOrder(page)).toEqual([SHORT_ID, ES_ID, EN_ID]);

		// One step forward restores state 3: filter, sort AND search together.
		await page.goForward();
		await expect(page).toHaveURL(/q=don/);
		await expect(gridCard(page, ES_ID)).toBeVisible();
		await expect(gridCard(page, SHORT_ID)).toHaveCount(0);
		expect(await gridOrder(page)).toEqual([ES_ID]);
	});

	test('continue reading narrows with an active search, not just the language filter', async ({
		page,
		authUser
	}) => {
		test.skip(
			!isLocalStack,
			`refusing to create throwaway users against a non-local Supabase (${SUPABASE_URL})`
		);
		await authUser.completePassages(EN_ID, [0]);
		await authUser.completePassages(ES_ID, [0]);

		// Both have progress, but only EN_ID's title matches "pride".
		await page.goto('/type?lang=all&q=pride');
		await expect(sectionCard(page, EN_ID)).toBeVisible();
		await expect(
			page.getByTestId('continue-reading').getByTestId(`text-picker-option-${ES_ID}`)
		).toHaveCount(0);
	});
});

/**
 * Phase 8 (accessibility) for the library page's affordances (spec #19 §4/§5, spec #25 §2's
 * search/sort/empty-state). The typing screen itself is `windowed-reading.e2e.ts`'s to audit.
 *
 * Same gate as `windowed-reading.e2e.ts`'s a11y block, and — since spec #25 §1 closed #21 by
 * re-deriving every palette token to clear WCAG AA — no rule carve-outs anywhere: `color-contrast`
 * runs like every other axe rule here.
 */
test.describe('library accessibility (phase 8)', () => {
	async function seriousViolations(page: Page) {
		const results = await new AxeBuilder({ page }).analyze();
		return results.violations
			.filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
			.map((violation) => `${violation.impact}: ${violation.id} — ${violation.help}`);
	}

	test('the default filtered library has no serious violations', async ({ page }) => {
		await page.goto('/type');
		await expect(page.getByTestId('text-picker')).toBeVisible();
		expect(await seriousViolations(page), 'axe: /type, default filter').toEqual([]);
	});

	test('the unfiltered library and a signed-in continue-reading section have no serious violations', async ({
		page,
		authUser
	}) => {
		test.skip(
			!isLocalStack,
			`refusing to create throwaway users against a non-local Supabase (${SUPABASE_URL})`
		);
		await authUser.completePassages(EN_ID, [0]);

		await page.goto('/type?lang=all');
		await expect(page.getByTestId('continue-reading')).toBeVisible();
		expect(await seriousViolations(page), 'axe: /type?lang=all, signed in with progress').toEqual(
			[]
		);
	});

	test('the filter control is reachable in page tab order and its active option is announced, not just coloured', async ({
		page
	}) => {
		await page.goto('/type');
		const active = filterOption(page, 'all');
		// aria-current is the non-colour half of the signal (spec #19 §4): a link element with
		// this attribute exposes it to assistive tech through the accessible-name/state API by
		// definition (it is a standard ARIA state, not a custom data attribute), so asserting
		// the DOM attribute here is exactly what an AT would read. The axe pass above (which
		// runs `aria-valid-attr-value`) additionally proves it is not just present but valid.
		await expect(active).toHaveAttribute('aria-current', 'page');
		await expect(filterOption(page, 'es')).not.toHaveAttribute('aria-current', 'page');

		// Reachable by keyboard: Tab from the top of the page lands on it within a bounded walk.
		let reached = false;
		for (let i = 0; i < 20 && !reached; i += 1) {
			await page.keyboard.press('Tab');
			reached =
				(await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? '')) ===
				'library-language-filter-en';
		}
		expect(reached, 'Tab should reach the active filter option within 20 stops').toBe(true);
	});

	test('the sort control is reachable in page tab order and its active option is announced, not just coloured', async ({
		page
	}) => {
		await page.goto('/type?sort=length');
		const active = sortOption(page, 'length');
		// Same non-colour signal as the language filter (spec #25 §2): `aria-current="page"` is
		// a standard ARIA state, exposed to assistive tech independently of the filled-pill
		// styling that carries the same information visually.
		await expect(active).toHaveAttribute('aria-current', 'page');
		await expect(sortOption(page, 'title')).not.toHaveAttribute('aria-current', 'page');

		let reached = false;
		for (let i = 0; i < 20 && !reached; i += 1) {
			await page.keyboard.press('Tab');
			reached =
				(await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? '')) ===
				'library-sort-length';
		}
		expect(reached, 'Tab should reach the active sort option within 20 stops').toBe(true);
	});

	test('the three library controls sit in one sane tab order: language, then sort, then search', async ({
		page
	}) => {
		await page.goto('/type');

		/** Tabs forward until it lands on `testId`, or fails the walk is bounded so a control
		 *  moved out of order (or dropped from the tab sequence entirely) fails loudly rather
		 *  than hanging. */
		async function tabTo(testId: string, budget: number) {
			for (let i = 0; i < budget; i += 1) {
				await page.keyboard.press('Tab');
				const current = await page.evaluate(
					() => document.activeElement?.getAttribute('data-testid') ?? ''
				);
				if (current === testId) return true;
			}
			return false;
		}

		// Each step's budget only needs to cover the ground BETWEEN the previous control and
		// this one, so a sane order — not a specific absolute stop count — is what this proves.
		expect(await tabTo('library-language-filter-en', 25)).toBe(true);
		expect(await tabTo('library-sort-default', 5)).toBe(true);
		expect(await tabTo('library-search-input', 5)).toBe(true);
		expect(await tabTo('library-search-submit', 3)).toBe(true);
	});

	test("the search input's label is programmatically associated, not just visually adjacent", async ({
		page
	}) => {
		await page.goto('/type');
		// getByLabel resolves through the accessibility tree's label/control association
		// (here, <label for="library-search-input">) — it would find nothing for a label that
		// merely sits next to the input in the markup without the `for`/`id` pairing.
		const input = page.getByLabel(/search by title or author/i);
		await expect(input).toHaveAttribute('data-testid', 'library-search-input');
	});

	test('a book card keeps its accessible name once the grid is filtered, searched and sorted together', async ({
		page
	}) => {
		await gotoLibrary(page, '/type?lang=all&sort=title&q=quijote');
		// The card is a single <a> whose accessible name is its full text content (title,
		// author, passage count) — GeneratedCover's title/author spans are plain text inside
		// it, not hidden from assistive tech, so the accessible name still carries the title.
		const card = page.getByRole('link', { name: /Don Quijote de la Mancha/ });
		await expect(card).toBeVisible();
		await expect(card).toHaveAttribute('data-testid', `text-picker-option-${ES_ID}`);
	});
});
