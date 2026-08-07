import { expect, test } from '@playwright/test';
import { anonClient } from './support/supabase';

/**
 * The typeable character set, asserted against every PUBLISHED book's real chunk content
 * (spec #26, gap G1; [ADR-0013](../docs/adr/0013-typeable-character-set.md)).
 *
 * A database-level check, no browser opened — the same shape `rls.e2e.ts` and
 * `resume-rpc.e2e.ts` use for their own PostgREST-direct assertions. `anonClient()` is
 * deliberate: it is the same read path a real client makes, and it also means this test needs
 * no throwaway user and no `isLocalStack` guard — it is exactly as safe to run against a
 * hosted project as `npm run check:i18n` is.
 *
 * The allowed set is mirrored HERE BY HAND rather than imported from `src/lib/ingest/`. The
 * point of this test is a check independent of the implementation it is guarding: an ingestion
 * regression that started writing an unfoldable character would still pass every unit test
 * built against the same regex it broke, but it cannot pass this one, because this one owns no
 * code path in common with ingestion at all.
 */

/**
 * Printable ASCII (U+0020–U+007E), the newline, and the accented/punctuation characters an
 * English or Spanish keyboard produces — copied character-for-character from CONTEXT.md's
 * "Typeable character set" glossary entry and ADR-0013, not derived from `src/lib/ingest/`.
 */
const TYPEABLE_CHARACTER_SET_REGEX = /^[\x20-\x7E\náéíóúüñÁÉÍÓÚÜÑ¿¡\n]*$/u;

/** The offending codepoints in `content`, each reported once with its position. */
function violations(content: string): string[] {
	const found: string[] = [];
	for (const [index, char] of [...content].entries()) {
		if (!TYPEABLE_CHARACTER_SET_REGEX.test(char)) {
			found.push(
				`U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')} (${JSON.stringify(char)}) at index ${index}`
			);
		}
	}
	return found;
}

test.describe('every published book stays inside the typeable character set', () => {
	test('no published chunk contains a character outside printable ASCII, newline, or the accented/punctuation set', async () => {
		const anon = anonClient();

		const books = await anon
			.from('books')
			.select('id, slug, published_at')
			.not('published_at', 'is', null);
		expect(books.error, `reading published books failed: ${books.error?.message}`).toBeNull();
		expect(
			books.data!.length,
			'the local stack must be seeded and publish at least one book (npm run db:reset)'
		).toBeGreaterThan(0);

		const bySlug = new Map(books.data!.map((book) => [book.id, book.slug]));

		const chunks = await anon
			.from('chunks')
			.select('id, book_id, index, content')
			.in('book_id', [...bySlug.keys()]);
		expect(chunks.error, `reading published chunks failed: ${chunks.error?.message}`).toBeNull();
		expect(
			chunks.data!.length,
			'every published book should have at least one readable chunk'
		).toBeGreaterThan(0);

		const offenders: string[] = [];
		for (const chunk of chunks.data!) {
			const bad = violations(chunk.content);
			if (bad.length > 0) {
				const slug = bySlug.get(chunk.book_id) ?? chunk.book_id;
				offenders.push(`${slug} #${chunk.index} (chunk ${chunk.id}): ${bad.join(', ')}`);
			}
		}

		expect(
			offenders,
			`chunk content outside the typeable character set:\n${offenders.join('\n')}`
		).toEqual([]);
	});
});
