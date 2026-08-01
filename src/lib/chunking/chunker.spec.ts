import { describe, expect, it } from 'vitest';
import { chunkParagraphs, DEFAULT_TARGET } from './chunker.js';
import { fixtureTexts } from '$lib/fixtures/index.js';

/** A paragraph of roughly `size` characters, built from whole sentences. */
function paragraph(size: number, word = 'palabra'): string {
	const sentence = `${word} `.repeat(9).trim() + '.';
	const times = Math.max(1, Math.round(size / (sentence.length + 1)));
	return Array.from({ length: times }, () => sentence).join(' ');
}

describe('chunkParagraphs — grouping', () => {
	it('groups consecutive paragraphs up to the size target', () => {
		const paragraphs = [paragraph(150), paragraph(150), paragraph(150)];
		// Guard the premise: these must actually fit together, or the test proves nothing.
		const together = paragraphs.join(' ').length;
		expect(together).toBeLessThanOrEqual(DEFAULT_TARGET.max);
		expect(together).toBeGreaterThan(DEFAULT_TARGET.min);

		const chunks = chunkParagraphs(paragraphs.join('\n\n'));
		expect(chunks).toHaveLength(1);
		expect(chunks[0].length).toBeGreaterThan(DEFAULT_TARGET.min);
	});

	it('starts a new chunk rather than overrunning the maximum', () => {
		const chunks = chunkParagraphs([paragraph(400), paragraph(400)].join('\n\n'));
		expect(chunks).toHaveLength(2);
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(DEFAULT_TARGET.max);
		}
	});

	it('joins grouped paragraphs with a space, never a newline', () => {
		const chunks = chunkParagraphs('First one.\n\nSecond one.');
		expect(chunks).toEqual(['First one. Second one.']);
	});

	it('emits no chunk containing a newline, matching every existing chunk in the database', () => {
		const chunks = chunkParagraphs([paragraph(300), paragraph(300), paragraph(300)].join('\n\n'));
		for (const chunk of chunks) {
			expect(chunk).not.toContain('\n');
		}
	});

	it('merges a short trailing paragraph into the previous chunk instead of emitting a stub', () => {
		const chunks = chunkParagraphs([paragraph(450), 'Short.'].join('\n\n'));
		expect(chunks).toHaveLength(1);
		expect(chunks[0].endsWith('Short.')).toBe(true);
	});

	it('returns no chunks for empty input', () => {
		expect(chunkParagraphs('')).toEqual([]);
		expect(chunkParagraphs('   \n\n  ')).toEqual([]);
	});

	it('emits a single short chunk when that is all the text there is', () => {
		expect(chunkParagraphs('Tiny.')).toEqual(['Tiny.']);
	});
});

describe('chunkParagraphs — sentence integrity', () => {
	it('splits an over-long paragraph at a sentence boundary, never mid-sentence', () => {
		const chunks = chunkParagraphs(paragraph(1500));
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.endsWith('.')).toBe(true);
		}
	});

	it('emits a single sentence longer than the maximum whole rather than amputating it', () => {
		const monster = `${'word '.repeat(200).trim()}.`;
		expect(monster.length).toBeGreaterThan(DEFAULT_TARGET.max);
		const chunks = chunkParagraphs(monster);
		expect(chunks).toEqual([monster]);
	});

	it('does not split on an English courtesy title', () => {
		const text = `${paragraph(500)} Mr. Bennet was among the earliest of those who waited on Mr. Bingley.`;
		for (const chunk of chunkParagraphs(text)) {
			expect(chunk).not.toMatch(/\bMr\.$/);
		}
	});

	it('does not split on a Spanish courtesy title', () => {
		const text = `${paragraph(500)} El Sr. Quijano hablo con la Sra. Ana sobre el asunto.`;
		for (const chunk of chunkParagraphs(text)) {
			expect(chunk).not.toMatch(/\b(Sr|Sra)\.$/);
		}
	});

	it('does not split on an abbreviation such as i.e. or etc.', () => {
		const text = `${paragraph(500)} They packed clothes, books, etc. before the coach arrived.`;
		for (const chunk of chunkParagraphs(text)) {
			expect(chunk).not.toMatch(/\betc\.$/);
		}
	});

	it('splits after a question mark and an exclamation mark', () => {
		const text = `${paragraph(560)} Who is there? Nobody at all! The door stayed shut.`;
		const chunks = chunkParagraphs(text);
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.some((chunk) => chunk.includes('Who is there?'))).toBe(true);
	});

	it('keeps an inverted Spanish question intact across a boundary', () => {
		const text = `${paragraph(560)} ¿Quien anda ahi? Nadie respondio.`;
		for (const chunk of chunkParagraphs(text)) {
			expect(chunk).not.toMatch(/¿[^?]*$/);
		}
	});

	it('splits after a sentence that ends inside a closing quotation mark', () => {
		const text = `${paragraph(560)} "It is settled." She turned away without another word.`;
		const chunks = chunkParagraphs(text);
		expect(chunks.some((chunk) => chunk.includes('"It is settled."'))).toBe(true);
	});

	it('does not split on ellipsis periods left by normalization', () => {
		const text = `${paragraph(500)} She waited... and waited... and then she left.`;
		for (const chunk of chunkParagraphs(text)) {
			expect(chunk).not.toMatch(/\.\.$/);
		}
	});
});

describe('chunkParagraphs — invariants', () => {
	it('loses no text: the chunks rejoin to the cleaned source', () => {
		const source = [paragraph(700), paragraph(300), paragraph(1200)].join('\n\n');
		const rejoined = chunkParagraphs(source).join(' ');
		expect(rejoined).toBe(source.replaceAll('\n\n', ' '));
	});

	it('emits no empty or whitespace-only chunk', () => {
		for (const chunk of chunkParagraphs([paragraph(900), paragraph(100)].join('\n\n'))) {
			expect(chunk.trim()).not.toBe('');
		}
	});

	it('emits no chunk with leading or trailing whitespace', () => {
		for (const chunk of chunkParagraphs([paragraph(900), paragraph(400)].join('\n\n'))) {
			expect(chunk).toBe(chunk.trim());
		}
	});

	/*
	 * Found on the first real ingestion: Don Quijote produced a 7-character chunk, because a
	 * chapter heading was followed by a 2,700-character sentence it could not join. Emitting
	 * the heading alone gives a stub passage AND an over-long one; absorbing it gives only the
	 * over-long one, which was unavoidable anyway.
	 */
	it('absorbs a stub into an oversized following unit rather than emitting both', () => {
		const heading = 'Capitulo IX';
		const monster = `${'palabra '.repeat(400).trim()}.`;
		const chunks = chunkParagraphs(`${heading}\n\n${monster}`);
		expect(chunks[0].startsWith(heading)).toBe(true);
		expect(chunks[0].length).toBeGreaterThan(DEFAULT_TARGET.max);
		expect(chunks.every((chunk) => chunk.length > heading.length)).toBe(true);
	});

	it('still emits a stub when the following unit fits on its own', () => {
		// One sentence, so it cannot repack: long enough that the stub does not fit with it,
		// short enough that it needs no absorbing.
		const stub = 'Short.';
		const sentence = `${'a'.repeat(DEFAULT_TARGET.max - 2)}.`;
		expect(sentence.length).toBeLessThanOrEqual(DEFAULT_TARGET.max);
		expect(stub.length + 1 + sentence.length).toBeGreaterThan(DEFAULT_TARGET.max);

		expect(chunkParagraphs(`${stub}\n\n${sentence}`)).toEqual([stub, sentence]);
	});

	it('honours an explicit target', () => {
		const chunks = chunkParagraphs(paragraph(1200), { min: 100, max: 200 });
		for (const chunk of chunks.slice(0, -1)) {
			expect(chunk.length).toBeLessThanOrEqual(200);
		}
	});
});

/*
 * Phase 1's fixtures were chunked by hand and are the only worked example of the intended
 * rhythm. The chunker is not required to reproduce them exactly — grouping is a judgement —
 * but it must not produce something wildly different from what a human considered right.
 */
describe('chunkParagraphs against the hand-chunked fixtures', () => {
	for (const text of fixtureTexts) {
		it(`produces a comparable chunk count for ${text.id}`, () => {
			const source = text.chunks.map((chunk) => chunk.content).join('\n\n');
			const produced = chunkParagraphs(source);
			expect(produced.length).toBeGreaterThanOrEqual(Math.floor(text.chunks.length * 0.5));
			expect(produced.length).toBeLessThanOrEqual(Math.ceil(text.chunks.length * 2));
		});
	}
});
