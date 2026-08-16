import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { test as authTest } from './fixtures/auth';
import {
	isLocalStack,
	localSecretKey,
	secretClient,
	SUPABASE_URL,
	type AnyClient
} from './support/supabase';
import { arrangeProbeBook, retireProbeBook, type ProbeBook } from './support/probe-books';
import { expectPageIs } from './support/typing-screen';
import { chapterRow, gridCard, primaryAction, sectionCard, tabToTestId } from './support/library';

/**
 * The book detail screen (spec #34), end to end.
 *
 * `/books/[slug]` is a book's canonical page and the destination of every library entry point;
 * `/type/[slug]` is what it links into. What only a real browser can prove — and therefore
 * what lives here rather than in Vitest:
 *
 * - The **route** really 404s for an unknown slug and for an unpublished one, through RLS
 *   rather than through a predicate the load could get wrong.
 * - The **locale axis** actually reaches the rendered document: `/es/books/[slug]` shows the
 *   Spanish summary override, and every link off the screen stays localized.
 * - The **guest path** issues no progress query and renders no progress element, which is an
 *   acceptance criterion rather than an optimisation.
 * - The **page count agrees with the typing screen's**, which is a claim about two routes and
 *   cannot be made inside either one.
 * - **Chapter navigation** lands on the page containing a chapter's start, and completing a
 *   page inside a late chapter moves that chapter's count and nothing else — least of all the
 *   book's resume page.
 *
 * What is deliberately NOT re-tested here: the attribution arithmetic
 * (`src/lib/library/chapter-progress.spec.ts`), the malformed-summary matrix
 * (`src/lib/library/summary.spec.ts`), and the load's query shape
 * (`src/routes/books/[slug]/page.server.spec.ts`). Those are pure/mocked and already pinned;
 * duplicating them in a browser buys nothing and costs a minute a run.
 *
 * ## Why probe books rather than the seeded fixtures
 *
 * The published catalog on a local stack is the three excerpt fixtures, and they carry no
 * year, no summary and no chapters — they are excerpts with no Open Library work and no
 * derived structure. The real catalog books DO carry all three and are deliberately
 * UNPUBLISHED; publishing one is the user's call after final validation and explicitly not
 * something a test may do. So the metadata and chapter criteria arrange their own books
 * through the same `arrangeProbeBook` helper `windowed-reading.e2e.ts` already uses: fixed
 * slugs, published for the duration of the file, retired in `afterAll`.
 */

/** Fixed slugs, so a re-run reuses these rows instead of accumulating probes. */
const FULL_SLUG = 'book-detail-probe';
const BARE_SLUG = 'book-detail-bare-probe';
const UNPUBLISHED_SLUG = 'book-detail-unpublished-probe';
const UNKNOWN_SLUG = 'book-detail-no-such-book';

const EN_SUMMARY = 'An English blurb standing in for an Open Library description.';
const ES_SUMMARY = 'Un resumen en español escrito a mano en el manifiesto.';
const YEAR = 1851;

/**
 * Nine pages in three even chapters, so every boundary in the assertions is a different
 * number: chapter 2 starts at page 4 and chapter 3 at page 7, and "3" is never both a page
 * number and a count in the same assertion.
 */
const CHAPTERS = [
	{ index: 0, title: 'Chapter I. Loomings', startChunkIndex: 0 },
	{ index: 1, title: 'Chapter II. The Carpet-Bag', startChunkIndex: 3 },
	{ index: 2, title: 'Chapter III. The Spouter-Inn', startChunkIndex: 6 }
];

const PASSAGES = Array.from(
	{ length: 9 },
	(_, i) => `Passage number ${i + 1} of the book detail probe.`
);

test.describe('book detail screen', () => {
	test.skip(
		!isLocalStack,
		`refusing to publish a probe book against a non-local Supabase (${SUPABASE_URL})`
	);
	test.skip(
		!localSecretKey(),
		'needs the local secret key: no client role may publish a book, and none should'
	);

	let service: AnyClient;
	let full: ProbeBook;
	let bare: ProbeBook;

	test.beforeAll(async () => {
		service = secretClient()!;
		full = await arrangeProbeBook(service, {
			slug: FULL_SLUG,
			title: 'The Detail Probe',
			author: 'A. Probe',
			language: 'en',
			year: YEAR,
			// The raw per-locale map as `books.summary` holds it: `default` stands in for Open
			// Library's description (language unverified, which is why it is not under `en`),
			// and the `es` key is the manifest override that must win under the ES locale.
			summary: { default: EN_SUMMARY, es: ES_SUMMARY },
			contents: PASSAGES,
			chapters: CHAPTERS
		});
		// The legal "no structure" state (spec #33) plus a failed/absent Open Library lookup
		// (spec #34): no year, no summary, no chapters. All three absences on one book on
		// purpose — they are one screen's worth of "renders as complete anyway".
		bare = await arrangeProbeBook(service, {
			slug: BARE_SLUG,
			title: 'The Bare Probe',
			author: 'B. Probe',
			language: 'en',
			contents: ['Only passage of the bare probe.', 'Second passage of the bare probe.']
		});
		// Arranged and then immediately retired, so "unpublished" is a real row behind the
		// publication policy rather than a slug that never existed — which is exactly the
		// distinction the 404 criterion says must be invisible from outside.
		await arrangeProbeBook(service, {
			slug: UNPUBLISHED_SLUG,
			title: 'The Unpublished Probe',
			author: 'C. Probe',
			language: 'en',
			year: 1897,
			summary: { default: 'A summary nobody signed out may read.' },
			contents: ['Only passage of the unpublished probe.']
		});
		await retireProbeBook(service, UNPUBLISHED_SLUG);
	});

	test.afterAll(async () => {
		await retireProbeBook(service, FULL_SLUG);
		await retireProbeBook(service, BARE_SLUG);
		await retireProbeBook(service, UNPUBLISHED_SLUG);
	});

	/* ── rendering ──────────────────────────────────────────────────────────────────────── */

	test('renders the cover, title, author, year, our page count and the summary for a published book', async ({
		page
	}) => {
		await page.goto(`/books/${FULL_SLUG}`);
		const main = page.getByRole('main');

		// The title is the screen's h1, not merely text somewhere on it: a book's own page is
		// about that book, and that is what makes the heading order below meaningful.
		await expect(main.getByRole('heading', { level: 1 })).toHaveText('The Detail Probe');
		await expect(main).toContainText('A. Probe');

		// The cover renders at size. This probe carries no art, so it is the generated
		// typographic cover — the same component the card uses since spec #34.
		await expect(main.getByTestId('generated-cover')).toBeVisible();

		// Its badge is the ONLY place this screen states the book's content language, which is
		// why the a11y pass left the generated cover readable rather than `aria-hidden`. The
		// probe is an `en` book under the EN locale, so the exonym and the endonym coincide
		// here — the ES test below is the half that can actually fail. Uppercasing is CSS, so
		// the accessible text is the sentence-case message.
		await expect(main.getByTestId('generated-cover')).toContainText('English');

		// Values, not labels: the labels are translated, and a locator built on them would
		// only work in one locale.
		await expect(main.getByTestId('book-fact-year')).toHaveText(String(YEAR));
		await expect(main.getByTestId('book-fact-pages')).toHaveText(String(full.chunkCount));

		await expect(main.getByTestId('book-summary')).toContainText(EN_SUMMARY);
		// Under EN the `default` key is what resolves — the ES override must not leak across.
		await expect(main.getByTestId('book-summary')).not.toContainText(ES_SUMMARY);

		// The labels themselves, once, in English — this is the EN half of the EN/ES criterion.
		await expect(main.getByTestId('book-facts')).toContainText('First published');
		await expect(main.getByTestId('book-facts')).toContainText('Pages');
		await expect(primaryAction(page)).toHaveText('Start typing');
	});

	test('renders the same book under the ES locale, with the Spanish summary override winning over the Open Library default', async ({
		page
	}) => {
		await page.goto(`/es/books/${FULL_SLUG}`);
		const main = page.getByRole('main');

		// The book's own facts are locale-independent — the title, author and numbers are the
		// book, not the UI — so only the chrome around them changes.
		await expect(main.getByRole('heading', { level: 1 })).toHaveText('The Detail Probe');
		await expect(main.getByTestId('book-fact-year')).toHaveText(String(YEAR));
		await expect(main.getByTestId('book-fact-pages')).toHaveText(String(full.chunkCount));

		// The cover's content-language badge is chrome, so it turns over with the locale even
		// though the language it names does not: the book is still `en`, and under ES that
		// reads "INGLÉS" — not the endonym "English" the language switcher shows. Asserting
		// the negative too, because rendering the endonym is exactly the regression (A3).
		await expect(main.getByTestId('generated-cover')).toContainText('Inglés');
		await expect(main.getByTestId('generated-cover')).not.toContainText('English');

		await expect(main.getByTestId('book-facts')).toContainText('Primera publicación');
		await expect(main.getByTestId('book-facts')).toContainText('Páginas');
		await expect(primaryAction(page)).toHaveText('Empezar a escribir');
		await expect(main.getByTestId('chapter-list')).toContainText('Capítulos');

		// The whole point of the per-locale map: the SAME book shows Open Library's blurb
		// under EN (above) and the manifest's Spanish one here. The axis is the UI locale,
		// never the book's content language.
		await expect(main.getByTestId('book-summary')).toContainText(ES_SUMMARY);
		await expect(main.getByTestId('book-summary')).not.toContainText(EN_SUMMARY);

		// Every link off the screen stays inside the locale — a detail screen that dropped
		// the reader back into EN on the way to typing would undo the whole prefix.
		await expect(primaryAction(page)).toHaveAttribute('href', `/es/type/${FULL_SLUG}`);
		await expect(chapterRow(page, 1)).toHaveAttribute('href', `/es/type/${FULL_SLUG}?page=4`);
	});

	test('an unknown slug is a 404, and so is an unpublished book — indistinguishably', async ({
		page
	}) => {
		// Asserted on the RESPONSE STATUS, not on whatever the error page happens to say: the
		// criterion is that the route 404s, and an error page's copy is not that fact.
		const unknown = await page.goto(`/books/${UNKNOWN_SLUG}`);
		expect(unknown?.status(), `GET /books/${UNKNOWN_SLUG}`).toBe(404);

		const unpublished = await page.goto(`/books/${UNPUBLISHED_SLUG}`);
		expect(unpublished?.status(), `GET /books/${UNPUBLISHED_SLUG}`).toBe(404);

		// The unpublished book's own metadata must not leak through the error response — a
		// 404 that still ships the summary is a 404 in the status line only.
		expect(await unpublished!.text()).not.toContain('A summary nobody signed out may read.');

		// And the same under the localized prefix, so the collapse is not an EN-only accident.
		const localized = await page.goto(`/es/books/${UNPUBLISHED_SLUG}`);
		expect(localized?.status(), `GET /es/books/${UNPUBLISHED_SLUG}`).toBe(404);
	});

	test('the screen renders fully for a signed-out visitor, with no progress elements anywhere', async ({
		page
	}) => {
		// A guest costs exactly one query — no `book_progress`, no `chunk_progress`. The
		// absence is watched from before the navigation, so a request that fired and returned
		// cannot slip past a settled-DOM check.
		const progressRequests: string[] = [];
		page.on('request', (request) => {
			const url = request.url();
			if (url.includes('book_progress') || url.includes('chunk_progress')) {
				progressRequests.push(`${request.method()} ${url}`);
			}
		});

		await page.goto(`/books/${FULL_SLUG}`);
		const main = page.getByRole('main');

		// Everything that is not progress is still there: this is "complete signed out", not
		// "degraded signed out".
		await expect(main.getByRole('heading', { level: 1 })).toBeVisible();
		await expect(main.getByTestId('book-fact-pages')).toHaveText(String(full.chunkCount));
		await expect(main.getByTestId('book-summary')).toBeVisible();
		await expect(main.getByTestId('chapter-list')).toBeVisible();
		await expect(primaryAction(page)).toHaveText('Start typing');

		// The overall progress panel is absent ENTIRELY — not zeroed, not greyed.
		await expect(main.getByTestId('book-detail-progress')).toHaveCount(0);
		// And a chapter row shows its size, never "0 of 3 pages": a guest has no account to
		// fix that zero with.
		await expect(chapterRow(page, 0)).toContainText('3 pages');
		await expect(chapterRow(page, 0)).not.toContainText('0 of 3');

		await page.waitForLoadState('networkidle');
		expect(progressRequests, 'a guest must issue no progress query').toEqual([]);
	});

	test('a book with no summary and no chapters renders without an empty panel and without a chapter list', async ({
		page
	}) => {
		await page.goto(`/books/${BARE_SLUG}`);
		const main = page.getByRole('main');

		// The screen still reads as complete: cover, title, author, page count, primary action.
		await expect(main.getByRole('heading', { level: 1 })).toHaveText('The Bare Probe');
		await expect(main.getByTestId('book-fact-pages')).toHaveText(String(bare.chunkCount));
		await expect(primaryAction(page)).toBeVisible();

		// Omitted ENTIRELY — not an empty panel, not a "no summary available" line, and for
		// the year not an empty "First published —" row either.
		await expect(main.getByTestId('book-summary')).toHaveCount(0);
		await expect(main.getByTestId('book-fact-year')).toHaveCount(0);
		await expect(main.getByTestId('chapter-list')).toHaveCount(0);
	});

	test("the page count on the detail screen equals the typing screen's, and no other count appears", async ({
		page
	}) => {
		await page.goto(`/books/${FULL_SLUG}`);
		const shown = await page.getByTestId('book-fact-pages').textContent();

		await page.goto(`/type/${FULL_SLUG}`);
		// "Page 1 of N" — N is `books.chunk_count`, the same fact the detail screen showed.
		// Read from the meta line rather than asserted as a literal, so the two screens are
		// compared to EACH OTHER and a shared drift cannot pass.
		await expectPageIs(page, `1`, `${shown!.trim()}`);
		expect(shown!.trim()).toBe(String(full.chunkCount));
	});

	/* ── chapters ───────────────────────────────────────────────────────────────────────── */

	test('the chapter list shows each chapter title, its page range and its size', async ({
		page
	}) => {
		await page.goto(`/books/${FULL_SLUG}`);

		// Ranges are contiguous and 1-BASED: chapter i owns [start_i, start_{i+1}), rendered
		// as page numbers. Every boundary is asserted, because an off-by-one here is exactly
		// the failure the reader would discover only after typing the wrong passage.
		await expect(chapterRow(page, 0)).toContainText('Chapter I. Loomings');
		await expect(chapterRow(page, 0)).toContainText('Pages 1–3');
		await expect(chapterRow(page, 1)).toContainText('Chapter II. The Carpet-Bag');
		await expect(chapterRow(page, 1)).toContainText('Pages 4–6');
		await expect(chapterRow(page, 2)).toContainText('Chapter III. The Spouter-Inn');
		await expect(chapterRow(page, 2)).toContainText('Pages 7–9');

		// Exactly as many rows as chapters — a fourth row would mean the last chapter's range
		// ran past `chunk_count` and produced a phantom.
		await expect(page.getByTestId('chapter-list').getByRole('listitem')).toHaveCount(
			CHAPTERS.length
		);
	});

	test('choosing a chapter opens the typing screen at the page containing that chapter start', async ({
		page
	}) => {
		await page.goto(`/books/${FULL_SLUG}`);

		// Chapter III starts at chunk index 6 → page 7. Clicked rather than navigated to, so
		// what is proven is the row's own href and the navigation it performs.
		await expect(async () => {
			await chapterRow(page, 2).click();
			await expect(page.getByTestId('typing-surface')).toBeVisible({ timeout: 2000 });
		}).toPass();

		await expect(page).toHaveURL(new RegExp(`/type/${FULL_SLUG}\\?page=7$`));
		await expectPageIs(page, `7`, `${full.chunkCount}`);
		// The passage really is that chapter's opening page, not merely a URL that said so.
		await expect(page.locator('[data-testid="typing-surface"] .passage')).toContainText(
			PASSAGES[6]
		);
	});

	/* ── entry points ───────────────────────────────────────────────────────────────────── */

	test('a library card and a search result both navigate to /books/[slug], not straight into typing', async ({
		page
	}) => {
		await page.goto('/type?lang=all');
		await expect(gridCard(page, FULL_SLUG)).toHaveAttribute('href', `/books/${FULL_SLUG}`);

		// The search results are the same grid narrowed server-side, which is exactly why one
		// href repoint covers them — asserted rather than assumed, because "the same component
		// renders it" is a claim about today's code, not a guarantee.
		await page.goto('/type?lang=all&q=Detail+Probe');
		await expect(gridCard(page, FULL_SLUG)).toHaveAttribute('href', `/books/${FULL_SLUG}`);

		// And the click really lands there.
		await expect(async () => {
			await gridCard(page, FULL_SLUG).click();
			await expect(primaryAction(page)).toBeVisible({ timeout: 2000 });
		}).toPass();
		await expect(page).toHaveURL(new RegExp(`/books/${FULL_SLUG}$`));
	});
});

/**
 * The signed-in half. Split into its own `describe` because these use the authenticated
 * fixture, which mints a throwaway user per test — the progress states below are mutually
 * exclusive (none; one page inside chapter 3) and one shared user cannot hold both.
 *
 * The probe book is arranged again here rather than shared with the block above: Playwright's
 * `beforeAll` is per-`describe`, the slug is fixed, and `arrangeProbeBook` upserts — so this
 * is the same row, re-published, not a second one.
 */
authTest.describe('book detail screen, signed in', () => {
	authTest.skip(
		!isLocalStack,
		`refusing to create throwaway users against a non-local Supabase (${SUPABASE_URL})`
	);
	authTest.skip(
		!localSecretKey(),
		'needs the local secret key: no client role may publish a book, and none should'
	);

	let service: AnyClient;
	let full: ProbeBook;

	authTest.beforeAll(async () => {
		service = secretClient()!;
		full = await arrangeProbeBook(service, {
			slug: FULL_SLUG,
			title: 'The Detail Probe',
			author: 'A. Probe',
			language: 'en',
			year: YEAR,
			summary: { default: EN_SUMMARY, es: ES_SUMMARY },
			contents: PASSAGES,
			chapters: CHAPTERS
		});
	});

	authTest.afterAll(async () => {
		await retireProbeBook(service, FULL_SLUG);
	});

	authTest(
		'the primary action reads Start with no progress and Continue with progress, and lands on the resume page',
		async ({ page, authUser }) => {
			await page.goto(`/books/${FULL_SLUG}`);
			// Nothing typed yet: Start, and a progress panel reading zero — the panel is
			// present for a signed-in user even at 0, unlike for a guest, because there IS an
			// account for that zero to belong to.
			await expect(primaryAction(page)).toHaveText('Start typing');
			await expect(page.getByTestId('book-detail-progress')).toContainText(
				`0 of ${full.chunkCount} pages`
			);

			// Pages 1 and 2 (0-based positions 0 and 1) — a prefix, so the resume page is
			// unambiguous and is page 3.
			await authUser.completePassages(FULL_SLUG, [0, 1]);

			await page.goto(`/books/${FULL_SLUG}`);
			await expect(primaryAction(page)).toHaveText('Continue typing');
			// 2/9 → 22%. Both the counts and the percentage, because the bar itself is
			// `aria-hidden` and these numerals are the accessible value.
			await expect(page.getByTestId('book-detail-progress')).toContainText(
				`2 of ${full.chunkCount} pages`
			);
			await expect(page.getByTestId('book-detail-progress')).toContainText('22%');

			// The action carries NO `?page=`, deliberately: the server's resume logic decides
			// where the book opens, and freezing it at render time is what that omission avoids.
			await expect(primaryAction(page)).toHaveAttribute('href', `/type/${FULL_SLUG}`);
			await expect(async () => {
				await primaryAction(page).click();
				await expect(page.getByTestId('typing-surface')).toBeVisible({ timeout: 2000 });
			}).toPass();
			await expectPageIs(page, `3`, `${full.chunkCount}`);
		}
	);

	authTest(
		'completing a page inside a later chapter increments only that chapter and leaves the resume page inside chapter 1',
		async ({ page, authUser }) => {
			// Page 7 (0-based position 6) is chapter III's first page. Chapters I and II are
			// untouched, which is the whole point: free chapter starting must not move resume.
			await authUser.completePassages(FULL_SLUG, [6]);

			await page.goto(`/books/${FULL_SLUG}`);

			// Only chapter III moves. The other two are asserted at zero explicitly rather
			// than left unmentioned — "the right one went up" and "the wrong ones did not"
			// are two different claims, and only the second catches a fold that buckets by a
			// merge walk over unsorted indices.
			await expect(chapterRow(page, 0)).toContainText('0 of 3 pages');
			await expect(chapterRow(page, 1)).toContainText('0 of 3 pages');
			await expect(chapterRow(page, 2)).toContainText('1 of 3 pages');

			// The book-level bar counts it too — one fact, two granularities.
			await expect(page.getByTestId('book-detail-progress')).toContainText(
				`1 of ${full.chunkCount} pages`
			);

			// And resume is still the first GAP, which is page 1 — inside chapter I.
			await expect(primaryAction(page)).toHaveText('Continue typing');
			await expect(async () => {
				await primaryAction(page).click();
				await expect(page.getByTestId('typing-surface')).toBeVisible({ timeout: 2000 });
			}).toPass();
			await expectPageIs(page, `1`, `${full.chunkCount}`);
		}
	);

	authTest(
		'the continue-reading section navigates to /books/[slug] like every other entry point',
		async ({ page, authUser }) => {
			await authUser.completePassages(FULL_SLUG, [0]);

			await page.goto('/type?lang=all');
			await expect(sectionCard(page, FULL_SLUG)).toHaveAttribute('href', `/books/${FULL_SLUG}`);

			await expect(async () => {
				await sectionCard(page, FULL_SLUG).click();
				await expect(primaryAction(page)).toBeVisible({ timeout: 2000 });
			}).toPass();
			await expect(page).toHaveURL(new RegExp(`/books/${FULL_SLUG}$`));
			await expect(primaryAction(page)).toHaveText('Continue typing');
		}
	);
});

/**
 * Phase 8 (accessibility) for the detail screen.
 *
 * Same gate as the library's and the typing screen's a11y blocks — critical/serious axe
 * violations only, with no rule carve-outs, `color-contrast` included — plus the three things
 * axe structurally cannot judge: whether the heading order tells the right story, whether the
 * chapter list is exposed as the navigation it is, and whether the whole path from a library
 * card to a typed character can be walked with the mouse unplugged.
 */
test.describe('book detail accessibility (phase 8)', () => {
	test.skip(
		!isLocalStack,
		`refusing to publish a probe book against a non-local Supabase (${SUPABASE_URL})`
	);
	test.skip(
		!localSecretKey(),
		'needs the local secret key: no client role may publish a book, and none should'
	);

	let service: AnyClient;

	test.beforeAll(async () => {
		service = secretClient()!;
		await arrangeProbeBook(service, {
			slug: FULL_SLUG,
			title: 'The Detail Probe',
			author: 'A. Probe',
			language: 'en',
			year: YEAR,
			summary: { default: EN_SUMMARY, es: ES_SUMMARY },
			contents: PASSAGES,
			chapters: CHAPTERS
		});
		// The sparse screen needs its own row here: `beforeAll` is per-`describe`, and the
		// rendering block above retired both probes when it finished.
		await arrangeProbeBook(service, {
			slug: BARE_SLUG,
			title: 'The Bare Probe',
			author: 'B. Probe',
			language: 'en',
			contents: ['Only passage of the bare probe.', 'Second passage of the bare probe.']
		});
	});

	test.afterAll(async () => {
		await retireProbeBook(service, FULL_SLUG);
		await retireProbeBook(service, BARE_SLUG);
	});

	async function seriousViolations(page: Page) {
		const results = await new AxeBuilder({ page }).analyze();
		return results.violations
			.filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
			.map((violation) => `${violation.impact}: ${violation.id} — ${violation.help}`);
	}

	/**
	 * Retried, not a plain `page.goto` — the same dev-server cold-start artefact `gotoLibrary`
	 * documents in `library.e2e.ts`, and axe is where it bites hardest: on a local
	 * `npm run dev` the first request for a route Vite has not compiled yet can still be
	 * settling when `AxeBuilder.analyze()` injects, and the injection fails outright rather
	 * than reporting a violation. Retrying the navigate-and-settle unit gives that first
	 * compile somewhere to land; the scan itself is never retried, so a real violation still
	 * fails on the first look.
	 */
	async function gotoSettled(page: Page, path: string, ready: string) {
		await expect(async () => {
			await page.goto(path);
			await expect(page.getByTestId(ready)).toBeVisible({ timeout: 2000 });
		}).toPass();
		await page.waitForLoadState('networkidle');
	}

	test('the detail screen has no serious violations, in either locale', async ({ page }) => {
		await gotoSettled(page, `/books/${FULL_SLUG}`, 'chapter-list');
		expect(await seriousViolations(page), `axe: /books/${FULL_SLUG}`).toEqual([]);

		// ES too: the Spanish strings are longer and the layout is the same, so a contrast or
		// name-role-value regression that only shows up under one locale would otherwise hide.
		await gotoSettled(page, `/es/books/${FULL_SLUG}`, 'chapter-list');
		expect(await seriousViolations(page), `axe: /es/books/${FULL_SLUG}`).toEqual([]);
	});

	test('a book with no summary and no chapters has no serious violations either', async ({
		page
	}) => {
		// The sparse screen is a different DOM, not the same one with two boxes hidden — the
		// panels are omitted entirely — so it needs its own pass.
		await gotoSettled(page, `/books/${BARE_SLUG}`, 'book-detail-start');
		expect(await seriousViolations(page), `axe: /books/${BARE_SLUG}`).toEqual([]);
	});

	test('the heading order starts at the book title and never skips a level', async ({ page }) => {
		await page.goto(`/books/${FULL_SLUG}`);

		const levels = await page.evaluate(() =>
			[...document.querySelectorAll('main h1, main h2, main h3, main h4, main h5, main h6')].map(
				(heading) => Number(heading.tagName[1])
			)
		);

		// Exactly one h1, and it is first: the screen is ABOUT this book, so the book's title
		// is its top-level heading rather than a section inside something else.
		expect(
			levels.filter((level) => level === 1),
			'the screen must have exactly one h1'
		).toHaveLength(1);
		expect(levels[0], 'the first heading must be the h1').toBe(1);
		// No skipped level anywhere — an h1 followed by an h3 leaves a screen-reader user
		// looking for the section that is not there.
		for (let i = 1; i < levels.length; i += 1) {
			expect(levels[i], `heading ${i} jumps more than one level`).toBeLessThanOrEqual(
				levels[i - 1] + 1
			);
		}
		// The h1 really is the title, not a stray landmark heading that happens to be first.
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('The Detail Probe');
	});

	test('the chapter list is exposed as a named navigation landmark, not an unnamed group of links', async ({
		page
	}) => {
		await page.goto(`/books/${FULL_SLUG}`);

		// The spec calls the chapter list the primary navigation into typing. A `<section>`
		// with a label would expose it as a plain `region`, which a screen-reader user
		// jumping by landmark finds only if they already know it exists. This is the
		// assertion that keeps it a `<nav>`.
		const chapterNav = page.getByRole('navigation', { name: 'Chapters' });
		await expect(chapterNav).toHaveAttribute('data-testid', 'chapter-list');

		// Each row's accessible name carries the chapter, its range and its size — so the
		// links are tellable apart out of context, which is how they are read in a links list.
		await expect(
			chapterNav.getByRole('link', { name: /Chapter II\. The Carpet-Bag/ })
		).toHaveAttribute('href', `/type/${FULL_SLUG}?page=4`);
	});

	/**
	 * The hover tilt after the `BookCover` extraction (spec #34).
	 *
	 * Extracting the cover moved `.frame` out of `BookCard`'s scope, so the tilt rules had to
	 * become `.card :global(.frame)`. That rewrite carries two risks nothing else checks: the
	 * `:global` could ESCAPE onto the detail screen's cover, which must never tilt, and the
	 * `prefers-reduced-motion` block — which had to be rewritten the same way — could stop
	 * matching and leave the tilt running for a user who asked for no motion. Both are
	 * invisible to axe and to every other test in the suite.
	 */
	test('the card tilt stays on the card, and reduced motion suppresses it', async ({ page }) => {
		/** The computed transform of a cover frame, as a plain string ('none' when flat). */
		const frameTransform = (selector: string) =>
			page.evaluate(
				(sel) => getComputedStyle(document.querySelector(sel)!.querySelector('.frame')!).transform,
				selector
			);

		await page.goto('/type?lang=all');
		const cardSelector = `[data-testid="text-picker-option-${FULL_SLUG}"]`;
		await expect(gridCard(page, FULL_SLUG)).toBeVisible();

		// Motion allowed: hovering the card tilts its cover. Asserted first so the reduced
		// case below is a contrast rather than a claim about a rule that never fired at all.
		await gridCard(page, FULL_SLUG).hover();
		await expect
			.poll(() => frameTransform(cardSelector), {
				message: 'hovering a card should tilt its cover frame'
			})
			.not.toBe('none');

		// The detail screen's cover is NOT inside a `.card`, so the same rule must not reach
		// it — a full-size cover that tips under the pointer would be a different product.
		await page.goto(`/books/${FULL_SLUG}`);
		await expect(page.getByTestId('book-detail-start')).toBeVisible();
		await page.getByRole('main').getByTestId('generated-cover').hover();
		expect(await frameTransform('main'), 'the detail screen cover must never tilt').toBe('none');

		// Reduced motion: the card's tilt is suppressed outright, not merely shortened.
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await page.goto('/type?lang=all');
		await expect(gridCard(page, FULL_SLUG)).toBeVisible();
		await gridCard(page, FULL_SLUG).hover();
		expect(
			await frameTransform(cardSelector),
			'reduced motion must leave the cover flat on hover'
		).toBe('none');
	});

	test('the whole path from a library card through the detail screen to typing is keyboard-only, with visible focus', async ({
		page
	}) => {
		await page.goto('/type?lang=all');
		await expect(gridCard(page, FULL_SLUG)).toBeVisible();

		// Tab until focus lands on this probe's card. Bounded like every other walk in the
		// suite: the header and the library's own control group come first.
		const cardTestId = `text-picker-option-${FULL_SLUG}`;
		const reachedCard = await tabToTestId(page, cardTestId, 40);
		expect(reachedCard, `Tab should reach ${cardTestId} within 40 stops`).toBe(true);

		await expect(async () => {
			await page.keyboard.press('Enter');
			await expect(primaryAction(page)).toBeVisible({ timeout: 2000 });
		}).toPass();

		// On the detail screen: the chapter rows must be reachable too, not just the primary
		// action — they are the screen's whole point and they come after it in the DOM.
		const reachedChapter = await tabToTestId(page, 'chapter-row-1', 40);
		expect(reachedChapter, 'Tab should reach a chapter row within 40 stops').toBe(true);

		// Focus is VISIBLE, not merely present: the row carries a focus-visible outline, and
		// a keyboard user who cannot see where they are has no usable list. Read off the
		// computed style so a removed outline fails here rather than in a screenshot nobody
		// looks at.
		const outline = await page.evaluate(() => {
			const active = document.activeElement as HTMLElement;
			const style = getComputedStyle(active);
			return { width: style.outlineWidth, style: style.outlineStyle };
		});
		expect(outline.style, 'the focused chapter row must draw an outline').not.toBe('none');
		expect(parseFloat(outline.width)).toBeGreaterThan(0);

		// And Enter on it starts typing at that chapter — the flow completes with no pointer.
		await expect(async () => {
			await page.keyboard.press('Enter');
			await expect(page.getByTestId('typing-surface')).toBeVisible({ timeout: 2000 });
		}).toPass();
		await expect(page).toHaveURL(new RegExp(`\\?page=4$`));
		await expect(page.getByTestId('typing-input')).toBeFocused();
	});
});
