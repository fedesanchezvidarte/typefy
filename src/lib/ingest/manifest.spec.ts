import { describe, expect, it } from 'vitest';
import { parseManifest } from './manifest.js';

const valid = {
	slug: 'pride-and-prejudice',
	title: 'Pride and Prejudice',
	author: 'Jane Austen',
	language: 'en',
	sourceUrl: 'https://www.gutenberg.org/cache/epub/1342/pg1342.txt',
	license: 'Public domain in the USA'
};

/** Serialises a manifest the way the committed file holds it. */
function manifest(...books: unknown[]): string {
	return JSON.stringify({ books });
}

/** Asserts failure and returns the problems, so each test states what it expects to read. */
function problemsOf(raw: string): string[] {
	const result = parseManifest(raw);
	if (result.ok) {
		throw new Error('expected the manifest to be rejected');
	}
	return result.problems;
}

describe('parseManifest — accepting', () => {
	it('accepts a minimal valid entry', () => {
		const result = parseManifest(manifest(valid));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.books).toHaveLength(1);
		expect(result.books[0].slug).toBe('pride-and-prejudice');
	});

	it('defaults featured to false rather than leaving it undefined', () => {
		const result = parseManifest(manifest(valid));
		if (!result.ok) throw new Error('expected acceptance');
		expect(result.books[0].featured).toBe(false);
	});

	it('carries cleaning overrides through untouched', () => {
		const result = parseManifest(
			manifest({ ...valid, cleaning: { startMarker: '<<A>>', endMarker: '<<B>>' } })
		);
		if (!result.ok) throw new Error('expected acceptance');
		expect(result.books[0].cleaning).toEqual({ startMarker: '<<A>>', endMarker: '<<B>>' });
	});

	it('accepts one featured book per language', () => {
		const result = parseManifest(
			manifest(
				{ ...valid, featured: true },
				{ ...valid, slug: 'quijote', language: 'es', featured: true }
			)
		);
		expect(result.ok).toBe(true);
	});

	it('accepts an empty catalog — a manifest with no books yet is not an error', () => {
		const result = parseManifest(manifest());
		expect(result.ok).toBe(true);
	});
});

describe('parseManifest — rejecting', () => {
	it('rejects malformed JSON without throwing', () => {
		expect(problemsOf('{ not json')[0]).toMatch(/json/i);
	});

	it('rejects a payload whose books property is not an array', () => {
		expect(problemsOf(JSON.stringify({ books: 'nope' })).join(' ')).toMatch(/books/i);
	});

	it('rejects a missing required field, naming the field and the entry', () => {
		const withoutTitle: Record<string, unknown> = { ...valid };
		delete withoutTitle.title;
		const problems = problemsOf(manifest(withoutTitle)).join(' ');
		expect(problems).toMatch(/title/);
		expect(problems).toMatch(/pride-and-prejudice/);
	});

	it('rejects an unknown content language', () => {
		expect(problemsOf(manifest({ ...valid, language: 'fr' })).join(' ')).toMatch(/language/i);
	});

	it('rejects a duplicate slug', () => {
		expect(problemsOf(manifest(valid, valid)).join(' ')).toMatch(/duplicate/i);
	});

	it('rejects a slug that is not URL-safe', () => {
		expect(problemsOf(manifest({ ...valid, slug: 'Pride & Prejudice' })).join(' ')).toMatch(
			/slug/i
		);
	});

	it('rejects a malformed source URL', () => {
		expect(problemsOf(manifest({ ...valid, sourceUrl: 'not-a-url' })).join(' ')).toMatch(/url/i);
	});

	it('rejects a source URL that is not http(s)', () => {
		expect(problemsOf(manifest({ ...valid, sourceUrl: 'file:///etc/passwd' })).join(' ')).toMatch(
			/url/i
		);
	});

	it('rejects more than one featured book in the same language', () => {
		const problems = problemsOf(
			manifest({ ...valid, featured: true }, { ...valid, slug: 'emma', featured: true })
		).join(' ');
		expect(problems).toMatch(/featured/i);
		expect(problems).toMatch(/en/);
	});

	it('rejects a cover without its licence and source, so a claim is never implicit', () => {
		const problems = problemsOf(manifest({ ...valid, cover: 'covers/pp.jpg' })).join(' ');
		expect(problems).toMatch(/coverLicense|coverSource/);
	});

	it('accepts a cover accompanied by both', () => {
		const result = parseManifest(
			manifest({
				...valid,
				cover: 'covers/pp.jpg',
				coverLicense: 'CC0',
				coverSource: 'https://example.org/cover'
			})
		);
		expect(result.ok).toBe(true);
	});

	it('reports every problem at once rather than stopping at the first', () => {
		const problems = problemsOf(manifest({ ...valid, language: 'fr', slug: 'Bad Slug' }));
		expect(problems.length).toBeGreaterThan(1);
	});
});

describe('parseManifest — chapters config (spec #33)', () => {
	it('accepts an entry with neither chaptersHtmlUrl nor chapters — a book may have no chapters', () => {
		const result = parseManifest(manifest(valid));
		expect(result.ok).toBe(true);
	});

	it('accepts chaptersHtmlUrl with a valid selector', () => {
		const result = parseManifest(
			manifest({
				...valid,
				chaptersHtmlUrl: 'https://www.gutenberg.org/cache/epub/1342/pg1342-images.html',
				chapters: { selector: 'h2', firstHeadingImplicit: true }
			})
		);
		expect(result.ok).toBe(true);
	});

	it('accepts a tag.class selector', () => {
		const result = parseManifest(
			manifest({
				...valid,
				chaptersHtmlUrl: 'https://example.org/book.html',
				chapters: { selector: 'h2.nobreak' }
			})
		);
		expect(result.ok).toBe(true);
	});

	it('accepts chapters.titles as the fallback path, with no chaptersHtmlUrl', () => {
		const result = parseManifest(
			manifest({ ...valid, chapters: { titles: ['Chapter I', 'Chapter II'] } })
		);
		expect(result.ok).toBe(true);
	});

	it('rejects a chaptersHtmlUrl that is not http(s)', () => {
		const problems = problemsOf(
			manifest({ ...valid, chaptersHtmlUrl: 'file:///etc/passwd', chapters: { selector: 'h2' } })
		).join(' ');
		expect(problems).toMatch(/chaptersHtmlUrl/i);
	});

	it('rejects a malformed selector', () => {
		const problems = problemsOf(
			manifest({
				...valid,
				chaptersHtmlUrl: 'https://example.org/book.html',
				chapters: { selector: 'H2!' }
			})
		).join(' ');
		expect(problems).toMatch(/selector/i);
	});

	it('rejects chapters.titles being an empty array', () => {
		const problems = problemsOf(manifest({ ...valid, chapters: { titles: [] } })).join(' ');
		expect(problems).toMatch(/titles/i);
	});

	it('rejects chapters.titles containing an empty string', () => {
		const problems = problemsOf(
			manifest({ ...valid, chapters: { titles: ['Chapter I', ''] } })
		).join(' ');
		expect(problems).toMatch(/titles/i);
	});

	it('rejects both chaptersHtmlUrl and chapters.titles present at once, as ambiguous', () => {
		const problems = problemsOf(
			manifest({
				...valid,
				chaptersHtmlUrl: 'https://example.org/book.html',
				chapters: { titles: ['Chapter I'] }
			})
		).join(' ');
		expect(problems).toMatch(/chaptersHtmlUrl|titles/i);
		expect(problems).toMatch(/not both|ambiguous/i);
	});

	it('rejects chapters.selector present without chaptersHtmlUrl or chapters.titles', () => {
		const problems = problemsOf(manifest({ ...valid, chapters: { selector: 'h2' } })).join(' ');
		expect(problems).toMatch(/chaptersHtmlUrl|titles/i);
	});

	it('rejects chapters.excludeTitles present without chaptersHtmlUrl or chapters.titles', () => {
		const problems = problemsOf(
			manifest({ ...valid, chapters: { excludeTitles: ['PRÓLOGO'] } })
		).join(' ');
		expect(problems).toMatch(/chaptersHtmlUrl|titles/i);
	});

	it('rejects chapters.firstHeadingImplicit present without chaptersHtmlUrl or chapters.titles', () => {
		const problems = problemsOf(
			manifest({ ...valid, chapters: { firstHeadingImplicit: true } })
		).join(' ');
		expect(problems).toMatch(/chaptersHtmlUrl|titles/i);
	});

	it('carries chapters config through untouched when valid', () => {
		const result = parseManifest(
			manifest({
				...valid,
				chaptersHtmlUrl: 'https://example.org/book.html',
				chapters: { selector: 'h3', excludeTitles: ['TASA'], firstHeadingImplicit: true }
			})
		);
		if (!result.ok) throw new Error('expected acceptance');
		expect(result.books[0].chaptersHtmlUrl).toBe('https://example.org/book.html');
		expect(result.books[0].chapters).toEqual({
			selector: 'h3',
			excludeTitles: ['TASA'],
			firstHeadingImplicit: true
		});
	});
});

/*
 * Spec #34: the manifest is where a book declares its Open Library work and any hand-written
 * per-locale summary. Both are optional and independent of each other.
 */
describe('parseManifest — Open Library work id (spec #34)', () => {
	it('accepts a well-formed work id and carries it through', () => {
		const result = parseManifest(manifest({ ...valid, openLibraryWork: '/works/OL144961W' }));
		if (!result.ok) throw new Error('expected acceptance');
		expect(result.books[0].openLibraryWork).toBe('/works/OL144961W');
	});

	it('accepts an entry with no openLibraryWork at all', () => {
		const result = parseManifest(manifest(valid));
		if (!result.ok) throw new Error('expected acceptance');
		expect(result.books[0].openLibraryWork).toBeUndefined();
	});

	/*
	 * The shape check IS the "by declared id only, never by search" rule: a search term cannot
	 * be expressed in a field that only admits `/works/OL<digits>W`. That matters because
	 * searching Open Library for "El Buscón" returns editions dated 1961 and 1979 alongside the
	 * work's real 1626 — a wrong year nobody would notice.
	 */
	it('rejects a search term dressed up as a work id', () => {
		const problems = problemsOf(manifest({ ...valid, openLibraryWork: 'El Buscón' })).join(' ');
		expect(problems).toMatch(/openLibraryWork/);
	});

	it('rejects an EDITION id, which would carry an edition date rather than the work year', () => {
		const problems = problemsOf(manifest({ ...valid, openLibraryWork: '/books/OL7353617M' })).join(
			' '
		);
		expect(problems).toMatch(/openLibraryWork/);
	});

	it('rejects a bare id with no /works/ prefix', () => {
		expect(problemsOf(manifest({ ...valid, openLibraryWork: 'OL144961W' })).join(' ')).toMatch(
			/openLibraryWork/
		);
	});

	it('rejects a full URL', () => {
		const problems = problemsOf(
			manifest({ ...valid, openLibraryWork: 'https://openlibrary.org/works/OL144961W' })
		).join(' ');
		expect(problems).toMatch(/openLibraryWork/);
	});

	it('rejects a non-string openLibraryWork', () => {
		expect(problemsOf(manifest({ ...valid, openLibraryWork: 144961 })).join(' ')).toMatch(
			/openLibraryWork/
		);
	});
});

describe('parseManifest — summary overrides (spec #34)', () => {
	it('accepts a summary keyed by a known locale and carries it through', () => {
		const result = parseManifest(manifest({ ...valid, summary: { es: 'Un resumen.' } }));
		if (!result.ok) throw new Error('expected acceptance');
		expect(result.books[0].summary).toEqual({ es: 'Un resumen.' });
	});

	it('accepts several locales at once', () => {
		const result = parseManifest(
			manifest({ ...valid, summary: { en: 'A summary.', es: 'Un resumen.' } })
		);
		if (!result.ok) throw new Error('expected acceptance');
		expect(result.books[0].summary).toEqual({ en: 'A summary.', es: 'Un resumen.' });
	});

	/*
	 * The two fields are independent: a hand-written summary for a book with no Open Library
	 * work is legitimate, and a work id with no override is the common case.
	 */
	it('accepts a summary with no openLibraryWork', () => {
		expect(parseManifest(manifest({ ...valid, summary: { es: 'Un resumen.' } })).ok).toBe(true);
	});

	it('accepts an openLibraryWork with no summary', () => {
		expect(parseManifest(manifest({ ...valid, openLibraryWork: '/works/OL144961W' })).ok).toBe(
			true
		);
	});

	/*
	 * A typo'd locale key is REPORTED, never dropped. Silently ignoring `"sp"` produces a book
	 * whose Spanish summary mysteriously never appears, with nothing anywhere saying why.
	 */
	it('rejects an unknown locale key rather than ignoring it', () => {
		const problems = problemsOf(manifest({ ...valid, summary: { sp: 'Un resumen.' } })).join(' ');
		expect(problems).toMatch(/summary/);
		expect(problems).toMatch(/sp/);
	});

	it('rejects an empty-string summary — an absent summary is expressed by omission', () => {
		expect(problemsOf(manifest({ ...valid, summary: { es: '' } })).join(' ')).toMatch(/summary/);
	});

	it('rejects a non-string summary value', () => {
		expect(problemsOf(manifest({ ...valid, summary: { es: 42 } })).join(' ')).toMatch(/summary/);
	});

	it('rejects a summary that is not an object', () => {
		expect(problemsOf(manifest({ ...valid, summary: 'Un resumen.' })).join(' ')).toMatch(/summary/);
		expect(problemsOf(manifest({ ...valid, summary: ['Un resumen.'] })).join(' ')).toMatch(
			/summary/
		);
	});

	it('rejects an empty summary object — it declares nothing and is always a mistake', () => {
		expect(problemsOf(manifest({ ...valid, summary: {} })).join(' ')).toMatch(/summary/);
	});
});

/*
 * The year override (spec #34). Same doctrine as the per-locale `summary` override: a value
 * declared in the manifest wins over whatever Open Library returned. It exists because Open
 * Library's `first_publish_year` is the earliest *catalogued edition*, which for several books
 * in this catalog is not the work's first publication — 1600 for a Quijote first published in
 * 1605, 1884 for a Trafalgar first published in 1873.
 */
describe('parseManifest — year override (spec #34)', () => {
	it('accepts a declared year and carries it through', () => {
		const result = parseManifest(manifest({ ...valid, year: 1605 }));
		if (!result.ok) throw new Error('expected acceptance');
		expect(result.books[0].year).toBe(1605);
	});

	it('accepts an entry with no year at all', () => {
		const result = parseManifest(manifest(valid));
		if (!result.ok) throw new Error('expected acceptance');
		expect(result.books[0].year).toBeUndefined();
	});

	/*
	 * The two fields are independent in both directions. A declared year with NO work id is the
	 * niebla/trafalgar case — books deliberately given no `openLibraryWork` because Open
	 * Library's description for them is a physical-extent or series note rather than a blurb.
	 * Without this, they would ship with no year at all.
	 */
	it('accepts a year with no openLibraryWork', () => {
		expect(parseManifest(manifest({ ...valid, year: 1914 })).ok).toBe(true);
	});

	it('accepts an openLibraryWork with no year', () => {
		expect(parseManifest(manifest({ ...valid, openLibraryWork: '/works/OL144961W' })).ok).toBe(
			true
		);
	});

	it('accepts a negative year — antiquity is in scope for a public-domain catalog', () => {
		const result = parseManifest(manifest({ ...valid, year: -800 }));
		if (!result.ok) throw new Error('expected acceptance');
		expect(result.books[0].year).toBe(-800);
	});

	/*
	 * The bounds mirror `books_year_plausible` in the Phase 2 migration exactly. This is a typo
	 * catch — a Gutenberg id or an ISBN landing in the field — not a claim about publishing
	 * history, and catching it here means a bad manifest fails before the database is touched.
	 */
	it('rejects a year past the upper bound the database check constraint uses', () => {
		expect(problemsOf(manifest({ ...valid, year: 2201 })).join(' ')).toMatch(/year/);
	});

	it('rejects a year below the lower bound', () => {
		expect(problemsOf(manifest({ ...valid, year: -3001 })).join(' ')).toMatch(/year/);
	});

	it('accepts the exact bounds, which are legal values rather than exclusive limits', () => {
		expect(parseManifest(manifest({ ...valid, year: 2200 })).ok).toBe(true);
		expect(parseManifest(manifest({ ...valid, year: -3000 })).ok).toBe(true);
	});

	it('rejects a Gutenberg id mistakenly pasted into the year field', () => {
		expect(problemsOf(manifest({ ...valid, year: 32315 })).join(' ')).toMatch(/year/);
	});

	it('rejects a non-integer year rather than rounding it', () => {
		expect(problemsOf(manifest({ ...valid, year: 1605.5 })).join(' ')).toMatch(/year/);
	});

	/*
	 * A quoted year is the likeliest hand-editing mistake in a JSON file whose every other
	 * field is a string. It is refused rather than coerced: `books.year` is an integer column,
	 * and a manifest that means 1605 should say 1605.
	 */
	it('rejects a year given as a string, rather than coercing it', () => {
		expect(problemsOf(manifest({ ...valid, year: '1605' })).join(' ')).toMatch(/year/);
	});

	it('rejects a year of the wrong type entirely', () => {
		expect(problemsOf(manifest({ ...valid, year: null })).join(' ')).toMatch(/year/);
	});
});
