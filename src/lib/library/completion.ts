import type { TypeableTextSummary } from '$lib/types';

/**
 * Book-lifetime completion as a percentage (spec #12, extracted in #19).
 *
 * One line, and it earns its own module: the grid and the continue-reading section both render
 * it, and inlining it twice would duplicate the divide-by-zero guard along with it. Extracting
 * it is also what finally gives that guard a test — `books.chunk_count` defaults to 0, and a
 * book seeded with no chunks rendered `NaN%`.
 */
export function completionPercent(
	book: Pick<TypeableTextSummary, 'chunkCount'>,
	chunksCompleted: number
): number {
	if (book.chunkCount <= 0) {
		return 0;
	}
	return Math.round((100 * chunksCompleted) / book.chunkCount);
}
