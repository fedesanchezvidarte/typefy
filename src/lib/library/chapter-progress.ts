import type { ChapterProgress, ChapterSummary } from '$lib/types';

/**
 * Per-chapter page ranges and completion for the book detail screen (spec #34).
 *
 * Pure by construction (`lib-patterns` tier 1): no Supabase, no clock, no locale. It is the
 * executable form of ADR-0017's page-to-chapter attribution rule, which is a DOMAIN rule and
 * therefore belongs somewhere Vitest can hold it against arbitrary chapter shapes — the
 * argument that kept this out of a `SECURITY DEFINER` RPC.
 */

/**
 * Every chapter with the page range it owns and how much of it this user has completed.
 *
 * **The attribution rule (ADR-0017), implemented verbatim.** Chapter *i* owns chunk indices
 * `[start_i, start_{i+1})`, and the last chapter runs to `chunkCount`. A page belongs to the
 * chapter its FIRST character falls in, so a page spanning a boundary counts wholly to the
 * chapter that starts on it. Ranges are contiguous and non-overlapping, page counts sum to
 * `chunkCount`, and "how much of this chapter have I typed" stays a plain count — no
 * fractional weighting anywhere in the product.
 *
 * `firstPage` / `lastPage` are **1-based and inclusive** — page numbers, not chunk indices.
 * `startChunkIndex` rides along unchanged for callers that need to link into `/type/[slug]`.
 *
 * **`completedIndexes` must not be assumed sorted.** `getCompletedChunkIndexes` orders by
 * `chunk_id` because that is the only stable key `.range()` can partition on, so the indices
 * arrive in no meaningful order. Each one is therefore bucketed by binary search over the
 * chapter starts, never by a merge walk. Duplicates count once, and an index outside every
 * chapter — negative, at or beyond `chunkCount`, or in front matter preceding the first
 * chapter — is ignored rather than folded into the nearest chapter.
 *
 * On the **guest path** the caller passes `[]` and issues no progress query at all. That
 * yields the full chapter list with real page ranges and `pagesCompleted: 0` throughout, which
 * is why there is no signed-in branch in here.
 */
export function buildChapterProgress(
	chapters: readonly ChapterSummary[],
	chunkCount: number,
	completedIndexes: readonly number[]
): ChapterProgress[] {
	if (chapters.length === 0) {
		return [];
	}
	const total = Math.max(0, chunkCount);

	// Defensively ordered by start, never trusting the caller's array order, and always a copy
	// — `chapters` may be a value the route reuses. Same posture as `toTypeableText`'s sort.
	const ordered = [...chapters].sort(
		(a, b) => a.startChunkIndex - b.startChunkIndex || a.index - b.index
	);
	const starts = ordered.map((chapter) => chapter.startChunkIndex);

	const completedPerChapter = new Array<number>(ordered.length).fill(0);
	for (const index of new Set(completedIndexes)) {
		if (!Number.isInteger(index) || index < 0 || index >= total) {
			continue;
		}
		const owner = findOwner(starts, index);
		if (owner !== null) {
			completedPerChapter[owner] += 1;
		}
	}

	return ordered.map((chapter, i) => {
		const start = chapter.startChunkIndex;
		// The next chapter's start, or the end of the book — clamped so a chapter list that
		// runs past `chunkCount` yields an empty range rather than a negative page count.
		const rawEnd = i + 1 < ordered.length ? starts[i + 1] : total;
		const end = Math.max(start, Math.min(rawEnd, total));
		const pageCount = end - start;
		return {
			...chapter,
			firstPage: start + 1,
			lastPage: start + pageCount,
			pageCount,
			pagesCompleted: completedPerChapter[i]
		};
	});
}

/**
 * The position of the last chapter starting at or before `index`, or `null` when `index`
 * precedes every chapter (front matter, which belongs to no chapter).
 *
 * Binary search rather than a linear scan because don-quijote is 126 chapters against ~2,000
 * completed indices, and because a lookup — unlike a walk — cannot be broken by unsorted input.
 */
function findOwner(starts: readonly number[], index: number): number | null {
	if (index < starts[0]) {
		return null;
	}
	let low = 0;
	let high = starts.length - 1;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (starts[mid] <= index) {
			low = mid;
		} else {
			high = mid - 1;
		}
	}
	return low;
}
