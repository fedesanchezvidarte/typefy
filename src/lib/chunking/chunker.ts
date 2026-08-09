import { MAX_CHARS, MAX_LINES, lineCost } from './measure.js';

/**
 * Paragraph chunking under a dual budget (ADR-0005 as amended by spec #32).
 *
 * A chunk is the atomic unit of typeable text and of progress, and since 5b it is a **page**:
 * several paragraphs joined by a real `\n`, sized to a screenful. Splitting is by **paragraph,
 * grouped up to a budget, never cutting a sentence** — a chunk that ends mid-sentence ruins
 * the reading half of "writing and reading at the same time", which is the product.
 *
 * **The budget is two numbers, not one.** Characters alone would stack forty lines of dialogue
 * onto one screen; lines alone would let dense prose run past the character backstop. A chunk
 * closes on whichever binds first (`measure.ts`).
 *
 * Pure by construction (`lib-patterns` tier 1): no IO, no clock, no DOM, deterministic. That
 * is a contract rather than a nicety — chunk boundaries are the progress key, so they must be
 * byte-identical on every device, in every font, at every viewport width. The line budget is
 * therefore an ESTIMATE against a fixed nominal measure and never a measurement; the
 * teleprompter's DOM measurement produces pixels and can never reach back here. Both claims
 * are asserted by test in `chunker.spec.ts`, not left to convention.
 *
 * Input is cleaned text — paragraphs separated by a blank line, as `ingest/clean.ts` emits.
 * Output chunks carry a single `\n` between paragraphs, never at either end and never doubled.
 */

/**
 * The two bounds a page is held within. Supersedes the pre-5b `SizeTarget` (`{min, max}`
 * characters): there is no minimum any more, because the line budget already stops a page
 * being trivially short and a hard minimum is what produced the old stub-absorption special
 * cases.
 */
export interface PageBudget {
	maxChars: number;
	maxLines: number;
}

/** The shipped budget: `measure.ts`'s constants, which the typing surface answers to. */
export const DEFAULT_BUDGET: PageBudget = { maxChars: MAX_CHARS, maxLines: MAX_LINES };

/**
 * Abbreviations whose trailing period is not a sentence end. Lower-cased for comparison.
 *
 * Not exhaustive and cannot be: this is the pragmatic list for English and Spanish prose of
 * the era the catalog draws on. A false negative merely splits a chunk one sentence early —
 * mildly worse rhythm. There is no false positive that damages text, because splitting only
 * ever happens at a boundary that already looked like a sentence end.
 */
const ABBREVIATIONS = new Set([
	// English courtesy titles and common abbreviations
	'mr',
	'mrs',
	'ms',
	'dr',
	'prof',
	'st',
	'rev',
	'hon',
	'jr',
	'sr',
	'capt',
	'col',
	'gen',
	'lt',
	'sgt',
	'vs',
	'etc',
	'inc',
	'ltd',
	'co',
	'no',
	'vol',
	'fig',
	'cf',
	// Spanish courtesy titles and abbreviations
	'sra',
	'srta',
	'dna',
	'ud',
	'uds',
	'vd',
	'vds',
	'pag',
	'num',
	'ej'
]);

/** Sentence-ending punctuation, optionally wrapped up by a closing quote or bracket. */
const SENTENCE_END = /([.!?]["')\]]*)\s+/g;

/**
 * Splits a paragraph into sentences.
 *
 * A boundary is punctuation followed by whitespace, rejected when:
 *
 * - the token before the period is a known abbreviation (`Mr. Bennet` is one sentence);
 * - the period is part of an ellipsis left by normalization (`waited... and` — folding `…`
 *   to `...` would otherwise manufacture two spurious boundaries in every hesitation);
 * - the sentence would be left open by an unclosed inverted Spanish mark, since `¿` and `¡`
 *   open a question or exclamation that only its closing partner ends.
 *
 * Sentences keep their trailing punctuation and carry no surrounding whitespace.
 */
function splitSentences(paragraph: string): string[] {
	const sentences: string[] = [];
	let start = 0;

	SENTENCE_END.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = SENTENCE_END.exec(paragraph)) !== null) {
		const end = match.index + match[1].length;
		const candidate = paragraph.slice(start, end);

		if (
			endsWithAbbreviation(candidate) ||
			isEllipsisBoundary(paragraph, match.index) ||
			hasUnclosedInverted(candidate)
		) {
			continue;
		}

		sentences.push(candidate.trim());
		start = SENTENCE_END.lastIndex;
	}

	const tail = paragraph.slice(start).trim();
	if (tail !== '') {
		sentences.push(tail);
	}
	return sentences;
}

/** True when the candidate's final word, minus its period, is a known abbreviation. */
function endsWithAbbreviation(candidate: string): boolean {
	const match = /([\p{L}]+)\.$/u.exec(candidate);
	return match !== null && ABBREVIATIONS.has(match[1].toLowerCase());
}

/** True when the period at `index` is the last of a run of periods (`...`). */
function isEllipsisBoundary(paragraph: string, index: number): boolean {
	return paragraph[index] === '.' && paragraph[index - 1] === '.';
}

/** True when an inverted Spanish mark is still open — the sentence has not really ended. */
function hasUnclosedInverted(candidate: string): boolean {
	const opensQuestion = count(candidate, '¿') > count(candidate, '?');
	const opensExclamation = count(candidate, '¡') > count(candidate, '!');
	return opensQuestion || opensExclamation;
}

function count(text: string, character: string): number {
	let total = 0;
	for (const current of text) {
		if (current === character) total += 1;
	}
	return total;
}

/**
 * A chunk's cost in estimated rendered lines: the sum over its paragraphs.
 *
 * Splitting on `\n` recovers exactly the paragraphs that were appended, because a chunk holds
 * single newlines and nothing else — which is why the budget can be evaluated against a
 * candidate STRING rather than against bookkeeping kept alongside it. One representation, so
 * the accounting cannot drift from the text it describes.
 */
function chunkLines(text: string): number {
	if (text === '') return 0;
	let total = 0;
	for (const paragraph of text.split('\n')) {
		total += lineCost(paragraph);
	}
	return total;
}

/**
 * Cleaned text → pages.
 *
 * **Split-then-group per paragraph**, which is the restructure spec #32 asks for: the pre-5b
 * pipeline flat-mapped every paragraph into sentences before grouping, which destroyed
 * paragraph identity and made a paragraph-preserving join impossible to express at all.
 *
 * The loop is greedy and has exactly three cases per source paragraph:
 *
 * 1. **It fits on a page of its own** — append it to the open page if both budgets still hold,
 *    otherwise close and open a new page with it. Paragraphs join with a single `\n`.
 * 2. **It is over budget and has more than one sentence** — its sentences fill the CURRENT
 *    page and spill onto the next, joined by the space that separated them. Filling the
 *    current page rather than starting a fresh one is what retires the old stub-absorption
 *    special case: a chapter heading followed by a 2,700-character paragraph now opens the
 *    page that paragraph fills, instead of being pushed out alone.
 * 3. **It is one sentence longer than the budget** — emitted whole. An over-long page is bad;
 *    an amputated sentence is worse (ADR-0005).
 *
 * A sentence that spills onto the next page opens it WITHOUT a `\n`, so a paragraph split
 * across two pages never gains a paragraph break the author did not write.
 *
 * **No trailing-stub merge, deliberately** (the pre-5b rule is dropped rather than ported).
 * Under a dual budget it would be dead code: a page closes only because characters or lines
 * bound it, so merging a one-line tail into the previous page necessarily overruns whichever
 * one did. A short final page is the honest outcome when the text simply ends there.
 *
 * Character budgets are measured in UTF-16 units, matching `chunks.char_count`; the line
 * budget is measured in code points, matching what the surface renders.
 */
export function chunkParagraphs(text: string, budget: PageBudget = DEFAULT_BUDGET): string[] {
	// Any run of newlines is a paragraph boundary. `cleanSource` emits exactly `\n\n` and no
	// paragraph-internal newline, so this is equivalent on real input — and on hand-written
	// input it is what makes "a chunk never contains a newline it did not put there" structural.
	const paragraphs = text
		.split(/\n+/)
		.map((paragraph) => paragraph.trim())
		.filter((paragraph) => paragraph !== '');

	const chunks: string[] = [];
	let current = '';

	const fits = (candidate: string): boolean =>
		candidate.length <= budget.maxChars && chunkLines(candidate) <= budget.maxLines;

	const close = (): void => {
		if (current !== '') {
			chunks.push(current);
			current = '';
		}
	};

	/** Starts a new paragraph on the open page, or on a fresh one when it will not fit. */
	const pushParagraph = (piece: string): void => {
		if (current === '') {
			// Even an over-budget piece goes in: this is where a single monstrous sentence is
			// emitted whole rather than amputated.
			current = piece;
			return;
		}
		const candidate = `${current}\n${piece}`;
		if (fits(candidate)) {
			current = candidate;
			return;
		}
		close();
		current = piece;
	};

	/** Continues the open paragraph with its next sentence, spilling onto a new page if full. */
	const pushSentence = (sentence: string): void => {
		const candidate = `${current} ${sentence}`;
		if (fits(candidate)) {
			current = candidate;
			return;
		}
		close();
		// No `\n`: the next page opens mid-paragraph, which is what it really is.
		current = sentence;
	};

	for (const paragraph of paragraphs) {
		if (paragraph.length <= budget.maxChars && lineCost(paragraph) <= budget.maxLines) {
			pushParagraph(paragraph);
			continue;
		}
		const sentences = splitSentences(paragraph);
		if (sentences.length <= 1) {
			pushParagraph(paragraph);
			continue;
		}
		sentences.forEach((sentence, i) => {
			if (i === 0) pushParagraph(sentence);
			else pushSentence(sentence);
		});
	}
	close();

	return chunks;
}
