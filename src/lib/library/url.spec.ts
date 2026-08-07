import { describe, expect, it } from 'vitest';
import { libraryHref } from './url.js';

/**
 * Builds `/type` URLs that always carry all three controls (spec #25 §2). One function is
 * what makes filter/search/sort compose — no component computes a URL by hand, so no control
 * can independently forget to carry one of the other two params.
 */

describe('libraryHref', () => {
	it('is always explicit about lang and sort', () => {
		expect(libraryHref({ language: 'all', query: null, sort: 'default' })).toBe(
			'/type?lang=all&sort=default'
		);
	});

	it('omits q when the query is null', () => {
		expect(libraryHref({ language: 'en', query: null, sort: 'title' })).toBe(
			'/type?lang=en&sort=title'
		);
	});

	it('includes q when a search is active', () => {
		expect(libraryHref({ language: 'en', query: 'quijote', sort: 'default' })).toBe(
			'/type?lang=en&sort=default&q=quijote'
		);
	});

	it('URL-encodes special characters in the query', () => {
		expect(libraryHref({ language: 'all', query: 'a & b', sort: 'default' })).toBe(
			'/type?lang=all&sort=default&q=a+%26+b'
		);
	});

	it('carries every language filter value', () => {
		expect(libraryHref({ language: 'es', query: null, sort: 'default' })).toBe(
			'/type?lang=es&sort=default'
		);
	});

	it('carries every sort value', () => {
		expect(libraryHref({ language: 'all', query: null, sort: 'length' })).toBe(
			'/type?lang=all&sort=length'
		);
	});

	it('omits q for an empty-string query too (never a bare "?q=")', () => {
		// libraryHref trusts its input to already be a resolved LibraryQueryState — query is
		// null or a real string, per parseSearchQuery's contract — but an accidental '' must
		// still not produce a dangling "&q=" in a URL some component built by hand.
		expect(libraryHref({ language: 'all', query: '', sort: 'default' })).toBe(
			'/type?lang=all&sort=default'
		);
	});
});
