import { describe, expect, it } from 'vitest';
import { buildReport } from './report.js';
import { findDisallowed } from './characters.js';

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

	it('counts chunks outside the size target', () => {
		const report = buildReport({
			...base,
			chunks: ['a'.repeat(50), 'b'.repeat(500), 'c'.repeat(900)]
		});
		expect(report).toMatch(/outside the target[^\n]*2/i);
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
});
