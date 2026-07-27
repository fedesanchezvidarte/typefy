import { describe, expect, it } from 'vitest';
import { diffMessageKeys, messageMatchKeys } from './parity.js';
import en from '../../../messages/en.json';
import es from '../../../messages/es.json';

/** A pluralised message in `@inlang/plugin-message-format` shape. */
const plural = (arms: Record<string, string>) => [
	{
		declarations: ['input count', 'local countPlural = count: plural'],
		selectors: ['countPlural'],
		match: arms
	}
];

const BOTH_ARMS = { 'countPlural=one': 'One passage.', 'countPlural=*': '{count} passages.' };

describe('messageMatchKeys', () => {
	it('returns no arms for a flat string message', () => {
		expect(messageMatchKeys('Sign in to save your progress')).toEqual([]);
	});

	it('returns the sorted match keys of a variant message', () => {
		expect(messageMatchKeys(plural(BOTH_ARMS))).toEqual(['countPlural=*', 'countPlural=one']);
	});

	it('normalizes whitespace inside a match key', () => {
		expect(messageMatchKeys(plural({ 'countPlural = one': 'x' }))).toEqual(['countPlural=one']);
	});

	it('tolerates a malformed variant value without throwing', () => {
		expect(messageMatchKeys([])).toEqual([]);
		expect(messageMatchKeys([null])).toEqual([]);
		expect(messageMatchKeys([{ selectors: ['countPlural'] }])).toEqual([]);
	});
});

describe('diffMessageKeys', () => {
	it('reports no differences for identical key sets', () => {
		expect(diffMessageKeys({ a: 1, b: 2 }, { a: 'x', b: 'y' })).toEqual({
			missingInA: [],
			missingInB: [],
			variantMismatches: []
		});
	});

	it('reports keys missing on either side', () => {
		expect(diffMessageKeys({ a: 1 }, { b: 2 })).toEqual({
			missingInA: ['b'],
			missingInB: ['a'],
			variantMismatches: []
		});
	});

	it('ignores $-prefixed metadata keys like $schema', () => {
		expect(diffMessageKeys({ $schema: 'x', a: 1 }, { a: 2 })).toEqual({
			missingInA: [],
			missingInB: [],
			variantMismatches: []
		});
	});

	it('reports no mismatch when both sides declare the same variant arms', () => {
		expect(diffMessageKeys({ msg: plural(BOTH_ARMS) }, { msg: plural(BOTH_ARMS) })).toEqual({
			missingInA: [],
			missingInB: [],
			variantMismatches: []
		});
	});

	// The hole this check exists to close: one top-level key on both sides, so the
	// key-only diff passed, yet the locale cannot render `count === 1`.
	it('fails a locale that is missing a plural arm the base locale has', () => {
		const partial = { msg: plural({ 'countPlural=*': '{count} pasajes.' }) };

		expect(diffMessageKeys(partial, { msg: plural(BOTH_ARMS) })).toEqual({
			missingInA: [],
			missingInB: [],
			variantMismatches: [{ key: 'msg', missingInA: ['countPlural=one'], missingInB: [] }]
		});
	});

	it('fails the base locale when a locale declares an extra arm', () => {
		const extra = { msg: plural({ ...BOTH_ARMS, 'countPlural=many': 'un millón de pasajes.' }) };

		expect(diffMessageKeys(extra, { msg: plural(BOTH_ARMS) })).toEqual({
			missingInA: [],
			missingInB: [],
			variantMismatches: [{ key: 'msg', missingInA: [], missingInB: ['countPlural=many'] }]
		});
	});

	it('fails a message that is pluralised in one bundle and flat in the other', () => {
		expect(diffMessageKeys({ msg: 'Un pasaje.' }, { msg: plural(BOTH_ARMS) })).toEqual({
			missingInA: [],
			missingInB: [],
			variantMismatches: [
				{ key: 'msg', missingInA: ['countPlural=*', 'countPlural=one'], missingInB: [] }
			]
		});
	});

	it('holds for the real EN/ES message bundles', () => {
		expect(diffMessageKeys(en, es)).toEqual({
			missingInA: [],
			missingInB: [],
			variantMismatches: []
		});
	});
});
