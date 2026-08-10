import { describe, expect, it } from 'vitest';
import { parseOpenLibraryWork } from './open-library.js';

describe('parseOpenLibraryWork — first_publish_year', () => {
	it('reads a year given as a number', () => {
		expect(parseOpenLibraryWork({ first_publish_year: 1626 }).year).toBe(1626);
	});

	/*
	 * Open Library is not schema-stable across endpoints: the same field arrives as a JSON
	 * number from one and as a numeric string from another. Accepting both is not defensive
	 * padding — it is the difference between a year and a silent null for half the catalog.
	 */
	it('reads a year given as a numeric string', () => {
		expect(parseOpenLibraryWork({ first_publish_year: '1626' }).year).toBe(1626);
	});

	it('reads a negative year (a work published BCE)', () => {
		expect(parseOpenLibraryWork({ first_publish_year: -380 }).year).toBe(-380);
	});

	it('reports no year when the field is absent', () => {
		expect(parseOpenLibraryWork({ title: 'Whatever' }).year).toBeNull();
	});

	it('rejects a non-numeric string rather than storing NaN', () => {
		expect(parseOpenLibraryWork({ first_publish_year: 'circa 1626' }).year).toBeNull();
	});

	it('rejects a non-integer year', () => {
		expect(parseOpenLibraryWork({ first_publish_year: 1626.5 }).year).toBeNull();
	});

	it('rejects a year of the wrong type entirely', () => {
		expect(parseOpenLibraryWork({ first_publish_year: { value: 1626 } }).year).toBeNull();
		expect(parseOpenLibraryWork({ first_publish_year: null }).year).toBeNull();
		expect(parseOpenLibraryWork({ first_publish_year: [1626] }).year).toBeNull();
	});
});

describe('parseOpenLibraryWork — description', () => {
	it('reads a description given as a plain string', () => {
		expect(
			parseOpenLibraryWork({ description: 'A young man goes to Salamanca.' }).description
		).toBe('A young man goes to Salamanca.');
	});

	/*
	 * The second shape Open Library actually emits. Both are live in the same API, on the same
	 * field, and which one a given work returns is not predictable from anything the manifest
	 * knows — so both are handled here rather than guessed at the call site.
	 */
	it('reads a description given as a typed text object', () => {
		const payload = {
			description: { type: '/type/text', value: 'A young man goes to Salamanca.' }
		};
		expect(parseOpenLibraryWork(payload).description).toBe('A young man goes to Salamanca.');
	});

	it('reports no description when the field is absent', () => {
		expect(parseOpenLibraryWork({ first_publish_year: 1626 }).description).toBeNull();
	});

	it('reports no description for an object without a string `value`', () => {
		expect(parseOpenLibraryWork({ description: { type: '/type/text' } }).description).toBeNull();
		expect(parseOpenLibraryWork({ description: { value: 42 } }).description).toBeNull();
	});

	it('reports no description for a shape it does not recognise', () => {
		expect(parseOpenLibraryWork({ description: ['a', 'b'] }).description).toBeNull();
		expect(parseOpenLibraryWork({ description: 42 }).description).toBeNull();
		expect(parseOpenLibraryWork({ description: null }).description).toBeNull();
	});

	it('treats a whitespace-only description as absent rather than storing a blank summary', () => {
		expect(parseOpenLibraryWork({ description: '   \n  ' }).description).toBeNull();
	});
});

describe('parseOpenLibraryWork — trailing attribution footnotes', () => {
	it('strips a trailing markdown reference footnote and its link definition', () => {
		const description = [
			'The tale of a boy and his masters.',
			'',
			'([Source][1])',
			'',
			'  [1]: https://en.wikipedia.org/wiki/Lazarillo_de_Tormes'
		].join('\n');
		expect(parseOpenLibraryWork({ description }).description).toBe(
			'The tale of a boy and his masters.'
		);
	});

	it('strips an inline reference footnote left on the last line', () => {
		const description = 'The tale of a boy and his masters. ([source][1])';
		expect(parseOpenLibraryWork({ description }).description).toBe(
			'The tale of a boy and his masters.'
		);
	});

	it('strips a trailing inline markdown link attribution', () => {
		const description =
			'The tale of a boy and his masters.\n\n([Wikipedia](https://en.wikipedia.org/wiki/X))';
		expect(parseOpenLibraryWork({ description }).description).toBe(
			'The tale of a boy and his masters.'
		);
	});

	it('handles CRLF line endings, which Open Library emits', () => {
		const description =
			'The tale of a boy.\r\n\r\n([Source][1])\r\n\r\n  [1]: https://example.org/x';
		expect(parseOpenLibraryWork({ description }).description).toBe('The tale of a boy.');
	});

	/*
	 * The load-bearing property of the stripper. It is pattern-bounded on purpose: a blurb whose
	 * final paragraph merely CONTAINS brackets, or ends in a parenthetical that is real prose,
	 * must survive whole. Mangling a description is worse than leaving a footnote in it — the
	 * footnote is ugly, a truncated blurb is wrong.
	 */
	it('passes a description that matches no footnote pattern through whole', () => {
		const description =
			'A knight (of a sort) rides out.\n\nHe is accompanied by Sancho Panza [his squire].';
		expect(parseOpenLibraryWork({ description }).description).toBe(description);
	});

	it('does not strip a trailing parenthetical that is ordinary prose', () => {
		const description = 'A knight rides out (and returns much changed).';
		expect(parseOpenLibraryWork({ description }).description).toBe(description);
	});

	it('does not strip a bracketed reference from the MIDDLE of a description', () => {
		const description = 'A knight rides out.\n\n([Source][1])\n\nHe returns much changed.';
		expect(parseOpenLibraryWork({ description }).description).toBe(description);
	});

	it('trims surrounding whitespace', () => {
		expect(parseOpenLibraryWork({ description: '  A knight rides out.  ' }).description).toBe(
			'A knight rides out.'
		);
	});

	it('reports no description when stripping leaves nothing but the footnote', () => {
		expect(parseOpenLibraryWork({ description: '([Source][1])' }).description).toBeNull();
	});
});

describe('parseOpenLibraryWork — hostile payloads', () => {
	it('returns both fields null for a payload that is not an object', () => {
		expect(parseOpenLibraryWork(null)).toEqual({ year: null, description: null });
		expect(parseOpenLibraryWork('nope')).toEqual({ year: null, description: null });
		expect(parseOpenLibraryWork([])).toEqual({ year: null, description: null });
		expect(parseOpenLibraryWork(undefined)).toEqual({ year: null, description: null });
	});

	it('reads each field independently — one being unusable never suppresses the other', () => {
		expect(parseOpenLibraryWork({ first_publish_year: 1626, description: 42 })).toEqual({
			year: 1626,
			description: null
		});
		expect(parseOpenLibraryWork({ first_publish_year: 'soon', description: 'A blurb.' })).toEqual({
			year: null,
			description: 'A blurb.'
		});
	});

	/*
	 * ADR-0013's typeable set is deliberately NOT applied here. It governs text a user must
	 * TYPE, where a character outside the set makes a passage impossible to complete. A summary
	 * is display-only, so a curly quote or an ellipsis in it is not a defect and must survive.
	 */
	it('keeps characters outside the typeable set — a summary is displayed, never typed', () => {
		const description = '“A knight rides out,” he said — and was never seen again…';
		expect(parseOpenLibraryWork({ description }).description).toBe(description);
	});
});

/*
 * Verified against the live API while populating the catalog (spec #34, Phase 3b).
 *
 * A WORK payload (`/works/OL…W.json`) does NOT carry `first_publish_year` — that field only
 * exists on a search document. What the work payload carries instead is `first_publish_date`,
 * and it is the date of some EDITION: Pride and Prejudice's is "1853", Don Quijote's is
 * "1896". Reading it would put a confidently wrong year on the detail screen, which is the
 * exact failure the "never by search" rule exists to prevent, arriving by another door.
 */
describe('parseOpenLibraryWork — first_publish_date is NOT a fallback', () => {
	it('ignores first_publish_date, which is an edition date wearing a work-shaped name', () => {
		const payload = { first_publish_date: '1853', description: 'A blurb.' };
		expect(parseOpenLibraryWork(payload).year).toBeNull();
	});

	it('still reads first_publish_year when both are present', () => {
		const payload = { first_publish_date: '1853', first_publish_year: 1813 };
		expect(parseOpenLibraryWork(payload).year).toBe(1813);
	});
});

/*
 * The footnote shape the real catalog actually hit: El Buscón's description ends with
 * `Fuente/Source: [Wikipedia](https://es.wikipedia.org/wiki/…).` — a labelled attribution
 * rather than a bare bracketed one.
 */
describe('parseOpenLibraryWork — labelled attribution footnotes', () => {
	it('strips a trailing labelled attribution line', () => {
		const description =
			'Una novela picaresca en castellano.\r\n\r\nFuente/Source: [Wikipedia](https://es.wikipedia.org/wiki/La_vida_del_Busc%C3%B3n).';
		expect(parseOpenLibraryWork({ description }).description).toBe(
			'Una novela picaresca en castellano.'
		);
	});

	it('strips a labelled reference-style attribution line', () => {
		const description = 'A blurb.\n\nSource: [Wikipedia][1]\n\n  [1]: https://example.org/x';
		expect(parseOpenLibraryWork({ description }).description).toBe('A blurb.');
	});

	/*
	 * Still pattern-bounded: the label must be short and colon-terminated. A full sentence that
	 * merely happens to contain a link is prose, and prose is never dropped.
	 */
	it('does not strip a final sentence that happens to contain a link', () => {
		const description =
			'The novel was first printed in 1626, as recorded in [the catalogue](https://example.org/x).';
		expect(parseOpenLibraryWork({ description }).description).toBe(description);
	});
});
