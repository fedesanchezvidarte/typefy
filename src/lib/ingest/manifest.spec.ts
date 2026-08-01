import { describe, expect, it } from 'vitest';
import { parseManifest } from './manifest.js';

const valid = {
	slug: 'pride-and-prejudice',
	title: 'Pride and Prejudice',
	author: 'Jane Austen',
	language: 'en',
	sourceUrl: 'https://www.gutenberg.org/cache/epub/1342/pg1342.txt',
	license: 'Public domain in the USA'
};

/** Serialises a manifest the way the committed file holds it. */
function manifest(...books: unknown[]): string {
	return JSON.stringify({ books });
}

/** Asserts failure and returns the problems, so each test states what it expects to read. */
function problemsOf(raw: string): string[] {
	const result = parseManifest(raw);
	if (result.ok) {
		throw new Error('expected the manifest to be rejected');
	}
	return result.problems;
}

describe('parseManifest — accepting', () => {
	it('accepts a minimal valid entry', () => {
		const result = parseManifest(manifest(valid));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.books).toHaveLength(1);
		expect(result.books[0].slug).toBe('pride-and-prejudice');
	});

	it('defaults featured to false rather than leaving it undefined', () => {
		const result = parseManifest(manifest(valid));
		if (!result.ok) throw new Error('expected acceptance');
		expect(result.books[0].featured).toBe(false);
	});

	it('carries cleaning overrides through untouched', () => {
		const result = parseManifest(
			manifest({ ...valid, cleaning: { startMarker: '<<A>>', endMarker: '<<B>>' } })
		);
		if (!result.ok) throw new Error('expected acceptance');
		expect(result.books[0].cleaning).toEqual({ startMarker: '<<A>>', endMarker: '<<B>>' });
	});

	it('accepts one featured book per language', () => {
		const result = parseManifest(
			manifest(
				{ ...valid, featured: true },
				{ ...valid, slug: 'quijote', language: 'es', featured: true }
			)
		);
		expect(result.ok).toBe(true);
	});

	it('accepts an empty catalog — a manifest with no books yet is not an error', () => {
		const result = parseManifest(manifest());
		expect(result.ok).toBe(true);
	});
});

describe('parseManifest — rejecting', () => {
	it('rejects malformed JSON without throwing', () => {
		expect(problemsOf('{ not json')[0]).toMatch(/json/i);
	});

	it('rejects a payload whose books property is not an array', () => {
		expect(problemsOf(JSON.stringify({ books: 'nope' })).join(' ')).toMatch(/books/i);
	});

	it('rejects a missing required field, naming the field and the entry', () => {
		const withoutTitle: Record<string, unknown> = { ...valid };
		delete withoutTitle.title;
		const problems = problemsOf(manifest(withoutTitle)).join(' ');
		expect(problems).toMatch(/title/);
		expect(problems).toMatch(/pride-and-prejudice/);
	});

	it('rejects an unknown content language', () => {
		expect(problemsOf(manifest({ ...valid, language: 'fr' })).join(' ')).toMatch(/language/i);
	});

	it('rejects a duplicate slug', () => {
		expect(problemsOf(manifest(valid, valid)).join(' ')).toMatch(/duplicate/i);
	});

	it('rejects a slug that is not URL-safe', () => {
		expect(problemsOf(manifest({ ...valid, slug: 'Pride & Prejudice' })).join(' ')).toMatch(
			/slug/i
		);
	});

	it('rejects a malformed source URL', () => {
		expect(problemsOf(manifest({ ...valid, sourceUrl: 'not-a-url' })).join(' ')).toMatch(/url/i);
	});

	it('rejects a source URL that is not http(s)', () => {
		expect(problemsOf(manifest({ ...valid, sourceUrl: 'file:///etc/passwd' })).join(' ')).toMatch(
			/url/i
		);
	});

	it('rejects more than one featured book in the same language', () => {
		const problems = problemsOf(
			manifest({ ...valid, featured: true }, { ...valid, slug: 'emma', featured: true })
		).join(' ');
		expect(problems).toMatch(/featured/i);
		expect(problems).toMatch(/en/);
	});

	it('rejects a cover without its licence and source, so a claim is never implicit', () => {
		const problems = problemsOf(manifest({ ...valid, cover: 'covers/pp.jpg' })).join(' ');
		expect(problems).toMatch(/coverLicense|coverSource/);
	});

	it('accepts a cover accompanied by both', () => {
		const result = parseManifest(
			manifest({
				...valid,
				cover: 'covers/pp.jpg',
				coverLicense: 'CC0',
				coverSource: 'https://example.org/cover'
			})
		);
		expect(result.ok).toBe(true);
	});

	it('reports every problem at once rather than stopping at the first', () => {
		const problems = problemsOf(manifest({ ...valid, language: 'fr', slug: 'Bad Slug' }));
		expect(problems.length).toBeGreaterThan(1);
	});
});
