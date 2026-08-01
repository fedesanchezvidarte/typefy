/**
 * The typeable character set, and the folding that gets source text into it (spec #17 §4,
 * ADR-0013).
 *
 * Raw public-domain sources are full of typography no keyboard produces: curly quotes, em
 * dashes, ellipsis characters, non-breaking spaces. The engine's comparison is exact
 * (ADR-0004) and a chunk completes only when no character is `pending` or `incorrect` — so a
 * single unreachable glyph makes a passage impossible to finish and silently walls off the
 * rest of the book. Folding at ingestion is what lets the engine stay exact and rule-free.
 *
 * Pure by construction (`lib-patterns` tier 1): no DOM, no Supabase, no SvelteKit, no clock.
 *
 * The allowed set is what an English or Spanish keyboard actually produces: printable ASCII,
 * newline, and the Spanish letters and inverted marks. It is deliberately a *description* of
 * what the Phase 1 fixtures already contain — hand-chunking normalised typography away
 * without anyone writing it down — not a new constraint invented here.
 */

/** Spanish letters and marks that survive folding, beyond printable ASCII. */
const SPANISH = 'áéíóúüñÁÉÍÓÚÜÑ¿¡';

/**
 * Characters folded to a typeable equivalent. Ordered by what they are, not by code point,
 * because this table is read by humans deciding whether a fold is right.
 */
const FOLDINGS = new Map<string, string>([
	// Double quotes: curly, low-9, reversed, and both guillemets (Spanish sources use « »).
	['“', '"'],
	['”', '"'],
	['„', '"'],
	['‟', '"'],
	['«', '"'],
	['»', '"'],
	// Single quotes and apostrophes.
	['‘', "'"],
	['’', "'"],
	['‚', "'"],
	['‛', "'"],
	// Dashes: em, en, figure, horizontal bar. A hyphen is the only one on a keyboard.
	['—', '-'],
	['–', '-'],
	['‒', '-'],
	['―', '-'],
	// Ellipsis expands rather than folds — three periods is what a typist writes.
	['…', '...']
]);

/**
 * Exotic whitespace and invisibles, by code point. Written as escapes rather than literals:
 * a literal no-break space in this table is indistinguishable from a plain space on review,
 * and a formatter or a copy-paste can replace one without leaving a trace.
 *
 * Spaces fold to a plain space; invisibles are REMOVED rather than spaced, because a soft
 * hyphen sits inside a word and spacing it would split the word in two.
 */
const SPACE_CODE_POINTS = [
	0x00a0, // no-break space
	0x1680, // ogham space mark
	0x2000,
	0x2001,
	0x2002,
	0x2003,
	0x2004,
	0x2005,
	0x2006, // en/em quad through six-per-em
	0x2007, // figure space
	0x2008,
	0x2009,
	0x200a, // punctuation, thin, hair
	0x202f, // narrow no-break space
	0x205f, // medium mathematical space
	0x3000 // ideographic space
] as const;

const REMOVED_CODE_POINTS = [
	0xfeff, // byte-order mark / zero-width no-break space
	0x200b, // zero-width space
	0x200c, // zero-width non-joiner
	0x200d, // zero-width joiner
	0x00ad // soft hyphen
] as const;

const LINE_BREAK_CODE_POINTS = [
	0x2028, // line separator
	0x2029 // paragraph separator
] as const;

for (const code of SPACE_CODE_POINTS) FOLDINGS.set(String.fromCodePoint(code), ' ');
for (const code of REMOVED_CODE_POINTS) FOLDINGS.set(String.fromCodePoint(code), '');
for (const code of LINE_BREAK_CODE_POINTS) FOLDINGS.set(String.fromCodePoint(code), '\n');

/**
 * True when a single character may appear in stored typeable text.
 *
 * Printable ASCII (U+0020..U+007E) plus newline plus the Spanish set. Notably **not** the
 * tab: it is whitespace the cleaner collapses, and stored text that contains one would
 * require a typist to produce it mid-passage.
 *
 * Takes a single character; callers iterate with a code-point-aware iterator, never by
 * UTF-16 index.
 */
export function isAllowed(character: string): boolean {
	if (character === '\n') {
		return true;
	}
	const code = character.codePointAt(0);
	if (code === undefined) {
		return false;
	}
	if (code >= 0x20 && code <= 0x7e) {
		return true;
	}
	return SPANISH.includes(character);
}

/**
 * Folds source typography into the typeable set and normalises encoding.
 *
 * Order matters. NFC runs **first** so a decomposed accent (`n` + combining tilde) becomes
 * the single code point `ñ` before anything inspects it — otherwise the combining mark reads
 * as a disallowed character and the letter it belongs to reads as a bare `n`.
 *
 * CRLF is collapsed here rather than in the cleaner so no downstream line handling ever has
 * to think about `\r`.
 *
 * This function never rejects: unfoldable characters pass through untouched, for
 * `findDisallowed` to report and the caller to act on. Reporting and refusing are the
 * script's job — a cleaner that threw could not produce the dry-run report whose whole
 * purpose is to show what went wrong.
 */
export function normalizeCharacters(text: string): string {
	const normalized = text.normalize('NFC').replace(/\r\n?/g, '\n');
	let out = '';
	for (const character of normalized) {
		const folded = FOLDINGS.get(character);
		if (folded !== undefined) {
			out += folded;
			continue;
		}
		out += isAllowed(character) ? character : foldLatin(character);
	}
	return out;
}

/** Ligatures, which decomposition cannot expand — `œ` is one code point, not `o` + `e`. */
const LIGATURES: ReadonlyMap<string, string> = new Map([
	['œ', 'oe'],
	['Œ', 'OE'],
	['æ', 'ae'],
	['Æ', 'AE'],
	['ß', 'ss']
]);

/**
 * Last resort for a letter outside the allowed set: strip its diacritics.
 *
 * Real English prose carries French loanwords and real Spanish prose carries foreign names —
 * `théâtre`, `tête-à-tête`, `manœuvre` all appear in Pride and Prejudice, found on the first
 * ingestion run. Keeping them would leave passages nobody can complete, since none of those
 * letters is on an English or Spanish keyboard; dropping them would mangle words. Folding to
 * the base letter keeps the word readable and typeable, which is the trade ADR-0013 makes
 * throughout — `source_url` is the fidelity story, not the stored text.
 *
 * Spanish diacritics never reach here: they are allowed, so they are returned before this is
 * called. NFD decomposition then combining-mark removal is general — it needs no table and
 * handles any Latin diacritic a source happens to contain.
 *
 * A character that is not a decomposable letter is returned unchanged, for `findDisallowed`
 * to report: silently deleting something unrecognised is how text gets quietly corrupted.
 */
function foldLatin(character: string): string {
	const ligature = LIGATURES.get(character);
	if (ligature !== undefined) {
		return ligature;
	}
	const stripped = character.normalize('NFD').replace(/\p{Mn}/gu, '');
	return stripped !== '' && [...stripped].every(isAllowed) ? stripped : character;
}

/** One character outside the allowed set, with everything needed to find it in the source. */
export interface DisallowedCharacter {
	/** The offending character itself. */
	character: string;
	/** Its code point, formatted `U+XXXX` for a report a human reads. */
	codePoint: string;
	/** Code-point index of the **first** occurrence. */
	index: number;
	/** Source text around the first occurrence. */
	context: string;
	/** How many times it occurs in the whole text. */
	occurrences: number;
}

/** Characters of context shown either side of the first occurrence. */
const CONTEXT_RADIUS = 20;

/**
 * Every character outside the allowed set, one entry per distinct character, in order of
 * first appearance.
 *
 * Grouped rather than listed: a source with a decorative glyph in every chapter heading
 * would otherwise produce thousands of rows and bury the one that matters. The count is what
 * tells you whether it is a stray artefact or a systematic problem with the source.
 *
 * Indices are counted in **code points**, matching how the engine sizes a chunk, so an index
 * after an accented letter is not off by one.
 */
export function findDisallowed(text: string): DisallowedCharacter[] {
	const characters = [...text];
	const found = new Map<string, DisallowedCharacter>();

	for (const [index, character] of characters.entries()) {
		if (isAllowed(character)) {
			continue;
		}
		const existing = found.get(character);
		if (existing) {
			existing.occurrences += 1;
			continue;
		}
		found.set(character, {
			character,
			codePoint: `U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`,
			index,
			context: characters
				.slice(Math.max(0, index - CONTEXT_RADIUS), index + CONTEXT_RADIUS + 1)
				.join(''),
			occurrences: 1
		});
	}

	return [...found.values()];
}
