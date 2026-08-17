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

/**
 * Per-book escape hatch for sources whose boilerplate does not match the usual markers.
 *
 * Two start forms, because the two jobs are genuinely different. `startMarker` names a
 * *delimiter* and drops its line — right for a boilerplate banner. `startAtMarker` names the
 * body's **first line** and keeps it — right for skipping front matter, where the line you
 * search for is the text itself. Using the exclusive form there would delete the novel's
 * opening sentence, which is exactly the kind of silent loss the committed report exists to
 * catch.
 */
export interface CleaningOverrides {
	/** Everything up to and including the first line containing this is dropped. */
	startMarker?: string;
	/** Everything before the first line containing this is dropped; that line is kept. */
	startAtMarker?: string;
	/** Everything from the first line containing this onward is dropped. */
	endMarker?: string;
	/**
	 * Drops a marginal verse number that the transcription moved to the head of a paragraph
	 * (spec #48). Off by default, and opt-in per book for the same reason `[Illustration…]`
	 * removal is narrow: a paragraph may legitimately open with a number.
	 */
	stripLeadingParagraphNumbers?: boolean;
	/**
	 * Drops a paragraph that opens with a bracketed footnote number, e.g. `[1] …` (spec #48).
	 * Off by default: bracketed asides occur in real prose and are the author's.
	 */
	stripFootnoteBlocks?: boolean;
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
	const endMarkers = overrides.endMarker ? [overrides.endMarker] : [DEFAULT_END, DEFAULT_END_ALT];

	let from: number;
	if (overrides.startAtMarker) {
		// Inclusive: the matched line is the body's first line, so keep it.
		const at = findMarkerLine(lines, [overrides.startAtMarker]);
		from = at === -1 ? 0 : at;
	} else {
		const startMarkers = overrides.startMarker
			? [overrides.startMarker]
			: [DEFAULT_START, DEFAULT_START_ALT];
		const start = findMarkerLine(lines, startMarkers);
		from = start === -1 ? 0 : start + 1;
	}

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
/**
 * Gutenberg's plain-text editions carry markup that is not part of the book:
 *
 * - `[Illustration: ...]` captions, which may span several lines and describe a plate the
 *   text edition does not have. In Pride and Prejudice these were also the sole source of the
 *   decorative middle-dot characters the allowed-set check rejected.
 * - `_underscores_` standing in for italics. The underscore is printable ASCII, so the
 *   allowed-set check waves it through — but a typist would have to reproduce a typesetting
 *   convention rather than the prose.
 *
 * Only `[Illustration...]` is removed, never brackets in general: bracketed asides occur in
 * real prose and are the author's.
 *
 * The Spanish spelling is matched too, because Gutenberg's Spanish transcriptions use it and
 * the marker is the same artefact under a different word (spec #48 found 66 of them in La
 * Odisea, whose captions also span a blank line and would otherwise have become chunks of
 * their own). Unconditional rather than opt-in, unlike the two options below: this is a
 * transcription marker with no prose reading, exactly as the English spelling is. It is also
 * output-neutral for the existing catalog — the string occurs in one other cached source
 * (`niebla`) and only outside that book's cleaned bounds.
 */
const ILLUSTRATION = /\[(?:Illustration|Ilustración)[^\]]*\]/gi;

/**
 * A marginal verse number the transcription moved inline, e.g. `1 Háblame, Musa, …`
 * (`stripLeadingParagraphNumbers`, spec #48).
 *
 * The shape is deliberately narrow: digits, whitespace, then **the start of a sentence** — an
 * upper-case letter, an opening inverted mark, or the quote that dialogue begins on. That is
 * what separates a number the printer put in the margin from a number the author wrote, since
 * prose that genuinely opens with a figure continues in lower case (`1605 marcó el comienzo…`).
 * All 1,244 affected paragraphs in La Odisea match it and none of its 24 cantos contains a
 * counter-example.
 *
 * The quote is `"` and not `«`, because this runs after `normalizeCharacters` has already folded
 * the guillemets the Spanish source actually uses.
 */
const LEADING_PARAGRAPH_NUMBER = /^\d+\s+(?=[\p{Lu}"¡¿])/u;

/** A translator's footnote block, e.g. `[1] Ὀδυσσάμενος …` (`stripFootnoteBlocks`, spec #48). */
const FOOTNOTE_BLOCK = /^\[\d+\]/;

function stripGutenbergMarkup(text: string): string {
	return text.replace(ILLUSTRATION, '').replaceAll('_', '');
}

export function cleanSource(raw: string, overrides: CleaningOverrides = {}): string {
	const bounded = stripBoilerplate(normalizeCharacters(raw).split('\n'), overrides).join('\n');
	// Markup is stripped AFTER the boilerplate bounds are found (the markers are line-shaped)
	// and BEFORE paragraphs are grouped, so a caption spanning lines is gone before the blank
	// line either side of it would have made it a paragraph of its own.
	const lines = stripGutenbergMarkup(bounded).split('\n');

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

	// Both per-book rules act on the ASSEMBLED paragraph, after its hard-wrapped lines are
	// rejoined and its whitespace collapsed: "at the start of a paragraph" is only a well-defined
	// position once the paragraph exists, and a rule applied line-by-line would strip a number
	// from every wrapped line rather than from the one the printer put in the margin.
	//
	// Footnote blocks go first. They are dropped whole, so testing them before the number rule
	// keeps the number rule from having to reason about text that is on its way out.
	return (
		paragraphs
			.map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
			.filter((paragraph) => !(overrides.stripFootnoteBlocks && FOOTNOTE_BLOCK.test(paragraph)))
			.map((paragraph) =>
				overrides.stripLeadingParagraphNumbers
					? paragraph.replace(LEADING_PARAGRAPH_NUMBER, '')
					: paragraph
			)
			// Filtered LAST as well as implied above: a paragraph that was nothing but its marginal
			// number is now empty, and an empty paragraph must never reach the chunker.
			.filter((paragraph) => paragraph !== '')
			.join('\n\n')
	);
}
