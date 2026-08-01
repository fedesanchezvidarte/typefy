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
