import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CHARS_PER_LINE, MAX_CHARS, MAX_LINES, lineCost } from './measure.js';

/**
 * The page measure (spec #32, ADR-0005 amendment / ADR-0015).
 *
 * These three numbers are a contract between two layers that cannot see each other: the
 * chunker's line budget and the typing surface's CSS `ch` measure. The tests below pin the
 * values themselves, because "someone cleaned up a magic number" is the failure mode this
 * module exists to make impossible.
 */

describe('the measure constants', () => {
	it('fixes the nominal line at 66 characters — the value the surface pins its `ch` measure to', () => {
		expect(CHARS_PER_LINE).toBe(66);
	});

	it('fixes the page at 24 estimated rendered lines', () => {
		expect(MAX_LINES).toBe(24);
	});

	it('backstops characters at 1600, just above 24 x 66, so both budgets bind together on dense prose', () => {
		expect(MAX_CHARS).toBe(1600);
		expect(MAX_LINES * CHARS_PER_LINE).toBe(1584);
		expect(MAX_CHARS).toBeGreaterThan(MAX_LINES * CHARS_PER_LINE);
	});
});

describe('lineCost', () => {
	it('costs a paragraph that fits on one line exactly one line', () => {
		expect(lineCost('a'.repeat(1))).toBe(1);
		expect(lineCost('a'.repeat(CHARS_PER_LINE))).toBe(1);
	});

	it('costs one character past the measure a second line', () => {
		expect(lineCost('a'.repeat(CHARS_PER_LINE + 1))).toBe(2);
	});

	it('rounds a partial line up — a paragraph never shares a rendered line with the next', () => {
		expect(lineCost('a'.repeat(CHARS_PER_LINE * 3 + 1))).toBe(4);
		expect(lineCost('a'.repeat(CHARS_PER_LINE * 4))).toBe(4);
	});

	it('costs an empty paragraph one line, never zero — a blank line still occupies the screen', () => {
		expect(lineCost('')).toBe(1);
	});

	it('counts code points, so an accented character costs the same as an unaccented one', () => {
		// `á` as one precomposed code point: the chunker measures what the surface renders.
		expect(lineCost('á'.repeat(CHARS_PER_LINE))).toBe(1);
	});
});

describe('module purity (the seam of ADR-0015, asserted rather than conventional)', () => {
	const source = readFileSync(fileURLToPath(new URL('./measure.ts', import.meta.url)), 'utf8');
	const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

	it('imports nothing at all — this is what lets the typing surface take the measure without the splitter', () => {
		expect(code).not.toMatch(/^\s*import\b/m);
	});

	it('names no DOM global: the line budget is an estimate against a nominal measure, never a measurement', () => {
		expect(code).not.toMatch(/\b(window|document|navigator|getComputedStyle|localStorage)\b/);
	});
});
