import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseManifest } from '../../src/lib/ingest/manifest.js';

/**
 * The editorial rules for the shipped catalog's blurbs (spec #55).
 *
 * Deliberately NOT in `parseManifest`. That function enforces the structural rule — a
 * non-empty `summary` per UI locale — because it is a truth about the manifest format, and it
 * must hold for any manifest the ingest is pointed at. Length and "no markdown characters" are
 * house style for THIS file: they come from the size of the panel and from the fact that
 * `BookFacts.svelte` renders a plain paragraph. Putting them in the validator would impose a
 * word count on the test fixtures, whose absent and partial summaries are deliberate
 * `resolveSummary` coverage.
 *
 * So this suite reads the real `books.json` and nothing else. It is the cheapest thing that
 * fails when a blurb added next year arrives with a Wikipedia citation marker still in it.
 */

const manifestPath = join(dirname(fileURLToPath(import.meta.url)), 'books.json');
const result = parseManifest(readFileSync(manifestPath, 'utf8'));

const LOCALES = ['en', 'es'] as const;

/** The panel is a small card under the facts list; the old data ran from 74 to 2,676. */
const MIN_LENGTH = 400;
const MAX_LENGTH = 900;

/**
 * Characters that betray prose lifted from a marked-up source: `*` for markdown emphasis,
 * brackets for footnote and citation markers. `BookFacts.svelte` renders a plain `<p>`, so
 * every one of these reaches the reader literally — which is what six of the shipped Open
 * Library descriptions used to do.
 */
const MARKUP = /[*[\]]/;

describe('the shipped catalog manifest', () => {
	it('parses without problems', () => {
		if (!result.ok) {
			throw new Error(`books.json is invalid:\n${result.problems.join('\n')}`);
		}
		expect(result.books.length).toBeGreaterThan(0);
	});

	const books = result.ok ? result.books : [];

	describe.each(books.map((book) => [book.slug, book] as const))('%s', (slug, book) => {
		it.each(LOCALES)('declares a %s blurb', (locale) => {
			expect(book.summary?.[locale], `${slug}: missing summary.${locale}`).toBeTruthy();
		});

		it.each(LOCALES)('keeps the %s blurb within the panel budget', (locale) => {
			const length = (book.summary?.[locale] ?? '').trim().length;
			expect(length, `${slug}: summary.${locale} is ${length} characters`).toBeGreaterThanOrEqual(
				MIN_LENGTH
			);
			expect(length, `${slug}: summary.${locale} is ${length} characters`).toBeLessThanOrEqual(
				MAX_LENGTH
			);
		});

		it.each(LOCALES)('writes the %s blurb as plain prose', (locale) => {
			const text = book.summary?.[locale] ?? '';
			expect(MARKUP.test(text), `${slug}: summary.${locale} contains markup characters`).toBe(
				false
			);
		});
	});
});
