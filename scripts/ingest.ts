/**
 * Offline ingestion: a public-domain source text becomes `books` + `chunks` rows
 * (spec #17, ADR-0006).
 *
 * Run via `npm run ingest -- --target local` (see `--help`). This is the IO shell around the
 * pure modules in `src/lib/ingest/` and `src/lib/chunking/`: everything the network, the
 * filesystem and the database touch lives here, and nothing else does.
 *
 * ## Security
 *
 * This script authenticates with the **service-role key**, which bypasses RLS entirely and can
 * read or destroy every user's data. Therefore:
 *
 * - The key is read from `process.env` only, populated from a gitignored `.env.ingest`. Never
 *   through Vite's `import.meta.env`, never behind a `PUBLIC_` prefix — either would bundle it
 *   into the client.
 * - This file runs as a standalone `tsx` process, outside the SvelteKit build graph. Nothing
 *   under `src/` may import it, and it never imports `src/lib/supabase/`: the app must not gain
 *   a code path that can construct a service-role client.
 * - It never runs in CI. There is no workflow and no repository secret.
 * - `--target` is required and has no default. Against prod the script prints what it will
 *   write and waits for confirmation.
 *
 * The order below is deliberate: **validate the manifest, then read the key**. A malformed
 * manifest fails before any privileged credential is in memory.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createInterface } from 'node:readline/promises';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseManifest, type BookManifestEntry } from '../src/lib/ingest/manifest.ts';
import { cleanSource } from '../src/lib/ingest/clean.ts';
import { findDisallowed } from '../src/lib/ingest/characters.ts';
import { buildReport } from '../src/lib/ingest/report.ts';
import { chunkParagraphs } from '../src/lib/chunking/chunker.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = resolve(ROOT, 'scripts/catalog/books.json');
const REPORTS = resolve(ROOT, 'scripts/catalog/reports');
const CACHE = resolve(ROOT, '.cache/sources');
const ENV_FILE = resolve(ROOT, '.env.ingest');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Options {
	target: 'local' | 'prod';
	slug?: string;
	dryRun: boolean;
	refresh: boolean;
	publish: boolean;
	allowShrink: boolean;
	yes: boolean;
}

const USAGE = `
Usage: npm run ingest -- --target <local|prod> [options]

  --target <local|prod>  Required. Which database to write to. No default, deliberately.
  --slug <slug>          Ingest one book. Default: every book in the manifest.
  --dry-run              Fetch, clean and chunk; write the report; touch no database.
  --refresh              Re-download the source instead of using the cache.
  --publish              Set published_at, making the book visible. Never implied by ingestion.
  --allow-shrink         Permit a re-chunking that DELETES chunks. Reports the cost first.
  --yes                  Skip the confirmation prompt (prod writes only).
`;

function parseArguments(argv: readonly string[]): Options {
	const flags = new Set(argv.filter((argument) => argument.startsWith('--')));
	const valueOf = (name: string): string | undefined => {
		const index = argv.indexOf(`--${name}`);
		return index === -1 ? undefined : argv[index + 1];
	};

	if (flags.has('--help')) {
		console.log(USAGE);
		process.exit(0);
	}

	const target = valueOf('target');
	// No default: a script that can write to production must never guess where it is pointed.
	if (target !== 'local' && target !== 'prod') {
		fail(`--target is required and must be "local" or "prod".\n${USAGE}`);
	}

	return {
		target,
		slug: valueOf('slug'),
		dryRun: flags.has('--dry-run'),
		refresh: flags.has('--refresh'),
		publish: flags.has('--publish'),
		allowShrink: flags.has('--allow-shrink'),
		yes: flags.has('--yes')
	};
}

/** A refusal the operator should read, as opposed to a crash. */
class IngestError extends Error {}

/**
 * Stops the run with a message.
 *
 * Throws rather than calling `process.exit`. Exiting from inside async work while the Supabase
 * client still holds open handles aborts Node on Windows with a libuv assertion, which replaced
 * the intended exit code 1 with 127 — so a refusal looked like a crash, and a CI check on the
 * exit code would have read it as neither success nor a clean refusal.
 */
function fail(message: string): never {
	throw new IngestError(message);
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/**
 * Minimal `.env.ingest` reader — deliberately not a dependency.
 *
 * Values already present in `process.env` win, so a caller can export the variables instead of
 * keeping a file (which is how the local target works against `supabase status` output).
 */
function loadEnvFile(path: string): void {
	if (!existsSync(path)) return;
	for (const line of readFileSync(path, 'utf8').split('\n')) {
		const trimmed = line.trim();
		if (trimmed === '' || trimmed.startsWith('#')) continue;
		const separator = trimmed.indexOf('=');
		if (separator === -1) continue;
		const key = trimmed.slice(0, separator).trim();
		const value = trimmed
			.slice(separator + 1)
			.trim()
			.replace(/^["']|["']$/g, '');
		if (process.env[key] === undefined) {
			process.env[key] = value;
		}
	}
}

/** Per-target credentials, so a prod key can never be picked up by a local run by accident. */
function credentialsFor(target: Options['target']): { url: string; key: string } {
	const prefix = target === 'local' ? 'SUPABASE_LOCAL' : 'SUPABASE_PROD';
	const url = process.env[`${prefix}_URL`];
	const key = process.env[`${prefix}_SERVICE_ROLE_KEY`];
	if (!url || !key) {
		fail(
			`Missing ${prefix}_URL or ${prefix}_SERVICE_ROLE_KEY.\n` +
				`Put them in .env.ingest (gitignored) or export them before running.\n` +
				`Never commit a service-role key: it bypasses RLS and can read or destroy all user data.`
		);
	}
	return { url, key };
}

// ---------------------------------------------------------------------------
// Source acquisition
// ---------------------------------------------------------------------------

/**
 * The source text, from the cache when possible.
 *
 * Cached so re-runs never depend on the source being up or on its rate limits, and so the file
 * you inspect when a cleaner misbehaves is exactly the bytes that produced the output.
 */
async function readSource(book: BookManifestEntry, refresh: boolean): Promise<string> {
	const cached = resolve(CACHE, `${book.slug}.txt`);
	if (!refresh && existsSync(cached)) {
		return readFileSync(cached, 'utf8');
	}

	console.log(`  fetching ${book.sourceUrl}`);
	const response = await fetch(book.sourceUrl);
	if (!response.ok) {
		fail(`${book.slug}: source fetch failed with ${response.status} ${response.statusText}`);
	}
	const text = await response.text();
	mkdirSync(CACHE, { recursive: true });
	writeFileSync(cached, text, 'utf8');
	return text;
}

// ---------------------------------------------------------------------------
// Preparation — pure pipeline over one book
// ---------------------------------------------------------------------------

interface PreparedBook {
	entry: BookManifestEntry;
	chunks: string[];
	disallowed: ReturnType<typeof findDisallowed>;
}

async function prepare(entry: BookManifestEntry, options: Options): Promise<PreparedBook> {
	const raw = await readSource(entry, options.refresh);
	const cleaned = cleanSource(raw, entry.cleaning);
	return { entry, chunks: chunkParagraphs(cleaned), disallowed: findDisallowed(cleaned) };
}

function writeReport(prepared: PreparedBook): string {
	const path = resolve(REPORTS, `${prepared.entry.slug}.md`);
	mkdirSync(REPORTS, { recursive: true });
	writeFileSync(
		path,
		buildReport({
			slug: prepared.entry.slug,
			title: prepared.entry.title,
			sourceUrl: prepared.entry.sourceUrl,
			chunks: prepared.chunks,
			disallowed: prepared.disallowed
		}),
		'utf8'
	);
	return path;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Writes one book.
 *
 * Not transactional: PostgREST cannot span statements. That is acceptable *because of*
 * `published_at` — a partially written book is unpublished and therefore invisible to every
 * client, so the failure mode is an incomplete row nobody can reach rather than a broken book
 * in the catalog. The alternative, an RPC accepting arbitrary book JSON, is a far larger
 * security surface than the problem deserves (Feature Brief, #17).
 *
 * Chunks upsert on `(book_id, "index")` and chunk ids are never sent, so they stay
 * server-generated and **stable across a re-ingest** — which is what keeps `chunk_attempts`
 * and the rollups pointing at real rows.
 */
async function writeBook(
	client: SupabaseClient,
	prepared: PreparedBook,
	options: Options
): Promise<void> {
	const { entry, chunks } = prepared;

	const { data: book, error: bookError } = await client
		.from('books')
		.upsert(
			{
				slug: entry.slug,
				title: entry.title,
				author: entry.author,
				language: entry.language,
				chunk_count: chunks.length,
				source_url: entry.sourceUrl,
				license: entry.license
			},
			{ onConflict: 'slug' }
		)
		.select('id')
		.single();
	if (bookError) fail(`${entry.slug}: writing the book row failed — ${bookError.message}`);

	const bookId = book!.id as string;

	// The shrink guard runs BEFORE any write: after it, the evidence of what would be lost is
	// gone. Deleting a chunk cascades its chunk_attempts and chunk_progress rows away.
	const { count: existingCount } = await client
		.from('chunks')
		.select('id', { count: 'exact', head: true })
		.eq('book_id', bookId);

	if ((existingCount ?? 0) > chunks.length) {
		const doomed = await client
			.from('chunks')
			.select('id')
			.eq('book_id', bookId)
			.gte('index', chunks.length);
		if (doomed.error) {
			fail(`${entry.slug}: could not list the chunks at risk — ${doomed.error.message}`);
		}
		const doomedIds = (doomed.data ?? []).map((row) => row.id as string);

		// A failure here must be fatal, never swallowed. This count IS the safety mechanism, and
		// an error read as an empty result reports "deleting this is free" about a chunk that
		// may carry a user's history — the one direction a safety check must never fail in.
		// (It did exactly that until `service_role` was granted SELECT on chunk_attempts.)
		const { data: attempts, error: attemptsError } = await client
			.from('chunk_attempts')
			.select('user_id')
			.in('chunk_id', doomedIds);
		if (attemptsError) {
			fail(
				`${entry.slug}: could not count the attempts at risk — ${attemptsError.message}\n` +
					`  Refusing to delete chunks without knowing what it would destroy.`
			);
		}
		const users = new Set((attempts ?? []).map((row) => row.user_id as string));

		const cost =
			`${entry.slug}: re-chunking yields ${chunks.length} chunks but ${existingCount} exist.\n` +
			`  Removing ${doomedIds.length} chunk(s) would cascade away ` +
			`${attempts?.length ?? 0} recorded attempt(s) across ${users.size} user(s).`;

		if (!options.allowShrink) {
			fail(`${cost}\n  Refusing. Re-run with --allow-shrink if this is genuinely intended.`);
		}
		console.warn(`  ${cost}\n  --allow-shrink given; deleting.`);
		const { error } = await client.from('chunks').delete().in('id', doomedIds);
		if (error) fail(`${entry.slug}: deleting trailing chunks failed — ${error.message}`);
	}

	const rows = chunks.map((content, index) => ({
		book_id: bookId,
		index,
		content,
		char_count: content.length
	}));
	const { error: chunkError } = await client
		.from('chunks')
		.upsert(rows, { onConflict: 'book_id,index' });
	if (chunkError) fail(`${entry.slug}: writing chunks failed — ${chunkError.message}`);

	// Publishing is never implied by ingestion: a book becomes visible only after its report
	// has been read (spec #17 §1).
	if (options.publish) {
		const { error } = await client
			.from('books')
			.update({ published_at: new Date().toISOString() })
			.eq('id', bookId);
		if (error) fail(`${entry.slug}: publishing failed — ${error.message}`);
	}
}

async function confirm(question: string): Promise<boolean> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const answer = await rl.question(`${question} [y/N] `);
	rl.close();
	return answer.trim().toLowerCase() === 'y';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const options = parseArguments(process.argv.slice(2));

	// 1. Manifest first — before any credential is read.
	if (!existsSync(MANIFEST)) fail(`No manifest at ${MANIFEST}.`);
	const manifest = parseManifest(readFileSync(MANIFEST, 'utf8'));
	if (!manifest.ok) {
		fail(
			`Manifest is invalid:\n${manifest.problems.map((problem) => `  - ${problem}`).join('\n')}`
		);
	}

	const selected = options.slug
		? manifest.books.filter((book) => book.slug === options.slug)
		: manifest.books;
	if (selected.length === 0) fail(`No manifest entry with slug "${options.slug}".`);

	// 2. Pure pipeline. A disallowed character stops the run before anything is written — the
	//    report says exactly which character and where.
	console.log(`Preparing ${selected.length} book(s)…`);
	const prepared: PreparedBook[] = [];
	for (const entry of selected) {
		console.log(`\n${entry.slug}`);
		const book = await prepare(entry, options);
		const path = writeReport(book);
		console.log(`  ${book.chunks.length} chunks; report → ${path.replace(ROOT, '.')}`);
		if (book.disallowed.length > 0) {
			const summary = book.disallowed
				.map((entry) => `${entry.codePoint} (${entry.occurrences}x)`)
				.join(', ');
			fail(
				`${entry.slug}: ${book.disallowed.length} disallowed character(s): ${summary}\n` +
					`  See the report. Each one would make its passage impossible to complete.`
			);
		}
		prepared.push(book);
	}

	if (options.dryRun) {
		console.log('\n--dry-run: reports written, database untouched.');
		process.exit(0);
	}

	// 3. Credentials, only now.
	loadEnvFile(ENV_FILE);
	const { url, key } = credentialsFor(options.target);

	// 4. Say what will happen before doing it.
	console.log(`\nTarget: ${options.target} (${url})`);
	for (const book of prepared) {
		console.log(
			`  ${book.entry.slug}: ${book.chunks.length} chunks${options.publish ? ' + publish' : ''}`
		);
	}
	if (options.target === 'prod' && !options.yes) {
		if (!(await confirm('\nWrite these to PRODUCTION?'))) {
			console.log('Aborted; nothing written.');
			process.exit(0);
		}
	}

	// 5. Write.
	const client = createClient(url, key, { auth: { persistSession: false } });
	for (const book of prepared) {
		await writeBook(client, book, options);
		console.log(`  wrote ${book.entry.slug}`);
	}

	console.log(
		`\nDone. ${options.publish ? 'Published.' : 'Unpublished — run with --publish once the report is reviewed.'}`
	);
}

main().catch((error) => {
	// A refusal prints its message; anything else is a genuine crash and keeps its stack.
	if (error instanceof IngestError) {
		console.error(`\n${error.message}\n`);
	} else {
		console.error(error);
	}
	process.exitCode = 1;
});
