import { describe, expect, it } from 'vitest';
import { extractHeadings } from './headings.js';

describe('extractHeadings', () => {
	it('extracts a heading level and title for a plain <h2>', () => {
		const html = '<h2>Chapter I.</h2>';
		expect(extractHeadings(html, 'h2')).toEqual([{ level: 2, className: '', title: 'Chapter I.' }]);
	});

	it('excludes Gutenberg header and footer headings regardless of selector', () => {
		const html = `
			<h2 id="pg-header-heading">The Project Gutenberg eBook of Pride and Prejudice</h2>
			<h2>Chapter I.</h2>
			<h2 id="pg-footer-heading">END OF THE PROJECT GUTENBERG EBOOK</h2>
		`;
		const result = extractHeadings(html, 'h2');
		expect(result).toEqual([{ level: 2, className: '', title: 'Chapter I.' }]);
	});

	// Verified real case: Pride and Prejudice's actual <h2> for Chapter II contains a caption
	// span with unrelated prose INSIDE the heading element itself.
	it('strips a nested caption span before computing the title', () => {
		const html =
			'<h2><span class="caption">I hope Mr. Bingley will like it.</span><br><br>CHAPTER II.</h2>';
		expect(extractHeadings(html, 'h2')).toEqual([
			{ level: 2, className: '', title: 'CHAPTER II.' }
		]);
	});

	it('strips a nested pagenum span', () => {
		const html = '<h2><span class="pagenum">7</span>Chapter III.</h2>';
		expect(extractHeadings(html, 'h2')[0].title).toBe('Chapter III.');
	});

	it('strips a caption div', () => {
		const html = '<h2>Chapter IV.<div class="caption">An illustration</div></h2>';
		expect(extractHeadings(html, 'h2')[0].title).toBe('Chapter IV.');
	});

	// Verified real case: Pride and Prejudice's PREFACE and LIST OF ILLUSTRATIONS headings are
	// image-only once their caption decoration is stripped — dropped, not returned empty.
	it('drops a heading that is empty after decoration is stripped', () => {
		const html =
			'<h2><span class="caption">Some illustration caption</span></h2><h2>Chapter I.</h2>';
		const result = extractHeadings(html, 'h2');
		expect(result).toHaveLength(1);
		expect(result[0].title).toBe('Chapter I.');
	});

	it('decodes HTML entities and collapses multi-line whitespace the way clean.ts joins wrapped lines', () => {
		const html = '<h2>Chapter I.\n    Mr. Darcy &amp; Mr.\n    Bingley</h2>';
		expect(extractHeadings(html, 'h2')[0].title).toBe('Chapter I. Mr. Darcy & Mr. Bingley');
	});

	// Verified real case: niebla's h2.nobreak headings are 37, not 36 — one element
	// (POR MODO DE EPÍLOGO) also carries a `title` attribute, and a selector that only matches
	// the literal string `<h2 class="nobreak">` misses it. Matching must be attribute-order and
	// attribute-count agnostic. Do NOT "fix" this back down to 36 — 37 is correct.
	it('matches a tag.class selector by class-token membership, order/count-agnostic', () => {
		const html = [
			'<h2 class="nobreak">I</h2>',
			'<h2 class="nobreak" title="ORACIÓN FÚNEBRE POR MODO DE EPÍLOGO">POR MODO DE EPÍLOGO</h2>',
			'<h2 class="other">Not a match</h2>'
		].join('\n');
		const result = extractHeadings(html, 'h2.nobreak');
		expect(result).toHaveLength(2);
		expect(result[1].title).toBe('POR MODO DE EPÍLOGO');
	});

	it('matches an h3 selector', () => {
		const html = '<h3>Capítulo primero.</h3>';
		expect(extractHeadings(html, 'h3')).toEqual([
			{ level: 3, className: '', title: 'Capítulo primero.' }
		]);
	});

	it('preserves document order across mixed matching and non-matching elements', () => {
		const html = '<h2>One</h2><p>text</p><h2>Two</h2>';
		expect(extractHeadings(html, 'h2').map((h) => h.title)).toEqual(['One', 'Two']);
	});

	it('excludes a book-specific id via excludeIds, independent of the always-on PG exclusion', () => {
		const html = '<h3 id="tasa">TASA</h3><h3>Capítulo I</h3>';
		expect(extractHeadings(html, 'h3', ['tasa']).map((h) => h.title)).toEqual(['Capítulo I']);
	});

	it('records the raw class attribute value on the entry, not just uses it for matching', () => {
		const html = '<h2 class="nobreak extra">Title</h2>';
		expect(extractHeadings(html, 'h2.nobreak')[0].className).toBe('nobreak extra');
	});

	// Verified real defect, byte-checked against the live pg1342-images.html: two headings
	// (Chapters XXVII and XXVIII) literally read "CHAPTERXXVII."/"CHAPTERXXVIII." in the source
	// HTML, with no space, even though the plain-text edition has "CHAPTER XXVII." correctly
	// spaced. Without repairing this, alignment against the cleaned prose fails for those two
	// chapters. Narrowly scoped to a chapter word glued to its own roman numeral — not fuzzy
	// prose matching, which the spec explicitly rejects.
	it('inserts the missing space in a chapter word glued to its own roman numeral', () => {
		const html = '<h2><br><br>CHAPTERXXVII.</h2>';
		expect(extractHeadings(html, 'h2')[0].title).toBe('CHAPTER XXVII.');
	});

	it('leaves an already-spaced chapter heading untouched', () => {
		const html = '<h2>CHAPTER XXVIII.</h2>';
		expect(extractHeadings(html, 'h2')[0].title).toBe('CHAPTER XXVIII.');
	});

	it('repairs the glued form for Capítulo too', () => {
		const html = '<h3>CapítuloIV.</h3>';
		expect(extractHeadings(html, 'h3')[0].title).toBe('Capítulo IV.');
	});

	it('is pure: the same input produces the same output', () => {
		const html = '<h2>Chapter I.</h2>';
		expect(extractHeadings(html, 'h2')).toEqual(extractHeadings(html, 'h2'));
	});
});
