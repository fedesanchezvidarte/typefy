/**
 * Generates the seed migration from src/lib/fixtures/, keeping the fixtures the single
 * source of the Phase 1 book content (spec #7). Run via `npm run db:seed:generate`.
 *
 * Output is a committed migration (not supabase/seed.sql) so the books deploy to the
 * hosted project with `supabase db push`, not just to local resets. The file name is
 * fixed so regenerating overwrites in place rather than accumulating migrations.
 *
 * Chunks link to their book by `slug` via a subselect, so book UUIDs stay
 * server-generated and the seed carries no hardcoded ids.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fixtureTexts } from '../src/lib/fixtures/index.ts';

const OUTPUT = '20260722163000_seed_books.sql';

/** SQL string literal: wrap in single quotes, escaping embedded single quotes. */
function sql(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

const parts: string[] = [
	'-- GENERATED FILE — do not edit by hand.',
	'-- Regenerate with: npm run db:seed:generate (source: src/lib/fixtures/).',
	'--',
	'-- Seeds the Phase 1 fixture books verbatim (spec #7). Both books are kept so the',
	'-- UI-locale-vs-content-language independence rule stays verifiable end to end.',
	''
];

for (const text of fixtureTexts) {
	parts.push(`-- ${text.title} (${text.language}) — ${text.chunks.length} chunks`);
	parts.push(
		'insert into books (slug, title, author, language, chunk_count)',
		`values (${sql(text.id)}, ${sql(text.title)}, ${sql(text.author)}, ${sql(text.language)}, ${text.chunkCount});`,
		''
	);
	parts.push('insert into chunks (book_id, "index", content, char_count) values');
	const rows = text.chunks.map(
		(chunk) =>
			`\t((select id from books where slug = ${sql(text.id)}), ${chunk.index}, ${sql(chunk.content)}, ${chunk.charCount})`
	);
	parts.push(rows.join(',\n') + ';', '');
}

const outPath = resolve(
	dirname(fileURLToPath(import.meta.url)),
	'..',
	'supabase',
	'migrations',
	OUTPUT
);
writeFileSync(outPath, parts.join('\n'), 'utf8');
console.log(`Wrote ${outPath} (${fixtureTexts.length} books).`);
