import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chunkParagraphs } from './chunker.js';
import { CHARS_PER_LINE, MAX_CHARS, MAX_LINES, lineCost } from './measure.js';
import { fixtureTexts } from '$lib/fixtures/index.js';

/**
 * The dual-budget chunker (spec #32; ADR-0005 amendment).
 *
 * A chunk is now a PAGE: several paragraphs joined with a real `\n`, closed by whichever of
 * the two budgets binds first — characters or estimated rendered lines. The pre-5b rule that
 * a chunk never ends mid-sentence survives unchanged, and is still what the sentence splitter
 * exists for.
 */

/** A paragraph of roughly `size` characters, built from whole sentences. */
function paragraph(size: number, word = 'palabra'): string {
	const sentence = `${word} `.repeat(9).trim() + '.';
	const times = Math.max(1, Math.round(size / (sentence.length + 1)));
	return Array.from({ length: times }, () => sentence).join(' ');
}

/** The paragraphs of one chunk, as the surface will render them. */
function paragraphsOf(chunk: string): string[] {
	return chunk.split('\n');
}

/** The chunk's cost in estimated rendered lines — the budget the chunker actually applies. */
function linesOf(chunk: string): number {
	return paragraphsOf(chunk).reduce((sum, p) => sum + lineCost(p), 0);
}

describe('chunkParagraphs — the dual budget', () => {
	it('closes a chunk on the LINE budget while the character budget still has room', () => {
		// Dialogue: many one-line paragraphs. Each costs a rendered line however short it is,
		// so the page fills up long before 1600 characters.
		const line = 'Word word word two.';
		expect(lineCost(line)).toBe(1);
		const chunks = chunkParagraphs(Array.from({ length: 60 }, () => line).join('\n\n'));

		const first = chunks[0];
		expect(paragraphsOf(first)).toHaveLength(MAX_LINES);
		expect(linesOf(first)).toBe(MAX_LINES);
		// The binding claim: the character budget was nowhere near reached.
		expect(first.length).toBeLessThan(MAX_CHARS / 2);
	});

	it('closes a chunk on the CHARACTER budget while the line budget still has room', () => {
		// Dense prose: paragraphs that fill their last rendered line exactly. The `\n`
		// separators are real characters, so the page runs out of characters at 23 lines.
		const full = `${'x'.repeat(CHARS_PER_LINE - 1)}.`;
		expect(full).toHaveLength(CHARS_PER_LINE);
		expect(lineCost(full)).toBe(1);
		const chunks = chunkParagraphs(Array.from({ length: 60 }, () => full).join('\n\n'));

		const first = chunks[0];
		expect(first.length).toBeLessThanOrEqual(MAX_CHARS);
		// Adding one more paragraph would have overrun MAX_CHARS...
		expect(first.length + 1 + full.length).toBeGreaterThan(MAX_CHARS);
		// ...while the line budget still had room. That is the criterion.
		expect(linesOf(first)).toBeLessThan(MAX_LINES);
	});

	it('holds every chunk within both budgets at once', () => {
		const source = [
			paragraph(300),
			paragraph(80),
			paragraph(1200),
			paragraph(40),
			paragraph(600),
			paragraph(150)
		].join('\n\n');
		for (const chunk of chunkParagraphs(source)) {
			// The one documented exception is a single sentence longer than the budget, which is
			// emitted whole rather than amputated; this source contains none.
			expect(chunk.length).toBeLessThanOrEqual(MAX_CHARS);
			expect(linesOf(chunk)).toBeLessThanOrEqual(MAX_LINES);
		}
	});

	it('honours an explicit budget, so the two bounds are parameters and not hard-coded reads', () => {
		const chunks = chunkParagraphs(Array.from({ length: 12 }, () => paragraph(100)).join('\n\n'), {
			maxChars: 300,
			maxLines: 4
		});
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(300);
		}
	});
});

describe('chunkParagraphs — paragraph structure', () => {
	it('joins paragraphs within a chunk with a single newline, preserving paragraph identity', () => {
		expect(chunkParagraphs('First one.\n\nSecond one.')).toEqual(['First one.\nSecond one.']);
	});

	it('never begins or ends a chunk with a newline, and never contains a blank line', () => {
		const source = Array.from({ length: 40 }, (_, i) => paragraph(60 + i * 30)).join('\n\n');
		for (const chunk of chunkParagraphs(source)) {
			expect(chunk.startsWith('\n')).toBe(false);
			expect(chunk.endsWith('\n')).toBe(false);
			expect(chunk).not.toContain('\n\n');
		}
	});

	it('keeps a paragraph whole rather than splitting it across a chunk boundary when it fits', () => {
		// Three paragraphs of ~700 characters: two fit on a page, the third opens the next one.
		// The pre-5b flatMap(splitSentences) destroyed paragraph identity here and could cut
		// between two sentences of one paragraph while a whole paragraph would have fitted.
		const paragraphs = [paragraph(700, 'alpha'), paragraph(700, 'beta'), paragraph(700, 'gamma')];
		const chunks = chunkParagraphs(paragraphs.join('\n\n'));
		for (const original of paragraphs) {
			expect(chunks.some((chunk) => paragraphsOf(chunk).includes(original))).toBe(true);
		}
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
		const chunks = chunkParagraphs(paragraph(4000));
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.endsWith('.')).toBe(true);
		}
	});

	it('emits a single sentence longer than the budget whole rather than amputating it', () => {
		const monster = `${'word '.repeat(600).trim()}.`;
		expect(monster.length).toBeGreaterThan(MAX_CHARS);
		expect(chunkParagraphs(monster)).toEqual([monster]);
	});

	it('joins the sentences of one split paragraph with a space, never a fabricated newline', () => {
		// Both halves are the SAME paragraph. Whatever else happens, no `\n` may appear inside
		// one — a newline there would invent a paragraph break the author did not write.
		const chunks = chunkParagraphs(paragraph(4000));
		for (const chunk of chunks) {
			expect(chunk).not.toContain('\n');
		}
	});

	it('does not split on an English courtesy title', () => {
		const text = `${paragraph(1700)} Mr. Bennet was among the earliest of those who waited on Mr. Bingley.`;
		for (const chunk of chunkParagraphs(text)) {
			expect(chunk).not.toMatch(/\bMr\.$/);
		}
	});

	it('does not split on a Spanish courtesy title', () => {
		const text = `${paragraph(1700)} El Sr. Quijano hablo con la Sra. Ana sobre el asunto.`;
		for (const chunk of chunkParagraphs(text)) {
			expect(chunk).not.toMatch(/\b(Sr|Sra)\.$/);
		}
	});

	it('does not split on an abbreviation such as etc.', () => {
		const text = `${paragraph(1700)} They packed clothes, books, etc. before the coach arrived.`;
		for (const chunk of chunkParagraphs(text)) {
			expect(chunk).not.toMatch(/\betc\.$/);
		}
	});

	it('splits after a question mark and an exclamation mark', () => {
		const text = `${paragraph(1900)} Who is there? Nobody at all! The door stayed shut.`;
		// Guard the premise: the paragraph must actually be over budget, or it is never split
		// and the test proves nothing.
		expect(text.length).toBeGreaterThan(MAX_CHARS);
		const chunks = chunkParagraphs(text);
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.some((chunk) => chunk.includes('Who is there?'))).toBe(true);
	});

	it('keeps an inverted Spanish question intact across a boundary', () => {
		const text = `${paragraph(1560)} ¿Quien anda ahi? Nadie respondio.`;
		for (const chunk of chunkParagraphs(text)) {
			expect(chunk).not.toMatch(/¿[^?]*$/);
		}
	});

	it('splits after a sentence that ends inside a closing quotation mark', () => {
		const text = `${paragraph(1560)} "It is settled." She turned away without another word.`;
		const chunks = chunkParagraphs(text);
		expect(chunks.some((chunk) => chunk.includes('"It is settled."'))).toBe(true);
	});

	it('does not split on ellipsis periods left by normalization', () => {
		const text = `${paragraph(1560)} She waited... and waited... and then she left.`;
		for (const chunk of chunkParagraphs(text)) {
			expect(chunk).not.toMatch(/\.\.$/);
		}
	});
});

describe('chunkParagraphs — invariants', () => {
	it('loses no text: the chunks rejoin to the cleaned source', () => {
		const source = [paragraph(700), paragraph(300), paragraph(2600), paragraph(120)].join('\n\n');
		// Paragraph boundaries survive as `\n`; a paragraph split across chunks rejoins with the
		// space its sentences were separated by. Both are recovered by normalising separators.
		const rejoined = chunkParagraphs(source).join('\n').replaceAll('\n', ' ');
		expect(rejoined).toBe(source.replaceAll('\n\n', ' '));
	});

	it('emits no empty or whitespace-only chunk', () => {
		for (const chunk of chunkParagraphs([paragraph(2900), paragraph(100)].join('\n\n'))) {
			expect(chunk.trim()).not.toBe('');
		}
	});

	it('emits no chunk with leading or trailing whitespace', () => {
		for (const chunk of chunkParagraphs([paragraph(2900), paragraph(1400)].join('\n\n'))) {
			expect(chunk).toBe(chunk.trim());
		}
	});

	/*
	 * Found on the first real ingestion (pre-5b): Don Quijote produced a 7-character chunk,
	 * because a chapter heading was followed by a 2,700-character sentence it could not join.
	 * Under the dual budget the heading opens the page and the over-long paragraph fills it,
	 * so the stub cannot happen — the greedy fill continues INTO the current chunk rather than
	 * starting the split paragraph on a fresh one.
	 */
	it('fills the current page with an over-long paragraph rather than stranding a heading alone', () => {
		const heading = 'Capitulo IX';
		const monster = `${paragraph(4000)}`;
		const chunks = chunkParagraphs(`${heading}\n\n${monster}`);
		expect(chunks[0].startsWith(`${heading}\n`)).toBe(true);
		expect(chunks[0].length).toBeGreaterThan(MAX_CHARS / 2);
	});

	/*
	 * The pre-5b trailing-stub merge is DROPPED rather than ported, and this test pins that
	 * decision. Under a dual budget the merge would be dead code: a page closes only because
	 * characters or lines bound it, so pulling a one-line tail back necessarily overruns
	 * whichever one did. A short final page is the honest outcome when the text ends there.
	 */
	it('leaves a short final page standing rather than overrunning the previous page to absorb it', () => {
		const line = 'Word word word two.';
		const body = Array.from({ length: MAX_LINES }, () => line).join('\n\n');
		const chunks = chunkParagraphs(`${body}\n\nEnd.`);
		expect(chunks).toHaveLength(2);
		expect(chunks[1]).toBe('End.');
		expect(linesOf(chunks[0])).toBe(MAX_LINES);
	});
});

/*
 * Determinism (acceptance criterion #5). Chunk boundaries are the progress key: a boundary
 * that moved between two devices would point every saved attempt at different text. This runs
 * in the NODE vitest project, where there is no DOM at all — so a chunker that reached for one
 * would throw here rather than quietly pass.
 */
describe('chunkParagraphs — determinism', () => {
	const source = [paragraph(700), paragraph(90), paragraph(3000), paragraph(400)].join('\n\n');

	it('runs with no DOM in scope at all — the premise of every claim below', () => {
		expect(typeof document).toBe('undefined');
		expect(typeof window).toBe('undefined');
	});

	it('yields byte-identical chunks for the same input, every time', () => {
		const first = chunkParagraphs(source);
		const second = chunkParagraphs(source);
		expect(second).toEqual(first);
		expect(second.join(' ')).toBe(first.join(' '));
	});

	it('yields the same chunks whichever order the books were chunked in', () => {
		const other = [paragraph(1200, 'otra'), paragraph(200, 'otra')].join('\n\n');
		const alone = chunkParagraphs(source);
		chunkParagraphs(other);
		expect(chunkParagraphs(source)).toEqual(alone);
	});
});

describe('module purity (the seam of ADR-0015, asserted rather than conventional)', () => {
	const raw = readFileSync(fileURLToPath(new URL('./chunker.ts', import.meta.url)), 'utf8');
	/** Comments explain these names; only CODE naming them would be a violation. */
	const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
	const imports = code.match(/^import .*$/gm) ?? [];

	it('imports the measure and nothing else — no component, no $app, no $env', () => {
		expect(imports).toHaveLength(1);
		expect(imports[0]).toContain('./measure.js');
	});

	it('names no DOM global: the line budget is an estimate, never a measurement', () => {
		expect(code).not.toMatch(
			/\b(window|document|navigator|getComputedStyle|localStorage|requestAnimationFrame)\b/
		);
	});

	it('reads no clock and no randomness — the same input must chunk the same way forever', () => {
		expect(code).not.toMatch(/Date\.now\(\)|Math\.random\(\)|new Date\b/);
	});
});

/*
 * The Phase 1 fixtures are the only hand-authored worked example of the intended rhythm. Under
 * the page model they are ~3x too small to be a chunk each, so the assertion is no longer about
 * a comparable count — it is that re-chunking them is lossless and yields FEWER, larger pages.
 */
describe('chunkParagraphs against the hand-chunked fixtures', () => {
	for (const text of fixtureTexts) {
		it(`groups ${text.id} into fewer, larger pages without losing a character`, () => {
			const source = text.chunks.map((chunk) => chunk.content).join('\n\n');
			const produced = chunkParagraphs(source);
			expect(produced.length).toBeLessThanOrEqual(text.chunks.length);
			expect(produced.join('\n').replaceAll('\n', ' ')).toBe(
				source.replaceAll('\n\n', ' ').replaceAll('\n', ' ')
			);
		});
	}
});
