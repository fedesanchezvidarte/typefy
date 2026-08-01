/**
 * Paragraph chunking with a size target (ADR-0005, spec #17 §5).
 *
 * A chunk is the atomic unit of typeable text and of progress. Splitting is by **paragraph,
 * grouped up to a size target, never cutting a sentence** — a chunk that ends mid-sentence
 * ruins the reading half of "writing and reading at the same time", which is the product.
 *
 * Pure by construction (`lib-patterns` tier 1): no IO, no clock, deterministic.
 *
 * Input is cleaned text — paragraphs separated by a blank line, as `ingest/clean.ts` emits.
 * Output chunks contain **no newline**: every chunk in the database today is a single flow,
 * and the typing surface has never rendered a line break inside a passage.
 */

/** Size target in characters. Soft on both ends — see `chunkParagraphs`. */
export interface SizeTarget {
	min: number;
	max: number;
}

/**
 * ADR-0005's ~400-600 characters. Both bounds are soft: the hand-chunked Phase 1 fixtures
 * run from 377 to 683, and that is the intended rhythm rather than a violation of it.
 */
export const DEFAULT_TARGET: SizeTarget = { min: 400, max: 600 };

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
 * Cleaned text → chunks.
 *
 * Greedy: units (sentences, in paragraph order) accumulate into the current chunk while it
 * stays under `max`; a unit that would overrun starts a new one. Two deliberate asymmetries:
 *
 * - **A single unit longer than `max` is emitted whole.** An over-long chunk is bad; an
 *   amputated sentence is worse (ADR-0005).
 * - **A trailing remainder below `min` merges back into the previous chunk** rather than
 *   becoming a stub. Finishing a book on a nine-character passage reads as a bug.
 */
export function chunkParagraphs(text: string, target: SizeTarget = DEFAULT_TARGET): string[] {
	const units = text
		.split(/\n\s*\n/)
		.map((paragraph) => paragraph.trim())
		.filter((paragraph) => paragraph !== '')
		.flatMap(splitSentences);

	const chunks: string[] = [];
	let current = '';

	for (const unit of units) {
		if (current === '') {
			current = unit;
			continue;
		}
		if (current.length + 1 + unit.length <= target.max) {
			current = `${current} ${unit}`;
			continue;
		}
		// The unit does not fit. Normally `current` is emitted and the unit starts the next
		// chunk — but when `current` is a stub and the unit is oversized anyway, that produces
		// a stub passage *followed by* an over-long one, which is worse on both counts. Real
		// case: Don Quijote's chapter headings, where a 7-character "Capítulo" was pushed out
		// alone because the sentence after it runs to 2,700 characters. Absorb the stub.
		if (current.length < target.min && unit.length > target.max) {
			current = `${current} ${unit}`;
			continue;
		}
		chunks.push(current);
		current = unit;
	}
	if (current !== '') {
		chunks.push(current);
	}

	// A short tail is better attached than left standing alone — but only when the merge
	// still fits. An unbounded merge turns a 575-character chunk plus a 287-character tail
	// into one 862-character passage, which overruns the target far worse than the stub it
	// was avoiding. A tail that cannot fit stays a short final passage: mildly untidy, and
	// the honest outcome when the text simply ends there.
	if (chunks.length > 1) {
		const last = chunks[chunks.length - 1];
		const previous = chunks[chunks.length - 2];
		if (last.length < target.min && previous.length + 1 + last.length <= target.max) {
			chunks.splice(chunks.length - 2, 2, `${previous} ${last}`);
		}
	}

	return chunks;
}
