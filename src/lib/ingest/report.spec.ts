import { describe, expect, it } from 'vitest';
import { buildReport } from './report.js';
import { findDisallowed } from './characters.js';
import { MAX_CHARS, MAX_LINES } from '$lib/chunking/measure.js';

const base = {
	slug: 'pride-and-prejudice',
	title: 'Pride and Prejudice',
	sourceUrl: 'https://www.gutenberg.org/cache/epub/1342/pg1342.txt',
	chunks: ['One. '.repeat(100).trim(), 'Two. '.repeat(90).trim(), 'Three. '.repeat(80).trim()],
	disallowed: []
};

describe('buildReport', () => {
	it('names the book, its slug and the source it came from', () => {
		const report = buildReport(base);
		expect(report).toContain('Pride and Prejudice');
		expect(report).toContain('pride-and-prejudice');
		expect(report).toContain(base.sourceUrl);
	});

	it('reports the chunk count and total characters', () => {
		const report = buildReport(base);
		const total = base.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
		expect(report).toContain('3');
		expect(report).toContain(String(total));
	});

	it('reports minimum, median and maximum chunk length', () => {
		const report = buildReport({
			...base,
			chunks: ['a'.repeat(10), 'b'.repeat(20), 'c'.repeat(60)]
		});
		expect(report).toMatch(/10/);
		expect(report).toMatch(/20/);
		expect(report).toMatch(/60/);
	});

	/*
	 * Spec #32: the size target became a DUAL BUDGET. A report still measuring against
	 * "400-600 characters" would flag every single page of every book as out of target, and
	 * the regenerated reports — which are the review surface for the re-chunk — would be
	 * unreadable noise instead of a diff.
	 */
	describe('the dual budget', () => {
		it('counts only the chunks over the budget, not the ones merely under the old target', () => {
			const report = buildReport({
				...base,
				// 500 and 900 characters are ordinary pages now; only the last is over budget.
				chunks: ['a'.repeat(500), 'b'.repeat(900), 'c'.repeat(MAX_CHARS + 200)]
			});
			expect(report).toMatch(/over the budget[^\n]*\|\s*1\s*\|/i);
		});

		it('names both bounds, so a reviewer can see which one a page ran past', () => {
			const report = buildReport(base);
			expect(report).toContain(String(MAX_CHARS));
			expect(report).toContain(String(MAX_LINES));
		});

		it('counts a chunk over the LINE budget even though its characters are within budget', () => {
			// Dialogue: 30 one-line paragraphs. Well under MAX_CHARS, well over MAX_LINES.
			const dialogue = Array.from({ length: 30 }, () => 'Word word word two.').join('\n');
			expect(dialogue.length).toBeLessThan(MAX_CHARS);
			const report = buildReport({ ...base, chunks: [dialogue] });
			expect(report).toMatch(/over the budget[^\n]*\|\s*1\s*\|/i);
		});

		it('reports the median estimated line count, the budget the character count cannot show', () => {
			const report = buildReport({ ...base, chunks: ['a'.repeat(660)] });
			expect(report).toMatch(/median lines[^\n]*\|\s*10\s*\|/i);
		});

		it('says nothing about a budget overrun when every page is within both bounds', () => {
			expect(buildReport(base)).not.toMatch(/over the budget[^\n]*\|\s*[1-9]/i);
		});
	});

	it('quotes the first two and last two chunks in full', () => {
		const chunks = ['FIRST', 'SECOND', 'MIDDLE', 'PENULTIMATE', 'LAST'];
		const report = buildReport({ ...base, chunks });
		expect(report).toContain('FIRST');
		expect(report).toContain('SECOND');
		expect(report).toContain('PENULTIMATE');
		expect(report).toContain('LAST');
		expect(report).not.toContain('MIDDLE');
	});

	it('does not duplicate chunks when the book is shorter than four chunks', () => {
		const report = buildReport({ ...base, chunks: ['ONLY', 'TWO'] });
		expect(report.match(/ONLY/g)).toHaveLength(1);
	});

	it('states plainly when no disallowed character was found', () => {
		expect(buildReport(base)).toMatch(/none/i);
	});

	it('lists each disallowed character with its code point, count and context', () => {
		const report = buildReport({
			...base,
			disallowed: findDisallowed('the temperature was 15° and 20° outside')
		});
		expect(report).toContain('U+00B0');
		expect(report).toContain('2');
		expect(report).toContain('15');
	});

	it('handles a book with no chunks without dividing by zero', () => {
		const report = buildReport({ ...base, chunks: [] });
		expect(report).toContain('0');
		expect(report).not.toContain('NaN');
	});

	it('is markdown with a heading, so a reviewer reads it in the repo', () => {
		expect(buildReport(base).startsWith('#')).toBe(true);
	});

	it('marks the report as generated, so nobody hand-edits it', () => {
		expect(buildReport(base)).toMatch(/generated/i);
	});

	// The report is THE review artefact, and a licence claim that never appears in the thing
	// being reviewed is a claim nobody reviews (spec #19 §2).
	describe('the cover', () => {
		const cover = {
			image: { format: 'png', width: 1000, height: 1500, bytes: 245_760 },
			license: 'Public domain (published 1894)',
			source: 'https://www.gutenberg.org/files/1342/1342-h/images/cover.jpg'
		} as const;

		it('reports the cover format, dimensions and byte size', () => {
			const report = buildReport({ ...base, cover });
			expect(report).toMatch(/png/i);
			expect(report).toContain('1000x1500');
			expect(report).toContain('240 KB');
		});

		it('puts the licence claim and its source in front of the reviewer', () => {
			const report = buildReport({ ...base, cover });
			expect(report).toContain('Public domain (published 1894)');
			expect(report).toContain(cover.source);
		});

		it('renders no cover line at all for a book with no cover', () => {
			expect(buildReport(base)).not.toMatch(/cover/i);
		});
	});

	describe('chapters (spec #33)', () => {
		it('says none declared when the book has no chapters config', () => {
			const report = buildReport(base);
			expect(report).toContain('## Chapters');
			expect(report).toMatch(/none declared/i);
		});

		it('lists index, title, start page (1-based) and page count', () => {
			const report = buildReport({
				...base,
				chapters: [
					{ index: 0, title: 'Chapter I.', startChunkIndex: 0 },
					{ index: 1, title: 'CHAPTER II.', startChunkIndex: 1 }
				]
			});
			expect(report).toContain('Chapter I.');
			expect(report).toContain('CHAPTER II.');
			// Chapter 1: starts at chunk 0 -> page 1, spans chunks 0..0 (1 page, chunks.length=3).
			expect(report).toMatch(/\|\s*1\s*\|\s*Chapter I\.\s*\|\s*1\s*\|\s*1\s*\|/);
			// Chapter 2: starts at chunk 1 -> page 2, spans chunks 1..2 (2 pages).
			expect(report).toMatch(/\|\s*2\s*\|\s*CHAPTER II\.\s*\|\s*2\s*\|\s*2\s*\|/);
		});

		// The row values above happen to coincide (start page 1/pages 1, start page 2/pages 2),
		// which would not catch the "Start page" and "Pages" columns being swapped, or an
		// off-by-one that shifted both by the same amount. Distinguishable values close that gap.
		it('does not confuse the start-page and page-count columns', () => {
			const report = buildReport({
				...base,
				chunks: ['One. '.repeat(100).trim(), 'Two. ', 'Three. ', 'Four. ', 'Five. '],
				chapters: [
					{ index: 0, title: 'Chapter A', startChunkIndex: 0 },
					{ index: 1, title: 'Chapter B', startChunkIndex: 2 },
					{ index: 2, title: 'Chapter C', startChunkIndex: 3 }
				]
			});
			// Chapter A: starts at chunk 0 -> page 1, spans chunks 0..1 (2 pages).
			expect(report).toMatch(/\|\s*1\s*\|\s*Chapter A\s*\|\s*1\s*\|\s*2\s*\|/);
			// Chapter B: starts at chunk 2 -> page 3, spans chunk 2 only (1 page).
			expect(report).toMatch(/\|\s*2\s*\|\s*Chapter B\s*\|\s*3\s*\|\s*1\s*\|/);
			// Chapter C: starts at chunk 3 -> page 4, spans chunks 3..4 (2 pages, chunks.length=5).
			expect(report).toMatch(/\|\s*3\s*\|\s*Chapter C\s*\|\s*4\s*\|\s*2\s*\|/);
		});

		it('is placed after Chunks and before Disallowed characters', () => {
			const report = buildReport({
				...base,
				chapters: [{ index: 0, title: 'Chapter I.', startChunkIndex: 0 }]
			});
			const chunksAt = report.indexOf('## Chunks');
			const chaptersAt = report.indexOf('## Chapters');
			const disallowedAt = report.indexOf('## Disallowed characters');
			expect(chunksAt).toBeLessThan(chaptersAt);
			expect(chaptersAt).toBeLessThan(disallowedAt);
		});
	});
});

/*
 * Spec #34. The report is the only review artefact for the year and summary — ingestion
 * writes straight to the database, so a lookup that silently started failing would otherwise
 * be invisible until someone noticed a blank line on a screen.
 */
describe('buildReport — ## Metadata', () => {
	it('places the section between ## Chunks and ## Chapters', () => {
		const report = buildReport(base);
		expect(report.indexOf('## Chunks')).toBeLessThan(report.indexOf('## Metadata'));
		expect(report.indexOf('## Metadata')).toBeLessThan(report.indexOf('## Chapters'));
	});

	it('says nothing is declared when the book declares no work and no override', () => {
		const report = buildReport(base);
		expect(report).toContain('None declared — this book ships without a year or a summary.');
	});

	it('reports the work id and the year it produced', () => {
		const report = buildReport({
			...base,
			metadata: { work: '/works/OL144961W', year: 1626, description: null }
		});
		expect(report).toContain('/works/OL144961W');
		expect(report).toContain('1626');
	});

	it('reports the description by LENGTH, not in full', () => {
		const description = 'x'.repeat(412);
		const report = buildReport({
			...base,
			metadata: { work: '/works/OL144961W', year: 1626, description }
		});
		expect(report).toContain('412 characters');
		expect(report).not.toContain(description);
	});

	it('quotes only the opening of the description', () => {
		const description = `${'a'.repeat(200)}${'b'.repeat(300)}`;
		const report = buildReport({
			...base,
			metadata: { work: '/works/OL144961W', year: null, description }
		});
		expect(report).toContain('a'.repeat(200));
		expect(report).not.toContain('b'.repeat(10));
	});

	it('quotes a short description whole without an ellipsis', () => {
		const report = buildReport({
			...base,
			metadata: { work: '/works/OL144961W', year: null, description: 'A short blurb.' }
		});
		expect(report).toContain('A short blurb.');
		expect(report).not.toContain('A short blurb.…');
	});

	/*
	 * A row per locale, carrying the LENGTH (spec #55). A list of locale keys was reviewable
	 * while blurbs were optional; now that every book declares every locale it is the same two
	 * words on every report, and the length is what makes a truncated or swapped blurb visible
	 * in a diff.
	 */
	it('gives each declared locale its own row, with the blurb length', () => {
		const report = buildReport({
			...base,
			metadata: {
				work: '/works/OL144961W',
				year: 1626,
				description: 'A blurb.',
				summaries: { en: 'An English blurb.', es: 'Un resumen en español.' }
			}
		});
		expect(report).toContain('| Summary (`en`) | 17 characters (manifest) |');
		expect(report).toContain('| Summary (`es`) | 22 characters (manifest) |');
	});

	it('quotes the opening of each blurb, before the Open Library description', () => {
		const report = buildReport({
			...base,
			metadata: {
				work: '/works/OL144961W',
				year: 1626,
				description: 'Open Library says this.',
				summaries: { en: 'An English blurb.', es: 'Un resumen en español.' }
			}
		});
		expect(report).toContain('Opening of the `en` summary, as declared in the manifest:');
		expect(report).toContain('An English blurb.');
		expect(report).toContain('Un resumen en español.');
		// The hand-written prose is what ships; `default` is the fallback for a state the
		// validator refuses to allow, and must not be the first blurb a reviewer meets.
		expect(report.indexOf('An English blurb.')).toBeLessThan(
			report.indexOf('Opening of the description')
		);
	});

	it('truncates a long blurb to the same preview length as the description', () => {
		const long = `${'a'.repeat(250)}`;
		const report = buildReport({
			...base,
			metadata: { year: 1626, description: null, summaries: { en: long } }
		});
		expect(report).toContain(`${'a'.repeat(200)}…`);
		expect(report).not.toContain('a'.repeat(201));
	});

	/*
	 * A failure is NON-FATAL, so it must be loud somewhere. The blockquote follows the
	 * over-budget warning's shape, which is what a reviewer already knows how to read.
	 */
	it('renders a failure as a blockquote naming the reason verbatim', () => {
		const report = buildReport({
			...base,
			metadata: {
				work: '/works/OL144961W',
				year: null,
				description: null,
				failure: 'Open Library returned 404 Not Found'
			}
		});
		expect(report).toContain('> ');
		expect(report).toContain('Open Library returned 404 Not Found');
	});

	it('still reports the work id when the lookup failed, so the wrong id is visible', () => {
		const report = buildReport({
			...base,
			metadata: {
				work: '/works/OL999999999W',
				year: null,
				description: null,
				failure: 'Open Library returned 404 Not Found'
			}
		});
		expect(report).toContain('/works/OL999999999W');
	});

	/*
	 * A hand-written summary with no Open Library work is legitimate, so it must not fall into
	 * the "None declared" branch — that would report a book as having no summary while shipping
	 * one.
	 */
	it('reports the manifest blurbs even when no work is declared', () => {
		const report = buildReport({
			...base,
			metadata: { year: null, description: null, summaries: { es: 'Un resumen.' } }
		});
		expect(report).not.toContain('None declared — this book ships without a year or a summary.');
		expect(report).toContain('| Summary (`es`) |');
	});

	it('leaves every other section unchanged', () => {
		const report = buildReport({
			...base,
			metadata: { work: '/works/OL144961W', year: 1626, description: 'A blurb.' }
		});
		expect(report).toContain('## Chunks');
		expect(report).toContain('## Chapters');
		expect(report).toContain('## Disallowed characters');
		expect(report).toContain('## Boundary chunks');
	});
});

/*
 * Year provenance (spec #34). The manifest may declare a `year` that overrides Open Library's
 * `first_publish_year`, so the report has to answer a question it did not have before: WHERE
 * did this number come from? A reviewer reading the diff must be able to tell a hand-declared
 * 1605 from a fetched 1626, and — the case the override exists for — must be told when the two
 * sources disagree, because that disagreement is the thing worth a human's attention.
 */
describe('buildReport — ## Metadata year provenance', () => {
	it('attributes a fetched year to Open Library', () => {
		const report = buildReport({
			...base,
			metadata: {
				work: '/works/OL144961W',
				year: 1626,
				openLibraryYear: 1626,
				description: null
			}
		});
		expect(report).toContain('1626 (Open Library)');
	});

	it('attributes a declared year to the manifest', () => {
		const report = buildReport({
			...base,
			metadata: {
				year: 1914,
				manifestYear: 1914,
				description: null,
				summaries: { es: 'Un resumen.' }
			}
		});
		expect(report).toContain('1914 (manifest)');
	});

	/*
	 * The case the override was added for. Both numbers appear, labelled, and the disagreement
	 * is called out rather than left for the reader to spot by comparing two cells.
	 */
	it('shows both numbers and names the disagreement when the sources differ', () => {
		const report = buildReport({
			...base,
			metadata: {
				work: '/works/OL503666W',
				year: 1605,
				manifestYear: 1605,
				openLibraryYear: 1600,
				description: null
			}
		});
		expect(report).toContain('1605 (manifest override');
		expect(report).toContain('1600');
		expect(report).toMatch(/disagree/i);
	});

	/*
	 * Agreement is worth stating too: it tells the reviewer the override is now redundant
	 * because Open Library has been corrected, which is a reason to delete it.
	 */
	it('says the sources agree when the declared year matches the fetched one', () => {
		const report = buildReport({
			...base,
			metadata: {
				work: '/works/OL144961W',
				year: 1626,
				manifestYear: 1626,
				openLibraryYear: 1626,
				description: null
			}
		});
		expect(report).toContain('1626 (manifest, agrees with Open Library)');
		expect(report).not.toMatch(/disagree/i);
	});

	/*
	 * A declared year for a book with no work id — the niebla/trafalgar case. There is nothing
	 * to disagree with, so it must not read as an override of anything.
	 */
	it('does not claim an override when there was no lookup to override', () => {
		const report = buildReport({
			...base,
			metadata: {
				year: 1873,
				manifestYear: 1873,
				description: null,
				summaries: { es: 'Un resumen.' }
			}
		});
		expect(report).toContain('1873 (manifest)');
		expect(report).not.toContain('manifest override');
	});

	/*
	 * A failed lookup leaves no fetched year to compare against, so a declared year stands
	 * alone — and must still be reported as present, since it is still written to the catalog.
	 */
	it('reports a declared year even when the Open Library lookup failed', () => {
		const report = buildReport({
			...base,
			metadata: {
				work: '/works/OL503666W',
				year: 1605,
				manifestYear: 1605,
				openLibraryYear: null,
				description: null,
				failure: 'Open Library returned 404 Not Found — check the work id in the manifest.'
			}
		});
		expect(report).toContain('1605 (manifest)');
		expect(report).toContain('404 Not Found');
	});

	it('still says None when neither source produced a year', () => {
		const report = buildReport({
			...base,
			metadata: {
				work: '/works/OL144961W',
				year: null,
				openLibraryYear: null,
				description: 'A blurb.'
			}
		});
		expect(report).toContain('| First publication year | None |');
	});

	it('renders a book with a declared year but nothing else as a table, not "None declared"', () => {
		const report = buildReport({
			...base,
			metadata: { year: 1914, manifestYear: 1914, description: null }
		});
		expect(report).not.toContain('None declared — this book ships without a year or a summary.');
		expect(report).toContain('1914 (manifest)');
	});
});
