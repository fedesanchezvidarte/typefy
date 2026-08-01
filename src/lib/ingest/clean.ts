import { normalizeCharacters } from './characters.js';

/**
 * Source text → clean paragraphs (spec #17 §4, ADR-0006).
 *
 * Raw public-domain sources carry a legal header and footer, hard-wrapped lines that are not
 * real line breaks, and typography no keyboard produces. This turns all of that into the only
 * shape the chunker wants: paragraphs separated by a blank line.
 *
 * Pure by construction (`lib-patterns` tier 1). It never rejects — unfoldable characters pass
 * through for `findDisallowed` to report, because the dry-run report exists precisely to show
 * what a source got wrong, and a cleaner that threw could not produce one.
 */

/** Per-book escape hatch for sources whose boilerplate does not match the usual markers. */
export interface CleaningOverrides {
	/** Everything up to and including the first line containing this is dropped. */
	startMarker?: string;
	/** Everything from the first line containing this onward is dropped. */
	endMarker?: string;
}

/**
 * Default boundary markers. Matched as substrings of a line rather than by exact equality:
 * the title is interpolated into the real thing, and the wording has drifted across decades
 * of Gutenberg releases (`THE PROJECT GUTENBERG EBOOK`, `THIS PROJECT GUTENBERG EBOOK`,
 * with and without spacing after the asterisks). Matching the invariant substring covers the
 * variants without a regex that has to anticipate them.
 */
const DEFAULT_START = 'START OF THE PROJECT GUTENBERG EBOOK';
const DEFAULT_START_ALT = 'START OF THIS PROJECT GUTENBERG EBOOK';
const DEFAULT_END = 'END OF THE PROJECT GUTENBERG EBOOK';
const DEFAULT_END_ALT = 'END OF THIS PROJECT GUTENBERG EBOOK';

/** Index of the first line containing any of `markers`, or -1. */
function findMarkerLine(lines: readonly string[], markers: readonly string[]): number {
	return lines.findIndex((line) => markers.some((marker) => line.includes(marker)));
}

/**
 * Drops the source's boilerplate.
 *
 * A missing marker is **not** an error: not every source is a Gutenberg text, and a text with
 * no header is simply all body. Failing here would make the common case of a hand-supplied
 * excerpt impossible.
 *
 * Only the **first** occurrence of each marker bounds the body, so a body that quotes its own
 * boilerplate does not truncate itself.
 */
function stripBoilerplate(lines: readonly string[], overrides: CleaningOverrides): string[] {
	const startMarkers = overrides.startMarker
		? [overrides.startMarker]
		: [DEFAULT_START, DEFAULT_START_ALT];
	const endMarkers = overrides.endMarker ? [overrides.endMarker] : [DEFAULT_END, DEFAULT_END_ALT];

	const start = findMarkerLine(lines, startMarkers);
	const from = start === -1 ? 0 : start + 1;

	const endOffset = findMarkerLine(lines.slice(from), endMarkers);
	const to = endOffset === -1 ? lines.length : from + endOffset;

	return lines.slice(from, to);
}

/**
 * Cleans raw source text into paragraphs separated by a blank line.
 *
 * Order is deliberate:
 *
 * 1. **Normalize first.** CRLF collapses to `\n` and Unicode line/paragraph separators become
 *    real newlines here — so line splitting below sees one representation of a line break
 *    rather than four, and a paragraph separator behaves as a boundary instead of vanishing
 *    into a space.
 * 2. **Strip boilerplate**, by line, while line structure still means something.
 * 3. **Group into paragraphs** on blank lines, then join each paragraph's hard-wrapped lines
 *    with a single space — the wrapping is an artefact of the source's line width, not
 *    authorial intent.
 * 4. **Collapse whitespace** within each paragraph and drop the ones left empty.
 *
 * Returns `''` when nothing survives; the caller decides whether that is an error.
 */
export function cleanSource(raw: string, overrides: CleaningOverrides = {}): string {
	const lines = stripBoilerplate(normalizeCharacters(raw).split('\n'), overrides);

	const paragraphs: string[] = [];
	let current: string[] = [];

	const flush = () => {
		if (current.length > 0) {
			paragraphs.push(current.join(' '));
			current = [];
		}
	};

	for (const line of lines) {
		if (line.trim() === '') {
			flush();
			continue;
		}
		current.push(line.trim());
	}
	flush();

	return paragraphs
		.map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
		.filter((paragraph) => paragraph !== '')
		.join('\n\n');
}
