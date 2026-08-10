import { normalizeCharacters } from './characters.js';

/**
 * The chapter aligner (spec #33 §1 and §3): heading titles → chunk indices.
 *
 * `chunkParagraphs` (`src/lib/chunking/chunker.ts`) groups paragraphs into chunks joined by a
 * single `\n`, and only ever splits a paragraph across a chunk boundary via `pushSentence` —
 * which never applies to a heading's own paragraph, since every real chapter heading in this
 * catalog is short enough to go in whole via `pushParagraph`. So a heading's paragraph is
 * structurally guaranteed to appear as an exact, `\n`-delimited segment somewhere in the
 * `chunks` array, and alignment needs no paragraph-index tracking and no changes to the
 * chunker: flatten every chunk's `\n`-delimited segments into one ordered sequence and search
 * it for each heading's title, in turn, with a monotonic cursor.
 *
 * Pure by construction (`lib-patterns` tier 1): no network, no filesystem, no clock.
 */

/** One aligned chapter: a title and the chunk index its paragraph starts in. */
export interface AlignedChapter {
	/** 0-based, in the order given. */
	index: number;
	/** Folded through `normalizeCharacters`, whitespace-collapsed. */
	title: string;
	startChunkIndex: number;
}

export interface AlignChaptersOptions {
	/**
	 * True when the FIRST heading's own paragraph is structurally excluded from the cleaned
	 * text by `cleaning.startAtMarker` — the general, expected consequence of skipping straight
	 * to the book's opening prose sentence. When true, a first heading (index 0) that matches no
	 * paragraph at all is not an error: it is recorded at chunk 0, and the cursor does not
	 * advance (nothing was actually consumed). Default `false`.
	 */
	firstHeadingImplicit?: boolean;
}

export type AlignChaptersResult =
	{ ok: true; chapters: AlignedChapter[] } | { ok: false; problems: string[] };

/** One `\n`-delimited segment of the flattened chunk sequence, with the chunk it came from. */
interface FlatSegment {
	chunkIndex: number;
	text: string;
}

function flatten(chunks: readonly string[]): FlatSegment[] {
	const segments: FlatSegment[] = [];
	chunks.forEach((chunk, chunkIndex) => {
		for (const text of chunk.split('\n')) {
			segments.push({ chunkIndex, text });
		}
	});
	return segments;
}

/** Folds a heading title through the same normalisation the cleaned prose went through. */
function foldTitle(rawTitle: string): string {
	return normalizeCharacters(rawTitle).replace(/\s+/g, ' ').trim();
}

/** Every position in `segments` whose text equals `title`, within `[from, segments.length)`. */
function matchesFrom(segments: readonly FlatSegment[], title: string, from: number): number[] {
	const positions: number[] = [];
	for (let position = from; position < segments.length; position += 1) {
		if (segments[position].text === title) {
			positions.push(position);
		}
	}
	return positions;
}

/**
 * Heading titles + chunks → aligned chapters, or every alignment problem found.
 *
 * Collects every problem across all headings rather than stopping at the first (mirrors
 * `parseManifest`'s "collect every problem" convention): a failed heading never advances the
 * cursor, so continuing is safe and shows an operator every bad heading in one run.
 */
export function alignChapters(
	headingTitles: readonly string[],
	chunks: readonly string[],
	options: AlignChaptersOptions = {}
): AlignChaptersResult {
	const firstHeadingImplicit = options.firstHeadingImplicit ?? false;
	const segments = flatten(chunks);

	const problems: string[] = [];
	const chapters: AlignedChapter[] = [];
	let cursor = 0;

	headingTitles.forEach((rawTitle, headingIndex) => {
		const title = foldTitle(rawTitle);
		const fromCursor = matchesFrom(segments, title, cursor);

		if (fromCursor.length === 1) {
			const position = fromCursor[0];
			chapters.push({
				index: chapters.length,
				title,
				startChunkIndex: segments[position].chunkIndex
			});
			cursor = position + 1;
			return;
		}

		if (fromCursor.length > 1) {
			problems.push(
				`"${title}": ambiguous-match — matched ${fromCursor.length} times from the current position onward.`
			);
			return;
		}

		// Zero matches from the cursor onward.
		if (headingIndex === 0 && firstHeadingImplicit) {
			chapters.push({ index: chapters.length, title, startChunkIndex: 0 });
			// Cursor is left where it was: nothing was actually consumed.
			return;
		}

		const wholeSequence = matchesFrom(segments, title, 0);
		if (wholeSequence.length > 0) {
			problems.push(
				`"${title}": out-of-order — matched only before the current alignment position, ` +
					`after an earlier heading already consumed that part of the text.`
			);
		} else {
			problems.push(`"${title}": no-match — matched no chunk paragraph.`);
		}
	});

	return problems.length > 0 ? { ok: false, problems } : { ok: true, chapters };
}
