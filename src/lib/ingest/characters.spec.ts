import { describe, expect, it } from 'vitest';
import { findDisallowed, isAllowed, normalizeCharacters } from './characters.js';
import { fixtureTexts } from '$lib/fixtures/index.js';

/*
 * These tests carry literal invisible characters — a real non-breaking space, a real
 * zero-width space, real combining accents. That is deliberate: folding them is the whole
 * job, and an escape sequence would test the escape rather than the byte the source file
 * actually holds.
 *
 * The cost is that they are unreviewable by eye and a careless edit can silently replace one
 * with a plain space, leaving a test that asserts nothing. Each case therefore also asserts
 * something the substitution would break — a length, or a difference from the plain-ASCII
 * form — so a hollowed-out test fails instead of passing vacuously.
 */

describe('normalizeCharacters — typographic folding', () => {
	it('folds every curly and guillemet double quote to a straight quote', () => {
		expect(normalizeCharacters('“a” „b‟ «c»')).toBe('"a" "b" "c"');
	});

	it('folds curly single quotes and apostrophes to a straight apostrophe', () => {
		expect(normalizeCharacters('‘a’ ‚b‛')).toBe("'a' 'b'");
	});

	it('folds em, en, figure and horizontal-bar dashes to a hyphen', () => {
		expect(normalizeCharacters('a—b–c‒d―e')).toBe('a-b-c-d-e');
	});

	it('expands the ellipsis character to three periods', () => {
		expect(normalizeCharacters('wait… now')).toBe('wait... now');
	});

	it('expands the vulgar fraction one half to a spaced ASCII fraction', () => {
		// The space matters: "4½ per cent" without it becomes "41/2 per cent", a different
		// number. The cleaner collapses the resulting double space, so a standalone ½ is safe.
		expect(normalizeCharacters('paying 4½ per cent')).toBe('paying 4 1/2 per cent');
	});

	it('folds the pound sign to the L it descends from', () => {
		expect(normalizeCharacters('£1,000,000')).toBe('L1,000,000');
	});

	it('folds non-breaking, thin, figure and ideographic spaces to a plain space', () => {
		const exotic = 'a b c d e　f';
		expect(exotic).not.toBe('a b c d e f'); // guard: the literals are still exotic
		expect(normalizeCharacters(exotic)).toBe('a b c d e f');
	});

	it('removes zero-width characters and a byte-order mark entirely', () => {
		const invisible = '﻿a​b‌c­d';
		expect([...invisible]).toHaveLength(8); // guard: four invisibles still present
		expect(normalizeCharacters(invisible)).toBe('abcd');
	});

	it('folds Unicode line and paragraph separators to a newline', () => {
		const separated = 'a b c';
		expect(separated).not.toContain('\n'); // guard: these are U+2028/U+2029, not newlines
		expect(normalizeCharacters(separated)).toBe('a\nb\nc');
	});

	it('normalises decomposed accents to single NFC code points', () => {
		const decomposed = 'cañón'; // n + combining tilde, o + combining acute
		expect([...decomposed]).toHaveLength(7);
		const normalized = normalizeCharacters(decomposed);
		expect(normalized).toBe('cañón');
		expect([...normalized]).toHaveLength(5);
	});

	it('leaves Spanish letters and inverted marks untouched', () => {
		const spanish = '¿Qué sueña el niño? ¡Añil, señor!';
		expect(normalizeCharacters(spanish)).toBe(spanish);
	});

	it('leaves plain ASCII untouched', () => {
		const ascii = 'The quick brown fox -- "jumped" over 12 lazy dogs!';
		expect(normalizeCharacters(ascii)).toBe(ascii);
	});

	it('normalises carriage returns so line handling never sees CRLF', () => {
		expect(normalizeCharacters('a\r\nb\rc')).toBe('a\nb\nc');
	});

	/*
	 * Real English prose carries French loanwords, and real Spanish prose carries the odd
	 * French or Portuguese name. Found in Pride and Prejudice on the first ingestion run:
	 * théâtre, tête-à-tête, manœuvre. Folding these to their base letters is what the
	 * keyboard-reachability rule demands — the alternative is a passage nobody can complete.
	 */
	it('folds a diacritic that is not part of the Spanish set to its base letter', () => {
		expect(normalizeCharacters('tête-à-tête')).toBe('tete-a-tete');
	});

	/*
	 * The rule is about the keyboard, not about the word's language of origin: a character in
	 * the allowed set survives wherever it appears. So `théâtre` keeps its `é` — which a
	 * Spanish keyboard produces — and loses only its `â`, giving the mixed-looking but fully
	 * typeable `théatre`. Folding the `é` too would mean maintaining a notion of which
	 * language a word belongs to, which ingestion has no way to know and no reason to.
	 */
	it('folds only the characters outside the set, not the whole word', () => {
		expect(normalizeCharacters('théâtre')).toBe('théatre');
	});

	it('keeps Spanish diacritics while folding the others in the same word', () => {
		expect(normalizeCharacters('añoraré êxito')).toBe('añoraré exito');
	});

	it('expands ligatures rather than dropping them', () => {
		expect(normalizeCharacters('manœuvre')).toBe('manoeuvre');
		expect(normalizeCharacters('Æsop')).toBe('AEsop');
		expect(normalizeCharacters('straße')).toBe('strasse');
	});

	it('folds uppercase diacritics too', () => {
		expect(normalizeCharacters('ÊTRE')).toBe('ETRE');
	});
});

describe('isAllowed', () => {
	it('accepts printable ASCII, newline, Spanish letters and inverted marks', () => {
		const allowed = ['a', 'Z', '7', ' ', '\n', '.', '"', "'", '-', 'ñ', 'Ñ', 'á', 'Ü', '¿', '¡'];
		for (const character of allowed) {
			expect(isAllowed(character), JSON.stringify(character)).toBe(true);
		}
	});

	it('rejects characters no English or Spanish keyboard produces', () => {
		const rejected = ['—', '“', '…', ' ', '§', '°', 'カ'];
		for (const character of rejected) {
			expect(isAllowed(character), JSON.stringify(character)).toBe(false);
		}
	});

	it('rejects a tab — whitespace the cleaner should have collapsed, not typeable text', () => {
		expect(isAllowed('\t')).toBe(false);
	});
});

describe('findDisallowed', () => {
	it('reports nothing for text that is entirely typeable', () => {
		expect(findDisallowed('¡Hola! "Qué tal", dijo él.')).toEqual([]);
	});

	it('reports each offending character with its code point and index', () => {
		const found = findDisallowed('a§b');
		expect(found).toHaveLength(1);
		expect(found[0].character).toBe('§');
		expect(found[0].codePoint).toBe('U+00A7');
		expect(found[0].index).toBe(1);
	});

	it('includes surrounding context so the offender can be located in the source', () => {
		const found = findDisallowed('the temperature was 15° that morning');
		expect(found[0].context).toContain('15');
	});

	it('groups repeats of the same character rather than reporting thousands of rows', () => {
		const found = findDisallowed('°a°b°');
		expect(found).toHaveLength(1);
		expect(found[0].occurrences).toBe(3);
		expect(found[0].index).toBe(0);
	});

	it('counts positions in code points, so an index after an accent is not off by one', () => {
		const found = findDisallowed('ñ°');
		expect(found[0].index).toBe(1);
	});

	it('reports several distinct offenders in the order they first appear', () => {
		const found = findDisallowed('a°b§c°');
		expect(found.map((entry) => entry.character)).toEqual(['°', '§']);
		expect(found[0].occurrences).toBe(2);
	});
});

/*
 * The load-bearing test of this module. The allowed set is a DESCRIPTION of what Phase 1's
 * hand-chunked fixtures already contain — the hand-cleaning normalised typography away
 * without anyone writing it down — not a new constraint invented in Phase 3. If a fixture
 * fails here, the set is wrong, not the fixture.
 */
describe('the allowed set describes the existing fixtures', () => {
	for (const text of fixtureTexts) {
		it(`accepts every character of ${text.id} unchanged`, () => {
			for (const chunk of text.chunks) {
				expect(findDisallowed(chunk.content), `${text.id} chunk ${chunk.index}`).toEqual([]);
			}
		});

		it(`normalises ${text.id} to itself — nothing to fold`, () => {
			for (const chunk of text.chunks) {
				expect(normalizeCharacters(chunk.content)).toBe(chunk.content);
			}
		});
	}
});
