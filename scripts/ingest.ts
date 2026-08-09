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
 * The order below is deliberate: **validate the manifest and the covers, then read the key**.
 * A malformed manifest — or a cover that is the wrong shape, too large, not actually a PNG or
 * JPEG, or missing entirely — fails before any privileged credential is in memory.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createInterface } from 'node:readline/promises';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseManifest, type BookManifestEntry } from '../src/lib/ingest/manifest.ts';
import { cleanSource } from '../src/lib/ingest/clean.ts';
import { findDisallowed } from '../src/lib/ingest/characters.ts';
import { buildReport } from '../src/lib/ingest/report.ts';
import {
	coverContentType,
	coverObjectPath,
	validateCover,
	type CoverImage
} from '../src/lib/ingest/cover.ts';
import { chunkParagraphs } from '../src/lib/chunking/chunker.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = resolve(ROOT, 'scripts/catalog/books.json');
const REPORTS = resolve(ROOT, 'scripts/catalog/reports');
const CACHE = resolve(ROOT, '.cache/sources');
const ENV_FILE = resolve(ROOT, '.env.ingest');
const COVERS_BUCKET = 'covers';

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
	allowRecut: boolean;
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
  --allow-recut          Permit a re-chunking that REWRITES existing chunk content under a
                          stable id. Reports the cost first. Orthogonal to --allow-shrink.
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
		allowRecut: flags.has('--allow-recut'),
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

interface PreparedCover {
	/** Read once, here, and reused for the upload — the bytes validated are the bytes sent. */
	bytes: Uint8Array;
	image: CoverImage;
	license: string;
	source: string;
}

interface PreparedBook {
	entry: BookManifestEntry;
	chunks: string[];
	disallowed: ReturnType<typeof findDisallowed>;
	/** Absent when the manifest entry declares no cover — which CLEARS `cover_url` on write. */
	cover?: PreparedCover;
}

/**
 * The manifest's cover, read and validated — or `undefined` when the entry declares none.
 *
 * Runs inside `prepare()`, i.e. **before any credential is read**, which extends the file's
 * ordering discipline from "a malformed manifest fails before a privileged credential is in
 * memory" to a malformed cover. A rejection is therefore a refusal with no key loaded, no
 * client constructed and nothing uploaded.
 *
 * The manifest is hand-edited, so the resolved path is asserted to stay inside `ROOT`:
 * `cover` names a file in this repository, and it must not become a way to read
 * `../../../.ssh/id_rsa` and post it to Storage. The pairing with `coverLicense` /
 * `coverSource` is already enforced by `parseManifest`.
 */
function readCover(entry: BookManifestEntry): PreparedCover | undefined {
	if (!entry.cover) {
		return undefined;
	}

	const path = resolve(ROOT, entry.cover);
	if (!path.startsWith(ROOT + sep)) {
		fail(
			`${entry.slug}: \`cover\` "${entry.cover}" resolves outside the repository.\n` +
				`  Covers live in scripts/catalog/covers/ and are committed alongside the manifest.`
		);
	}
	if (!existsSync(path)) {
		fail(
			`${entry.slug}: no cover file at ${path.replace(ROOT, '.')}.\n` +
				`  The manifest names it, so it must be committed — an uncommitted cover makes this\n` +
				`  ingest unreproducible on another machine.`
		);
	}

	const bytes = new Uint8Array(readFileSync(path));
	const result = validateCover(entry.slug, bytes);
	if (!result.ok) {
		fail(
			`Cover rejected:\n${result.problems.map((problem) => `  - ${problem}`).join('\n')}\n` +
				`  Ingestion validates covers and never transforms them (spec #19 §2).`
		);
	}

	return {
		bytes,
		image: result.image,
		// `parseManifest` guarantees both are present whenever `cover` is.
		license: entry.coverLicense!,
		source: entry.coverSource!
	};
}

async function prepare(entry: BookManifestEntry, options: Options): Promise<PreparedBook> {
	const raw = await readSource(entry, options.refresh);
	const cleaned = cleanSource(raw, entry.cleaning);
	return {
		entry,
		chunks: chunkParagraphs(cleaned),
		disallowed: findDisallowed(cleaned),
		cover: readCover(entry)
	};
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
			disallowed: prepared.disallowed,
			// The licence claim belongs in the artefact being reviewed; a claim nobody reads is a
			// claim nobody reviews. Omitted entirely for a book with no cover.
			...(prepared.cover
				? {
						cover: {
							image: prepared.cover.image,
							license: prepared.cover.license,
							source: prepared.cover.source
						}
					}
				: {})
		}),
		'utf8'
	);
	return path;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Uploads the cover and writes `books.cover_url` — **always**, to the public URL or to `null`.
 *
 * The null branch is the one that is easy to miss: removing `cover` from a manifest entry and
 * re-ingesting must CLEAR the column, or a cover the maintainer deleted lingers in the catalog
 * forever. The manifest is the source of truth for what the catalog is, including for the
 * absence of a cover.
 *
 * The object key is derived from the slug (`coverObjectPath`), so a re-ingest overwrites its
 * own cover and can never touch another book's; `upsert: true` is what makes that overwrite
 * rather than conflict. The bucket independently enforces the size and MIME limits — but the
 * readable refusal already happened during `prepare()`, and this is only the backstop.
 *
 * Called after the shrink guard on purpose: that guard's whole claim is that it runs before
 * any write, and an upload ahead of it would quietly make the comment false.
 */
async function writeCover(
	client: SupabaseClient,
	prepared: PreparedBook,
	bookId: string
): Promise<void> {
	const { entry, cover } = prepared;
	let coverUrl: string | null = null;

	if (cover) {
		const path = coverObjectPath(entry.slug, cover.image.format);
		const { error } = await client.storage.from(COVERS_BUCKET).upload(path, cover.bytes, {
			upsert: true,
			contentType: coverContentType(cover.image.format)
		});
		if (error) {
			fail(
				`${entry.slug}: uploading the cover to ${COVERS_BUCKET}/${path} failed — ${error.message}`
			);
		}
		coverUrl = client.storage.from(COVERS_BUCKET).getPublicUrl(path).data.publicUrl;
	}

	const { error } = await client.from('books').update({ cover_url: coverUrl }).eq('id', bookId);
	if (error) fail(`${entry.slug}: writing cover_url failed — ${error.message}`);
}

/** Counts distinct `user_id`s among the `chunk_attempts` rows attached to `chunkIds`. */
async function countAttemptsAtRisk(
	client: SupabaseClient,
	slug: string,
	chunkIds: readonly string[],
	action: string
): Promise<{ count: number; users: number }> {
	if (chunkIds.length === 0) {
		return { count: 0, users: 0 };
	}
	// A failure here must be fatal, never swallowed. This count IS the safety mechanism, and an
	// error read as an empty result reports "this is free" about a chunk that may carry a
	// user's history — the one direction a safety check must never fail in. (It did exactly
	// that until `service_role` was granted SELECT on chunk_attempts.)
	const { data, error } = await client
		.from('chunk_attempts')
		.select('user_id')
		.in('chunk_id', chunkIds);
	if (error) {
		fail(
			`${slug}: could not count the attempts at risk from ${action} — ${error.message}\n` +
				`  Refusing to proceed without knowing what it would affect.`
		);
	}
	const users = new Set((data ?? []).map((row) => row.user_id as string));
	return { count: data?.length ?? 0, users: users.size };
}

/**
 * The shrink guard's cost, read-only (spec #17 §7, unchanged by spec #32 beyond extraction
 * into its own function so it can be computed and reported ALONGSIDE the recut cost rather
 * than as its own separate refusal — see `writeBook`).
 *
 * Covers indices `>= newLength`: a re-chunking that yields fewer chunks than exist, whose
 * trailing rows would otherwise be deleted (and their `chunk_attempts` cascaded away) with no
 * chance to reconsider.
 */
async function computeShrinkCost(
	client: SupabaseClient,
	bookId: string,
	slug: string,
	newLength: number
): Promise<{ message: string; doomedIds: string[] } | null> {
	const { count: existingCount } = await client
		.from('chunks')
		.select('id', { count: 'exact', head: true })
		.eq('book_id', bookId);

	if ((existingCount ?? 0) <= newLength) {
		return null;
	}

	const doomed = await client
		.from('chunks')
		.select('id')
		.eq('book_id', bookId)
		.gte('index', newLength);
	if (doomed.error) {
		fail(`${slug}: could not list the chunks at risk from shrinking — ${doomed.error.message}`);
	}
	const doomedIds = (doomed.data ?? []).map((row) => row.id as string);
	const { count, users } = await countAttemptsAtRisk(client, slug, doomedIds, 'shrinking');

	return {
		doomedIds,
		message:
			`${slug}: re-chunking yields ${newLength} chunks but ${existingCount} exist.\n` +
			`  Removing ${doomedIds.length} chunk(s) would cascade away ` +
			`${count} recorded attempt(s) across ${users} user(s).`
	};
}

/** Rows read per page against the recut guard's existing-content check. See its own comment. */
const RECUT_PAGE_SIZE = 500;

/**
 * Every `(index, content)` pair currently stored for this book at `index < upperBound`,
 * PAGINATED with `.range()` (spec #32 §4).
 *
 * **Why pagination is not optional.** PostgREST caps a response at 1,000 rows by default, and
 * books in this catalog run to more than that. An unpaginated `.select()` would silently
 * return a truncated set, and the recut guard would report "nothing at risk" about content it
 * never looked at — the one direction a safety check must never fail in, and precisely the
 * truncation class spec #18 exists to have removed everywhere else in this codebase.
 *
 * A partial-read error is FATAL, following the existing precedent at the shrink guard's
 * attempt count (and, before this rewrite, at `ingest.ts`'s original 427–440) verbatim: an
 * error here must never be read as "no rows", because that reads as "nothing at risk."
 */
async function readExistingContent(
	client: SupabaseClient,
	bookId: string,
	slug: string,
	upperBound: number
): Promise<{ id: string; index: number; content: string }[]> {
	const rows: { id: string; index: number; content: string }[] = [];
	if (upperBound <= 0) {
		return rows;
	}

	let offset = 0;
	for (;;) {
		const { data, error } = await client
			.from('chunks')
			.select('id, index, content')
			.eq('book_id', bookId)
			.lt('index', upperBound)
			.order('index', { ascending: true })
			.range(offset, offset + RECUT_PAGE_SIZE - 1);

		if (error) {
			fail(
				`${slug}: could not read existing chunk content at offset ${offset} — ${error.message}\n` +
					`  Refusing to report the recut cost from a partial read.`
			);
		}

		const page = (data ?? []) as { id: string; index: number; content: string }[];
		rows.push(...page);
		if (page.length < RECUT_PAGE_SIZE) {
			break;
		}
		offset += RECUT_PAGE_SIZE;
	}

	return rows;
}

/**
 * The recut guard's cost, read-only and paginated (spec #32 §4).
 *
 * Covers indices `< newChunks.length`: chunks upsert on `(book_id, index)` and never send an
 * id, so a re-chunking whose content differs at an index that already exists overwrites that
 * row's content under its STABLE id. `chunk_attempts` keeps pointing at a real row — the
 * shrink guard's protection does not apply — but the text under it is no longer what was
 * typed. Silently wrong bests, which is worse than no bests. This is the hole the existing
 * shrink guard (deletion only) never covered.
 */
async function computeRecutCost(
	client: SupabaseClient,
	bookId: string,
	slug: string,
	newChunks: readonly string[]
): Promise<{ message: string } | null> {
	const existing = await readExistingContent(client, bookId, slug, newChunks.length);
	const rewrittenIds = existing
		.filter((row) => row.content !== newChunks[row.index])
		.map((row) => row.id);

	if (rewrittenIds.length === 0) {
		return null;
	}

	const { count, users } = await countAttemptsAtRisk(client, slug, rewrittenIds, 're-cutting');

	return {
		message:
			`${slug}: re-chunking rewrites the content of ${rewrittenIds.length} chunk(s) that already exist.\n` +
			`  Those chunks carry ${count} recorded attempt(s) across ${users} user(s), whose bests\n` +
			`  and completions would survive pointing at text that no longer exists there.`
	};
}

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
				license: entry.license,
				// The landing hero's book (spec #18 §7). The manifest validator already refuses
				// two featured entries in one language; `books_featured_per_language_idx` is the
				// database's own copy of that rule, and it is what catches the case the manifest
				// cannot see — a book featured by an EARLIER ingest that this run does not touch.
				featured: entry.featured
			},
			{ onConflict: 'slug' }
		)
		.select('id')
		.single();
	if (bookError) {
		// Moving the hero between books FAILS LOUDLY rather than auto-unfeaturing the incumbent.
		// Silently clearing another book's flag would make ingesting one book mutate a different
		// one, and would change the landing page as a side effect of an unrelated re-ingest —
		// exactly the kind of surprise the shrink guard above exists to prevent. The operator
		// unfeatures the current holder in the manifest and re-ingests it: one extra command,
		// and both halves of the change are visible in the manifest diff.
		if (bookError.code === '23505' && bookError.message.includes('featured')) {
			fail(
				`${entry.slug}: another book is already featured for language "${entry.language}".\n` +
					`  Refusing to move the landing hero as a side effect of this ingest.\n` +
					`  Set "featured": false on the current holder in scripts/catalog/books.json,\n` +
					`  re-ingest THAT book, then re-run this one.`
			);
		}
		fail(`${entry.slug}: writing the book row failed — ${bookError.message}`);
	}

	const bookId = book!.id as string;

	// Both guards run BEFORE any write, and BOTH costs are computed before either is reported:
	// after a write, the evidence of what would be lost is gone, and an operator who fixes one
	// flag and immediately hits the other has been shown the cost twice and the whole cost
	// never (spec #32 §4). Neither guard implies the other — shrink covers indices
	// `>= chunks.length` (deletion), recut covers indices `< chunks.length` (overwrite) — so
	// together they cover the whole index space.
	const shrinkCost = await computeShrinkCost(client, bookId, entry.slug, chunks.length);
	const recutCost = await computeRecutCost(client, bookId, entry.slug, chunks);

	const messages: string[] = [];
	if (shrinkCost) messages.push(shrinkCost.message);
	if (recutCost) messages.push(recutCost.message);

	if (messages.length > 0) {
		const refusals: string[] = [];
		if (shrinkCost && !options.allowShrink) {
			refusals.push('--allow-shrink');
		}
		if (recutCost && !options.allowRecut) {
			refusals.push('--allow-recut');
		}
		if (refusals.length > 0) {
			fail(
				`${messages.join('\n')}\n` +
					`  Refusing. Re-run with ${refusals.join(' and ')} if this is genuinely intended.`
			);
		}
		console.warn(`  ${messages.join('\n  ')}\n  Authorised; proceeding.`);
	}

	if (shrinkCost) {
		const { error } = await client.from('chunks').delete().in('id', shrinkCost.doomedIds);
		if (error) fail(`${entry.slug}: deleting trailing chunks failed — ${error.message}`);
	}

	await writeCover(client, prepared, bookId);

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
		if (book.cover) {
			const { format, width, height, bytes } = book.cover.image;
			console.log(`  cover: ${format} ${width}x${height}, ${Math.round(bytes / 1024)} KB`);
		}
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
		// Covers are validated above and are deliberately NOT uploaded here: a dry run touches
		// no remote state, and Storage is remote state.
		console.log('\n--dry-run: reports written, database and storage untouched.');
		process.exit(0);
	}

	// 3. Credentials, only now.
	loadEnvFile(ENV_FILE);
	const { url, key } = credentialsFor(options.target);

	// 4. Say what will happen before doing it.
	console.log(`\nTarget: ${options.target} (${url})`);
	for (const book of prepared) {
		// "clearing cover" is worth saying out loud: it is a deletion the manifest asked for by
		// omission, and the operator should see it before it happens rather than afterwards.
		const cover = book.cover ? ' + cover' : ' + clearing cover';
		console.log(
			`  ${book.entry.slug}: ${book.chunks.length} chunks${cover}${options.publish ? ' + publish' : ''}`
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
