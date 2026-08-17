import { describe, expect, it } from 'vitest';
import { cleanSource } from './clean.js';

/** A Gutenberg-shaped source: legal header, body, licence footer. */
function gutenberg(body: string, { start = 'THE', end = 'THE' } = {}): string {
	return [
		'The Project Gutenberg eBook of Something, by Someone',
		'',
		'This eBook is for the use of anyone anywhere at no cost.',
		'',
		`*** START OF ${start} PROJECT GUTENBERG EBOOK SOMETHING ***`,
		'',
		body,
		'',
		`*** END OF ${end} PROJECT GUTENBERG EBOOK SOMETHING ***`,
		'',
		'Updated editions will replace the previous one.',
		'',
		'START: FULL LICENSE'
	].join('\n');
}

describe('cleanSource — boilerplate', () => {
	it('keeps only what lies between the start and end markers', () => {
		const cleaned = cleanSource(gutenberg('The body of the book.'));
		expect(cleaned).toBe('The body of the book.');
	});

	it('accepts the THIS variant of the marker, used by older texts', () => {
		const cleaned = cleanSource(gutenberg('Body.', { start: 'THIS', end: 'THIS' }));
		expect(cleaned).toBe('Body.');
	});

	it('tolerates a text whose start and end markers disagree in wording', () => {
		const cleaned = cleanSource(gutenberg('Body.', { start: 'THIS', end: 'THE' }));
		expect(cleaned).toBe('Body.');
	});

	it('honours per-book override markers when the source uses another form', () => {
		const raw = ['front matter', '<<BEGIN>>', 'Real text.', '<<FINISH>>', 'back matter'].join('\n');
		const cleaned = cleanSource(raw, { startMarker: '<<BEGIN>>', endMarker: '<<FINISH>>' });
		expect(cleaned).toBe('Real text.');
	});

	it('returns the whole text when no marker is present, rather than nothing', () => {
		expect(cleanSource('Just a plain text.\n')).toBe('Just a plain text.');
	});

	/*
	 * Gutenberg's start marker is followed by front matter — title page, contents, preface —
	 * so the marker alone leaves a table of contents as passage 1. `startAtMarker` names the
	 * body's real first line and KEEPS it, which the exclusive form would have deleted.
	 */
	it('keeps the line named by startAtMarker, dropping only what precedes it', () => {
		const raw = ['CONTENTS', 'Chapter one .... 1', '', 'It is a truth universally.', 'More.'].join(
			'\n'
		);
		expect(cleanSource(raw, { startAtMarker: 'It is a truth universally' })).toBe(
			'It is a truth universally. More.'
		);
	});

	it('falls back to the whole text when startAtMarker is not found', () => {
		expect(cleanSource('Only this.', { startAtMarker: 'absent' })).toBe('Only this.');
	});

	it('applies startAtMarker together with the default end marker', () => {
		const raw = gutenberg(['Front matter.', '', 'BODY BEGINS here.', 'And continues.'].join('\n'));
		expect(cleanSource(raw, { startAtMarker: 'BODY BEGINS' })).toBe(
			'BODY BEGINS here. And continues.'
		);
	});

	it('does not treat a mention of the marker inside the body as a second boundary', () => {
		const cleaned = cleanSource(gutenberg('Body one.\n\nBody two.'));
		expect(cleaned).toBe('Body one.\n\nBody two.');
	});
});

describe('cleanSource — paragraphs', () => {
	it('rejoins hard-wrapped lines into one paragraph', () => {
		const raw = ['It is a truth universally', 'acknowledged, that a single', 'man...'].join('\n');
		expect(cleanSource(raw)).toBe('It is a truth universally acknowledged, that a single man...');
	});

	it('treats a blank line as a paragraph boundary', () => {
		expect(cleanSource('One.\n\nTwo.')).toBe('One.\n\nTwo.');
	});

	it('collapses several blank lines into a single boundary', () => {
		expect(cleanSource('One.\n\n\n\n\nTwo.')).toBe('One.\n\nTwo.');
	});

	it('preserves paragraph order', () => {
		expect(cleanSource('A.\n\nB.\n\nC.')).toBe('A.\n\nB.\n\nC.');
	});

	it('collapses runs of whitespace inside a paragraph', () => {
		expect(cleanSource('One   two\t\tthree.')).toBe('One two three.');
	});

	it('trims leading and trailing whitespace from each paragraph', () => {
		expect(cleanSource('   One.   \n\n   Two.   ')).toBe('One.\n\nTwo.');
	});

	it('drops paragraphs that are empty once whitespace is stripped', () => {
		expect(cleanSource('One.\n\n   \n\nTwo.')).toBe('One.\n\nTwo.');
	});

	it('handles CRLF sources without leaving stray carriage returns', () => {
		expect(cleanSource('One.\r\n\r\nTwo.\r\n')).toBe('One.\n\nTwo.');
	});
});

describe('cleanSource — normalization', () => {
	it('folds source typography into the typeable set', () => {
		expect(cleanSource('“Quoted,” she said—firmly…')).toBe('"Quoted," she said-firmly...');
	});

	it('leaves Spanish letters and inverted marks intact', () => {
		expect(cleanSource('¿Qué añoras, señor?')).toBe('¿Qué añoras, señor?');
	});

	it('folds a non-breaking space rather than leaving an untypeable character', () => {
		const withNbsp = `a${String.fromCodePoint(0x00a0)}b`;
		expect(cleanSource(withNbsp)).toBe('a b');
	});

	it('treats a Unicode paragraph separator as a paragraph boundary, not a space', () => {
		const separated = `One.${String.fromCodePoint(0x2029)}${String.fromCodePoint(0x2029)}Two.`;
		expect(cleanSource(separated)).toBe('One.\n\nTwo.');
	});

	it('returns an empty string for input that is entirely boilerplate or blank', () => {
		expect(cleanSource('   \n\n   ')).toBe('');
	});
});

/*
 * Gutenberg's plain-text edition carries two kinds of markup that are not part of the book:
 * underscores standing in for italics, and bracketed illustration captions. Both were found in
 * Pride and Prejudice on the first ingestion run — the captions were also the sole source of
 * the middle-dot characters the allowed-set check rejected.
 */
describe('cleanSource — Gutenberg markup', () => {
	it('unwraps underscore italics rather than making the typist produce them', () => {
		expect(cleanSource('a _coup de theatre_ indeed')).toBe('a coup de theatre indeed');
	});

	it('drops an illustration caption entirely', () => {
		expect(cleanSource('Before.\n\n[Illustration: PRIDE AND PREJUDICE]\n\nAfter.')).toBe(
			'Before.\n\nAfter.'
		);
	});

	it('drops an illustration caption that spans several lines', () => {
		const raw = 'Before.\n\n[Illustration:\n   a caption\n   over lines]\n\nAfter.';
		expect(cleanSource(raw)).toBe('Before.\n\nAfter.');
	});

	it('drops a bare illustration marker', () => {
		expect(cleanSource('Before.\n\n[Illustration]\n\nAfter.')).toBe('Before.\n\nAfter.');
	});

	it('leaves ordinary bracketed text alone', () => {
		expect(cleanSource('He paused [as usual] and went on.')).toBe(
			'He paused [as usual] and went on.'
		);
	});

	it('leaves an underscore-free line untouched', () => {
		expect(cleanSource('A plain sentence.')).toBe('A plain sentence.');
	});

	/*
	 * Spanish transcriptions spell the same marker `[Ilustración…]`. La Odisea carries 66 of them
	 * (spec #48), several with a caption that spans a blank line — which, left alone, becomes two
	 * chunks of apparatus rather than one caption.
	 */
	it('drops the Spanish spelling of an illustration caption', () => {
		expect(cleanSource('Antes.\n\n[Ilustración: LA BALSA DE ULISES]\n\nDespués.')).toBe(
			'Antes.\n\nDespués.'
		);
	});

	it('drops a Spanish illustration caption whose attribution sits past a blank line', () => {
		const raw = 'Antes.\n\n[Ilustración: Néstor reconoce á Minerva\n\n(_Canto III._)]\n\nDespués.';
		expect(cleanSource(raw)).toBe('Antes.\n\nDespués.');
	});
});

/*
 * Two per-book cleaning rules for sources whose transcription carries apparatus the prose does
 * not (spec #48). Both are opt-in: each can misfire on real prose, so no book gets them without
 * its manifest entry asking, and the committed report is what proves the ask was right.
 */
describe('cleanSource — stripLeadingParagraphNumbers', () => {
	const on = { stripLeadingParagraphNumbers: true } as const;

	it('is off by default, so a marginal verse number survives unasked-for cleaning', () => {
		expect(cleanSource('1 Háblame, Musa, de aquel varón.')).toBe(
			'1 Háblame, Musa, de aquel varón.'
		);
	});

	it('drops the verse number a transcription moved to the head of a paragraph', () => {
		expect(cleanSource('1 Háblame, Musa, de aquel varón.', on)).toBe(
			'Háblame, Musa, de aquel varón.'
		);
	});

	it('drops a multi-digit number', () => {
		expect(cleanSource('1335 Ya en aquel tiempo.', on)).toBe('Ya en aquel tiempo.');
	});

	/*
	 * The source opens dialogue on a guillemet, but normalisation has already folded it to `"` by
	 * the time this rule runs — so `"` is what the rule must accept, and this asserts the pair
	 * end to end rather than trusting the ordering.
	 */
	it('drops the number before a Spanish opening quote or inverted mark', () => {
		expect(cleanSource('32 «¡Oh dioses!» dijo.', on)).toBe('"¡Oh dioses!" dijo.');
		expect(cleanSource('44 ¿Qué dices?', on)).toBe('¿Qué dices?');
	});

	/*
	 * THE false positive the rule is shaped around. Prose that genuinely opens with a figure
	 * continues in lower case, so requiring a capitalised word after the digits is what tells a
	 * printer's marginal number apart from the author's own.
	 */
	it('leaves a paragraph that legitimately opens with a number alone', () => {
		expect(cleanSource('1605 marcó el comienzo de la novela moderna.', on)).toBe(
			'1605 marcó el comienzo de la novela moderna.'
		);
	});

	it('leaves a number that opens a paragraph before another number alone', () => {
		expect(cleanSource('1 000 hombres.', on)).toBe('1 000 hombres.');
	});

	it('strips only at the head, never a number that appears mid-paragraph', () => {
		expect(cleanSource('Llegaron 40 Hombres de Ítaca.', on)).toBe('Llegaron 40 Hombres de Ítaca.');
	});

	it('applies per paragraph rather than once per book', () => {
		expect(cleanSource('1 Uno.\n\n11 Dos.\n\n22 Tres.', on)).toBe('Uno.\n\nDos.\n\nTres.');
	});

	it('drops a paragraph that was nothing but its marginal number', () => {
		expect(cleanSource('Antes.\n\n413 Después.\n\n420 A', on)).toBe('Antes.\n\nDespués.\n\nA');
	});

	it('strips the number from a paragraph whose lines were hard-wrapped', () => {
		expect(cleanSource('1 Háblame, Musa, de aquel\nvarón de multiforme ingenio.', on)).toBe(
			'Háblame, Musa, de aquel varón de multiforme ingenio.'
		);
	});
});

describe('cleanSource — stripFootnoteBlocks', () => {
	const on = { stripFootnoteBlocks: true } as const;

	it('is off by default, so a footnote block survives unasked-for cleaning', () => {
		expect(cleanSource('Antes.\n\n[1] Nota del traductor.\n\nDespués.')).toBe(
			'Antes.\n\n[1] Nota del traductor.\n\nDespués.'
		);
	});

	it('drops a paragraph that opens with a bracketed footnote number', () => {
		expect(cleanSource('Antes.\n\n[1] Nota del traductor.\n\nDespués.', on)).toBe(
			'Antes.\n\nDespués.'
		);
	});

	it('drops a multi-line footnote block whole', () => {
		const raw = 'Antes.\n\n  [12] Nota del traductor,\n  que sigue en otra línea.\n\nDespués.';
		expect(cleanSource(raw, on)).toBe('Antes.\n\nDespués.');
	});

	it('leaves a bracketed aside that is the author’s alone', () => {
		expect(cleanSource('Se detuvo [como siempre] y siguió.', on)).toBe(
			'Se detuvo [como siempre] y siguió.'
		);
	});

	it('leaves a bracket that opens a paragraph without a number alone', () => {
		expect(cleanSource('[Nota] del editor.', on)).toBe('[Nota] del editor.');
	});

	it('drops only the block, never the paragraph it annotates', () => {
		expect(cleanSource('Uno.\n\n[1] a\n\nDos.\n\n[2] b\n\nTres.', on)).toBe(
			'Uno.\n\nDos.\n\nTres.'
		);
	});

	/*
	 * The reason the option exists: the footnote's Greek is the only disallowed text in an
	 * otherwise typeable Spanish source, and `findDisallowed` would (correctly) make it fatal.
	 */
	it('removes the Greek that lives only inside a footnote block', () => {
		const raw = 'Como llegué aquí después de haberme airado.\n\n[1] ὀδύσσομαι significa airarse.';
		expect(cleanSource(raw, on)).toBe('Como llegué aquí después de haberme airado.');
	});
});

describe('cleanSource — both per-book rules together', () => {
	const on = { stripLeadingParagraphNumbers: true, stripFootnoteBlocks: true } as const;

	it('drops the footnote and the verse numbers around it', () => {
		const raw = '405 Y Autólico respondió.\n\n[1] ὀδύσσομαι, airarse.\n\n413 Por esto fué Ulises.';
		expect(cleanSource(raw, on)).toBe('Y Autólico respondió.\n\nPor esto fué Ulises.');
	});

	it('does not let the number rule turn a footnote into prose', () => {
		// `[1]` is not digits-first, so the two rules cannot interact — asserted rather than assumed.
		expect(cleanSource('[1] Nota.', { stripLeadingParagraphNumbers: true })).toBe('[1] Nota.');
	});
});
