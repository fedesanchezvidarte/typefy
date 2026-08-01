import { describe, expect, it } from 'vitest';
import {
	donQuijoteExcerpt,
	fixtureTexts,
	getFixtureText,
	prideAndPrejudiceExcerpt,
	tortoiseAndHare
} from './index';

/**
 * Fixture validation per spec #5: hand-chunked to ADR-0005 size targets
 * (~400-600 chars, never cutting a sentence), straight ASCII punctuation only
 * plus Spanish letters and inverted marks in the ES text.
 *
 * Documented boundary exceptions (justified in the fixture file headers):
 * chunks may fall outside 400-600 only when listed here.
 */
const SIZE_EXCEPTIONS: Record<string, string> = {
	'pride-and-prejudice-excerpt-0':
		'opening narration boundary; pulling the next dialogue line in would leave the following chunk badly undersized',
	'don-quijote-excerpt-2': 'bridges a paragraph remainder before an unsplittable 683-char sentence',
	'don-quijote-excerpt-3': 'a single sentence that cannot be cut (ADR-0005: never cut a sentence)'
};

const EN_ALLOWED = /^[A-Za-z0-9 .,;:!?'"()-]+$/;
const ES_ALLOWED = /^[A-Za-z0-9áéíóúüñÁÉÍÓÚÜÑ¿¡ .,;:!?'"()-]+$/;
const SENTENCE_END = /[.?!]"?$/;

describe.each([
	{ name: 'EN (Pride and Prejudice excerpt)', text: prideAndPrejudiceExcerpt, allowed: EN_ALLOWED },
	{ name: 'ES (Don Quijote excerpt)', text: donQuijoteExcerpt, allowed: ES_ALLOWED }
])('fixture $name', ({ text, allowed }) => {
	it('has 4-6 chunks with consistent ids, indexes, and counts', () => {
		expect(text.chunks.length).toBeGreaterThanOrEqual(4);
		expect(text.chunks.length).toBeLessThanOrEqual(6);
		expect(text.chunkCount).toBe(text.chunks.length);
		text.chunks.forEach((chunk, i) => {
			expect(chunk.index).toBe(i);
			expect(chunk.id).toBe(`${text.id}-${i}`);
			expect(chunk.textId).toBe(text.id);
			expect(chunk.charCount).toBe(Array.from(chunk.content).length);
		});
		expect(new Set(text.chunks.map((c) => c.id)).size).toBe(text.chunks.length);
	});

	it('keeps every chunk in the 400-600 target except documented exceptions', () => {
		for (const chunk of text.chunks) {
			if (chunk.id in SIZE_EXCEPTIONS) {
				// exceptions stay within sane bounds even when outside the target
				expect(chunk.charCount).toBeGreaterThanOrEqual(300);
				expect(chunk.charCount).toBeLessThanOrEqual(700);
			} else {
				expect(chunk.charCount).toBeGreaterThanOrEqual(400);
				expect(chunk.charCount).toBeLessThanOrEqual(600);
			}
		}
	});

	it('never cuts a sentence: each chunk ends with terminal punctuation', () => {
		for (const chunk of text.chunks) {
			expect(chunk.content).toMatch(SENTENCE_END);
		}
	});

	it('contains only the allowed character set (straight ASCII punctuation, no newlines)', () => {
		for (const chunk of text.chunks) {
			expect(chunk.content).toMatch(allowed);
		}
	});
});

describe('ES fixture required characters (spec #5)', () => {
	it.each([...'áéíóúñ¿¡'])('contains %s', (char) => {
		const all = donQuijoteExcerpt.chunks.map((c) => c.content).join('');
		expect(all).toContain(char);
	});
});

/*
 * The short fixture (spec #17 §9) is deliberately outside the 4-6 chunk rule above: its entire
 * purpose is to be smaller than 3b's 10-chunk window, so the rule that keeps the other two
 * honest is the wrong rule for it. It keeps every other invariant.
 */
describe('short fixture (The Tortoise and the Hare)', () => {
	it('is 2-3 chunks, so it is smaller than one window', () => {
		expect(tortoiseAndHare.chunks.length).toBeGreaterThanOrEqual(2);
		expect(tortoiseAndHare.chunks.length).toBeLessThanOrEqual(3);
		expect(tortoiseAndHare.chunkCount).toBe(tortoiseAndHare.chunks.length);
	});

	it('has consistent ids, indexes and counts', () => {
		tortoiseAndHare.chunks.forEach((chunk, i) => {
			expect(chunk.index).toBe(i);
			expect(chunk.id).toBe(`${tortoiseAndHare.id}-${i}`);
			expect(chunk.textId).toBe(tortoiseAndHare.id);
			expect(chunk.charCount).toBe(Array.from(chunk.content).length);
		});
	});

	it('keeps every chunk in the 400-600 target', () => {
		for (const chunk of tortoiseAndHare.chunks) {
			expect(chunk.charCount).toBeGreaterThanOrEqual(400);
			expect(chunk.charCount).toBeLessThanOrEqual(600);
		}
	});

	it('never cuts a sentence', () => {
		for (const chunk of tortoiseAndHare.chunks) {
			expect(chunk.content).toMatch(SENTENCE_END);
		}
	});

	it('contains only the allowed character set', () => {
		for (const chunk of tortoiseAndHare.chunks) {
			expect(chunk.content).toMatch(EN_ALLOWED);
		}
	});

	/*
	 * `getHeroBook` picks the first book by title within a language, so a title sorting before
	 * the existing English fixture would silently steal the landing hero. 3b (#18) makes the
	 * hero explicit; until then this ordering is load-bearing.
	 */
	it('sorts after the existing English fixture, leaving the landing hero unchanged', () => {
		const english = fixtureTexts
			.filter((text) => text.language === 'en')
			.map((text) => text.title)
			.sort();
		expect(english[0]).toBe(prideAndPrejudiceExcerpt.title);
	});
});

describe('fixture registry', () => {
	it('exposes the texts in picker order, covering both content languages', () => {
		expect(fixtureTexts.map((t) => t.language)).toEqual(['en', 'es', 'en']);
	});

	it('looks texts up by id', () => {
		expect(getFixtureText('don-quijote-excerpt')).toBe(donQuijoteExcerpt);
		expect(getFixtureText('tortoise-and-hare')).toBe(tortoiseAndHare);
		expect(getFixtureText('missing')).toBeUndefined();
	});
});
