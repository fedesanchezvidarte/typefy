import { describe, expect, it } from 'vitest';
import { contrastRatio, meetsAA } from './contrast';

/**
 * WCAG 2.x relative-luminance + contrast-ratio math (spec #25 §1), hand-rolled per the brief:
 * this is ~20 lines of a well-specified formula, not something worth a dependency for.
 */

describe('contrastRatio', () => {
	it('is 21:1 for black on white — the maximum possible ratio', () => {
		expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 1);
	});

	it('is 1:1 for a colour against itself', () => {
		expect(contrastRatio('#777777', '#777777')).toBeCloseTo(1, 5);
	});

	it('is symmetric — argument order does not matter', () => {
		expect(contrastRatio('#2A251E', '#F3EDE2')).toBeCloseTo(
			contrastRatio('#F3EDE2', '#2A251E'),
			10
		);
	});

	it('accepts lowercase hex', () => {
		expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
	});

	it('matches a known reference ratio (#767676 on #FFFFFF is the WCAG 4.5:1 boundary example)', () => {
		expect(contrastRatio('#767676', '#FFFFFF')).toBeCloseTo(4.54, 1);
	});

	it('accepts a hex string with no leading #', () => {
		expect(contrastRatio('000000', 'ffffff')).toBeCloseTo(21, 1);
	});

	it('throws on a 3-digit shorthand hex — this module only accepts 6-digit hex', () => {
		expect(() => contrastRatio('#fff', '#000')).toThrow(/Not a 6-digit hex colour/);
	});

	it('throws on a non-hex string', () => {
		expect(() => contrastRatio('not-a-colour', '#000000')).toThrow(/Not a 6-digit hex colour/);
	});

	it('throws on the wrong number of digits', () => {
		expect(() => contrastRatio('#12345', '#000000')).toThrow(/Not a 6-digit hex colour/);
		expect(() => contrastRatio('#1234567', '#000000')).toThrow(/Not a 6-digit hex colour/);
	});

	it('throws naming the SECOND argument too — either side can be the malformed one', () => {
		expect(() => contrastRatio('#000000', '#zzzzzz')).toThrow(/Not a 6-digit hex colour/);
	});
});

describe('meetsAA', () => {
	it('requires 4.5:1 for text', () => {
		expect(meetsAA(4.5, 'text')).toBe(true);
		expect(meetsAA(4.49, 'text')).toBe(false);
	});

	it('requires 3:1 for large text / non-text UI', () => {
		expect(meetsAA(3, 'ui')).toBe(true);
		expect(meetsAA(2.99, 'ui')).toBe(false);
	});

	it('a ratio that clears the text bar also clears the ui bar', () => {
		expect(meetsAA(4.5, 'ui')).toBe(true);
	});
});
