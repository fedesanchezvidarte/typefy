import { describe, expect, it } from 'vitest';
import { activeChapter, buildChapterProgress } from './chapter-progress.js';
import type { ChapterSummary } from '$lib/types';

function chapter(index: number, startChunkIndex: number): ChapterSummary {
	return { index, title: `Chapter ${index + 1}`, startChunkIndex };
}

/** `[firstPage, lastPage, pageCount, pagesCompleted]` — the four numbers the UI renders. */
function shape(chapters: ReturnType<typeof buildChapterProgress>) {
	return chapters.map((c) => [c.firstPage, c.lastPage, c.pageCount, c.pagesCompleted]);
}

describe('buildChapterProgress', () => {
	describe('ADR-0017 attribution — chapter i owns [start_i, start_{i+1})', () => {
		it('gives each chapter a contiguous, non-overlapping 1-based page range', () => {
			// Chapter 0 owns chunks 0–3, chapter 1 owns 4–9, chapter 2 owns 10–11.
			const result = buildChapterProgress([chapter(0, 0), chapter(1, 4), chapter(2, 10)], 12, []);
			expect(shape(result)).toEqual([
				[1, 4, 4, 0],
				[5, 10, 6, 0],
				[11, 12, 2, 0]
			]);
		});

		it('runs the last chapter to chunkCount, not to its own start', () => {
			const result = buildChapterProgress([chapter(0, 0), chapter(1, 2)], 7, []);
			expect(result[1]).toMatchObject({ firstPage: 3, lastPage: 7, pageCount: 5 });
		});

		it('handles a chapter starting at chunk index 0 — page 1, not page 0', () => {
			const [first] = buildChapterProgress([chapter(0, 0)], 3, []);
			expect(first.firstPage).toBe(1);
			expect(first.startChunkIndex).toBe(0);
		});

		it('handles a single chapter spanning the whole book', () => {
			expect(shape(buildChapterProgress([chapter(0, 0)], 5, [0, 1, 2]))).toEqual([[1, 5, 5, 3]]);
		});

		it('handles a one-page chapter, where lastPage equals firstPage', () => {
			const result = buildChapterProgress([chapter(0, 0), chapter(1, 1)], 2, []);
			expect(shape(result)).toEqual([
				[1, 1, 1, 0],
				[2, 2, 1, 0]
			]);
		});

		it('returns an empty list for a book with no chapters at all', () => {
			// El Buscón-class books, and any book whose HTML carried no headings: the screen
			// renders without a chapter list rather than erroring.
			expect(buildChapterProgress([], 40, [0, 1, 2])).toEqual([]);
		});

		it('carries index and title through untouched', () => {
			const [first, second] = buildChapterProgress(
				[chapter(0, 0), { index: 1, title: 'Del donoso escrutinio', startChunkIndex: 3 }],
				5,
				[]
			);
			expect(first).toMatchObject({ index: 0, title: 'Chapter 1', startChunkIndex: 0 });
			expect(second).toMatchObject({
				index: 1,
				title: 'Del donoso escrutinio',
				startChunkIndex: 3
			});
		});
	});

	describe('a page spanning a chapter boundary counts wholly to the chapter it starts in', () => {
		it('never splits a page between two chapters', () => {
			// Chunk 4 is where chapter 1 begins; whatever prose of chapter 0 trails into it is
			// counted to chapter 1. Page counts therefore always sum to chunkCount exactly.
			const result = buildChapterProgress([chapter(0, 0), chapter(1, 4), chapter(2, 9)], 15, []);
			expect(result.reduce((sum, c) => sum + c.pageCount, 0)).toBe(15);
			expect(result.map((c) => c.firstPage)).toEqual([1, 5, 10]);
		});

		it('attributes a completed boundary page to the chapter that starts on it', () => {
			const result = buildChapterProgress([chapter(0, 0), chapter(1, 4)], 8, [4]);
			expect(result.map((c) => c.pagesCompleted)).toEqual([0, 1]);
		});
	});

	describe('completed indices are bucketed by lookup, never by assuming order', () => {
		it('counts a shuffled completed set correctly', () => {
			// `getCompletedChunkIndexes` orders by `chunk_id` for a stable `.range()` partition,
			// so the indices arrive in NO meaningful order. A merge walk would silently
			// under-count here.
			const chapters = [chapter(0, 0), chapter(1, 4), chapter(2, 10)];
			const shuffled = [11, 1, 7, 0, 10, 5, 3];
			expect(buildChapterProgress(chapters, 12, shuffled).map((c) => c.pagesCompleted)).toEqual([
				3, 2, 2
			]);
		});

		it('produces the same result whatever order the indices arrive in', () => {
			const chapters = [chapter(0, 0), chapter(1, 3), chapter(2, 8)];
			const ascending = [0, 1, 2, 3, 4, 8, 9];
			const descending = [...ascending].reverse();
			const jumbled = [8, 2, 0, 9, 4, 1, 3];
			const expected = shape(buildChapterProgress(chapters, 12, ascending));
			expect(shape(buildChapterProgress(chapters, 12, descending))).toEqual(expected);
			expect(shape(buildChapterProgress(chapters, 12, jumbled))).toEqual(expected);
		});

		it('counts a repeated index once', () => {
			const result = buildChapterProgress([chapter(0, 0)], 5, [2, 2, 2]);
			expect(result[0].pagesCompleted).toBe(1);
		});

		it('never reports more completed pages than the chapter has', () => {
			const result = buildChapterProgress([chapter(0, 0), chapter(1, 2)], 4, [0, 1, 2, 3]);
			expect(result.map((c) => c.pagesCompleted)).toEqual([2, 2]);
			expect(result.every((c) => c.pagesCompleted <= c.pageCount)).toBe(true);
		});
	});

	describe('out-of-range indices are ignored rather than misattributed', () => {
		it('ignores an index at or beyond chunkCount', () => {
			// A stale completion from before a re-ingest shrank the book.
			const result = buildChapterProgress([chapter(0, 0), chapter(1, 3)], 6, [1, 6, 99]);
			expect(result.map((c) => c.pagesCompleted)).toEqual([1, 0]);
		});

		it('ignores a negative index', () => {
			const result = buildChapterProgress([chapter(0, 0)], 4, [-1, 0]);
			expect(result[0].pagesCompleted).toBe(1);
		});

		it('ignores pages before the first chapter starts', () => {
			// Front matter that aligned ahead of chapter 0 belongs to no chapter and is
			// counted to none of them — it is not silently folded into chapter 1.
			const result = buildChapterProgress([chapter(0, 2)], 6, [0, 1, 2]);
			expect(result[0]).toMatchObject({
				firstPage: 3,
				lastPage: 6,
				pageCount: 4,
				pagesCompleted: 1
			});
		});

		it('clamps a chapter list that runs past chunkCount to an empty range', () => {
			// Defensive only — ingestion aligns chapters against the chunks it just wrote. An
			// empty range must still be a well-formed row, never a negative page count.
			const result = buildChapterProgress([chapter(0, 0), chapter(1, 9)], 4, [0, 1]);
			expect(result[0]).toMatchObject({
				firstPage: 1,
				lastPage: 4,
				pageCount: 4,
				pagesCompleted: 2
			});
			expect(result[1]).toMatchObject({ pageCount: 0, pagesCompleted: 0 });
			expect(result[1].pageCount).toBeGreaterThanOrEqual(0);
		});
	});

	describe('the guest path', () => {
		it('yields full page ranges with pagesCompleted 0 for an empty completed set', () => {
			// The route calls this with `[]` for a signed-out visitor and issues no progress
			// query at all. The chapter list must still render in full — no branching here.
			const result = buildChapterProgress([chapter(0, 0), chapter(1, 4), chapter(2, 10)], 12, []);
			expect(shape(result)).toEqual([
				[1, 4, 4, 0],
				[5, 10, 6, 0],
				[11, 12, 2, 0]
			]);
		});
	});

	describe('input handling', () => {
		it('orders defensively by startChunkIndex rather than trusting the caller', () => {
			const result = buildChapterProgress([chapter(2, 10), chapter(0, 0), chapter(1, 4)], 12, []);
			expect(result.map((c) => c.index)).toEqual([0, 1, 2]);
			expect(shape(result)).toEqual([
				[1, 4, 4, 0],
				[5, 10, 6, 0],
				[11, 12, 2, 0]
			]);
		});

		it('does not mutate the chapters it was given', () => {
			const chapters = [chapter(2, 10), chapter(0, 0), chapter(1, 4)];
			const before = chapters.map((c) => c.index);
			buildChapterProgress(chapters, 12, []);
			expect(chapters.map((c) => c.index)).toEqual(before);
		});
	});
});

describe('activeChapter', () => {
	const chapters = [chapter(0, 2), chapter(1, 6), chapter(2, 11)];

	it('names the chapter a page falls in', () => {
		expect(activeChapter(chapters, 2)?.index).toBe(0);
		expect(activeChapter(chapters, 5)?.index).toBe(0);
		expect(activeChapter(chapters, 6)?.index).toBe(1);
		expect(activeChapter(chapters, 40)?.index).toBe(2);
	});

	it('names a page that SPANS a boundary by the chapter it starts in', () => {
		// Page 6 begins inside chapter 1 and may run into chapter 2's first characters. The
		// header must agree with the detail screen's ranges, which attribute it to chapter 1.
		expect(activeChapter(chapters, 5)?.index).toBe(0);
	});

	it('returns null for front matter preceding the first chapter', () => {
		expect(activeChapter(chapters, 0)).toBeNull();
		expect(activeChapter(chapters, 1)).toBeNull();
	});

	it('returns null for a book with no chapters, and for a nonsensical index', () => {
		expect(activeChapter([], 3)).toBeNull();
		expect(activeChapter(chapters, -1)).toBeNull();
		expect(activeChapter(chapters, 1.5)).toBeNull();
	});

	it('orders defensively and does not mutate its input', () => {
		const unordered = [chapter(2, 11), chapter(0, 2), chapter(1, 6)];
		const before = unordered.map((c) => c.index);
		expect(activeChapter(unordered, 7)?.index).toBe(1);
		expect(unordered.map((c) => c.index)).toEqual(before);
	});
});
