import { describe, expect, it } from 'vitest';
import { alignChapters } from './chapters.js';

describe('alignChapters', () => {
	it('maps a heading to the chunk index containing its paragraph', () => {
		const chunks = ['Chapter I.\nSome prose here.', 'More prose in chunk two.'];
		const result = alignChapters(['Chapter I.'], chunks);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.chapters).toEqual([{ index: 0, title: 'Chapter I.', startChunkIndex: 0 }]);
	});

	it('aligns multiple headings to their respective chunks, in order', () => {
		const chunks = [
			'Chapter I.\nProse A.',
			'Chapter II.\nProse B.',
			'Prose C.\nChapter III.\nProse D.'
		];
		const result = alignChapters(['Chapter I.', 'Chapter II.', 'Chapter III.'], chunks);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.chapters).toEqual([
			{ index: 0, title: 'Chapter I.', startChunkIndex: 0 },
			{ index: 1, title: 'Chapter II.', startChunkIndex: 1 },
			{ index: 2, title: 'Chapter III.', startChunkIndex: 2 }
		]);
	});

	it('fails, naming the heading, when it matches no paragraph', () => {
		const chunks = ['Some prose.', 'More prose.'];
		const result = alignChapters(['Chapter I.'], chunks);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		const problems = result.problems.join(' ');
		expect(problems).toContain('Chapter I.');
		expect(problems).toMatch(/no-match/);
	});

	it('fails, naming the heading and the count, when it matches ambiguously', () => {
		const chunks = ['Chapter I.\nProse.', 'Chapter I.\nMore prose.'];
		const result = alignChapters(['Chapter I.'], chunks);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		const problems = result.problems.join(' ');
		expect(problems).toContain('Chapter I.');
		expect(problems).toMatch(/ambiguous-match/);
		expect(problems).toContain('2');
	});

	it('fails with out-of-order, not a silent reorder, when a later heading only matches before an earlier one', () => {
		const chunks = ['Chapter II.\nProse A.', 'Chapter I.\nProse B.'];
		const result = alignChapters(['Chapter I.', 'Chapter II.'], chunks);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		const problems = result.problems.join(' ');
		expect(problems).toContain('Chapter II.');
		expect(problems).toMatch(/out-of-order/);
	});

	it('rescues an unmatched first heading with firstHeadingImplicit, at index 0 only', () => {
		// "Chapter I." was dropped by cleaning's startAtMarker and never appears in the chunks.
		const chunks = ['Prose that begins the book.', 'Chapter II.\nMore prose.'];
		const result = alignChapters(['Chapter I.', 'Chapter II.'], chunks, {
			firstHeadingImplicit: true
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.chapters).toEqual([
			{ index: 0, title: 'Chapter I.', startChunkIndex: 0 },
			{ index: 1, title: 'Chapter II.', startChunkIndex: 1 }
		]);
	});

	it('firstHeadingImplicit does not rescue a later heading failing to match', () => {
		const chunks = ['Prose that begins the book.'];
		const result = alignChapters(['Chapter I.', 'Chapter II.'], chunks, {
			firstHeadingImplicit: true
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.problems.join(' ')).toContain('Chapter II.');
	});

	it('collects every problem in one run rather than stopping at the first', () => {
		const chunks = ['Some prose with nothing matching.'];
		const result = alignChapters(['Chapter I.', 'Chapter II.'], chunks);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.problems).toHaveLength(2);
	});

	it('matches folded typography: a curly-quote heading matches the folded prose', () => {
		const chunks = ['"Chapter One"\nProse.'];
		const result = alignChapters(['“Chapter One”'], chunks);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.chapters[0].title).toBe('"Chapter One"');
	});

	it('folds an em dash in a heading to match the folded prose', () => {
		const chunks = ['Book One - Chapter I.\nProse.'];
		const result = alignChapters(['Book One — Chapter I.'], chunks);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.chapters[0].title).toBe('Book One - Chapter I.');
	});

	it('defaults firstHeadingImplicit to false', () => {
		const chunks = ['Some prose.'];
		const result = alignChapters(['Chapter I.'], chunks, {});
		expect(result.ok).toBe(false);
	});
});
