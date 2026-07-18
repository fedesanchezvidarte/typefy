import { describe, expect, it } from 'vitest';
import { diffMessageKeys } from './parity.js';
import en from '../../../messages/en.json';
import es from '../../../messages/es.json';

describe('diffMessageKeys', () => {
	it('reports no differences for identical key sets', () => {
		expect(diffMessageKeys({ a: 1, b: 2 }, { a: 'x', b: 'y' })).toEqual({
			missingInA: [],
			missingInB: []
		});
	});

	it('reports keys missing on either side', () => {
		expect(diffMessageKeys({ a: 1 }, { b: 2 })).toEqual({
			missingInA: ['b'],
			missingInB: ['a']
		});
	});

	it('ignores $-prefixed metadata keys like $schema', () => {
		expect(diffMessageKeys({ $schema: 'x', a: 1 }, { a: 2 })).toEqual({
			missingInA: [],
			missingInB: []
		});
	});

	it('holds for the real EN/ES message bundles', () => {
		expect(diffMessageKeys(en, es)).toEqual({ missingInA: [], missingInB: [] });
	});
});
