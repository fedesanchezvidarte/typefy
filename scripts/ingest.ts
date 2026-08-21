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
import { extractHeadings } from '../src/lib/ingest/headings.ts';
import { alignChapters, type AlignChaptersResult } from '../src/lib/ingest/chapters.ts';
import { parseOpenLibraryWork } from '../src/lib/ingest/open-library.ts';

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

/**
 * The book's HTML edition, from the cache when possible — fetched **only** to learn where
 * chapters begin (spec #33). Returns `undefined` when the manifest declares no
 * `chaptersHtmlUrl`, never fetching when there is nothing to fetch.
 */
async function readChaptersHtml(
	book: BookManifestEntry,
	refresh: boolean
): Promise<string | undefined> {
	if (!book.chaptersHtmlUrl) {
		return undefined;
	}

	const cached = resolve(CACHE, `${book.slug}.chapters.html`);
	if (!refresh && existsSync(cached)) {
		return readFileSync(cached, 'utf8');
	}

	console.log(`  fetching ${book.chaptersHtmlUrl}`);
	const response = await fetch(book.chaptersHtmlUrl);
	if (!response.ok) {
		fail(`${book.slug}: chapters HTML fetch failed with ${response.status} ${response.statusText}`);
	}
	const html = await response.text();
	mkdirSync(CACHE, { recursive: true });
	writeFileSync(cached, html, 'utf8');
	return html;
}

/** Open Library is a courtesy dependency, not a critical one; it does not get to hang a run. */
const OPEN_LIBRARY_TIMEOUT_MS = 10_000;

/** One Open Library GET, decoded as JSON. Never throws; every failure is a readable reason. */
async function getJson(url: string): Promise<{ json: unknown } | { failure: string }> {
	let text: string;
	try {
		const response = await fetch(url, {
			signal: AbortSignal.timeout(OPEN_LIBRARY_TIMEOUT_MS),
			headers: { accept: 'application/json' }
		});
		if (!response.ok) {
			return {
				failure:
					`Open Library returned ${response.status} ${response.statusText}` +
					(response.status === 404 ? ' — check the work id in the manifest.' : '.')
			};
		}
		text = await response.text();
	} catch (cause) {
		return { failure: `Open Library request failed — ${(cause as Error).message}.` };
	}

	try {
		return { json: JSON.parse(text) };
	} catch (cause) {
		return { failure: `Open Library returned unparseable JSON — ${(cause as Error).message}.` };
	}
}

/**
 * The Open Library payload for one declared work id, from the cache when possible (spec #34).
 *
 * **Two requests, both addressed by the declared id, merged into one payload.** The work
 * document carries the description but *not* `first_publish_year`; that field exists only on a
 * search document, so it is requested as `q=key:/works/OL…W` — a lookup of one known id, not a
 * title search, which is the distinction the spec's "never by search" rule actually cares
 * about. (The work document's own `first_publish_date` is an edition date — "1853" for Pride
 * and Prejudice — and is never used; see `open-library.ts`.)
 *
 * Cached in the same `.cache/sources` directory and honouring the same `--refresh` flag as
 * `readSource` and `readChaptersHtml`, so a `--dry-run` after the first run costs no request.
 * Only a fully successful pair is cached, so a 404 or a timeout is retried on the next run
 * rather than frozen in. The cache is keyed on the **slug**, exactly as the source and
 * chapters caches are — so CHANGING a book's `openLibraryWork` needs `--refresh`, or the old
 * work's payload is reused. Same caveat, same shape, one rule to remember rather than three.
 *
 * Returns reasons instead of calling `fail()`: every failure here is non-fatal. A `failure`
 * alongside a `payload` is the partial case — the description arrived, the year lookup did
 * not — and it is reported rather than silently rendered as "no year".
 */
async function readOpenLibraryWork(
	work: string,
	slug: string,
	refresh: boolean
): Promise<{ payload?: unknown; failure?: string }> {
	const cached = resolve(CACHE, `${slug}.openlibrary.json`);
	if (!refresh && existsSync(cached)) {
		try {
			return { payload: JSON.parse(readFileSync(cached, 'utf8')) };
		} catch {
			// A corrupt cache file is not worth a refusal — re-fetch and overwrite it.
		}
	}

	const workUrl = `https://openlibrary.org${work}.json`;
	console.log(`  fetching ${workUrl}`);
	const document = await getJson(workUrl);
	if ('failure' in document) {
		return { failure: `${document.failure} (${work})` };
	}

	const searchUrl =
		`https://openlibrary.org/search.json?q=${encodeURIComponent(`key:${work}`)}` +
		`&fields=key,first_publish_year&limit=1`;
	const search = await getJson(searchUrl);
	if ('failure' in search) {
		// The description is still worth having, so this is a partial success, not a write-off.
		return {
			payload: document.json,
			failure: `the first publication year lookup for ${work} failed — ${search.failure}`
		};
	}

	const doc = (search.json as { docs?: { first_publish_year?: unknown }[] }).docs?.[0];
	const payload = {
		...(document.json as Record<string, unknown>),
		...(doc?.first_publish_year !== undefined ? { first_publish_year: doc.first_publish_year } : {})
	};

	mkdirSync(CACHE, { recursive: true });
	// The MERGED payload is what gets cached — the bytes inspected when a year or a blurb looks
	// wrong are then exactly the bytes `parseOpenLibraryWork` was handed, which is the same
	// property `readSource`'s cache exists for.
	writeFileSync(cached, JSON.stringify(payload, null, '\t'), 'utf8');
	return { payload };
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

/** The Open Library lookup's outcome for one book (spec #34). Never a reason to stop. */
interface PreparedMetadata {
	/** Absent when the entry declares no `openLibraryWork` — "None declared", not a failure. */
	work?: string;
	/** The year to write: the manifest's when declared, otherwise Open Library's. */
	year: number | null;
	/** What Open Library produced. Absent when no lookup ran; `null` when one ran and failed. */
	openLibraryYear?: number | null;
	/** The manifest's declared year, when it declared one. Always wins over the fetched one. */
	manifestYear?: number;
	/** Open Library's description → the `default` summary key. `null` on any failure. */
	description: string | null;
	/** Present only when the lookup was attempted and produced nothing usable. Never fatal. */
	failure?: string;
}

interface PreparedBook {
	entry: BookManifestEntry;
	chunks: string[];
	disallowed: ReturnType<typeof findDisallowed>;
	/** Absent when the manifest entry declares no cover — which CLEARS `cover_url` on write. */
	cover?: PreparedCover;
	/**
	 * `undefined` when the manifest entry declares no chapters config at all — legal, "this book
	 * has no chapters." Otherwise the aligner's own result, stored raw (never turned fatal here —
	 * see `main()`) so `writeReport` can render it and `main()` can refuse the write.
	 */
	chapters?: AlignChaptersResult;
	/** Always present; a book with no `openLibraryWork` gets `{ year: null, description: null }`. */
	metadata: PreparedMetadata;
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

/**
 * The book's chapter alignment result, or `undefined` when the manifest declares no chapters
 * config at all (spec #33 §6).
 *
 * `chaptersHtmlUrl` wins when present: HTML is fetched, headings extracted with the configured
 * (or default `h2`) selector, and any `excludeTitles` dropped by exact match against the RAW
 * extracted title, before folding. Otherwise `chapters.titles` is the fallback path and the
 * HTML fetch is skipped entirely. Alignment problems are never turned fatal here — that is
 * `main()`'s job, mirroring how `disallowed` characters are collected in `prepare()` and only
 * refused later.
 */
async function prepareChapters(
	entry: BookManifestEntry,
	chunks: readonly string[],
	options: Options
): Promise<AlignChaptersResult | undefined> {
	const alignOptions = { firstHeadingImplicit: entry.chapters?.firstHeadingImplicit };

	if (entry.chaptersHtmlUrl) {
		const html = await readChaptersHtml(entry, options.refresh);
		const selector = entry.chapters?.selector ?? 'h2';
		const extracted = extractHeadings(html!, selector);
		const excludeTitles = entry.chapters?.excludeTitles ?? [];
		const titles = extracted
			.filter((heading) => !excludeTitles.includes(heading.title))
			.map((heading) => heading.title);
		return alignChapters(titles, chunks, alignOptions);
	}

	if (entry.chapters?.titles) {
		return alignChapters(entry.chapters.titles, chunks, alignOptions);
	}

	return undefined;
}

/**
 * The book's year and description from Open Library, or the reason there are none (spec #34).
 *
 * Runs inside `prepare()`, alongside `prepareChapters` — i.e. **before any credential is
 * read**, extending the ordering discipline `readCover`'s docstring already states to this
 * network call. Nothing privileged is in memory while a third-party host is being talked to.
 *
 * **Failure is non-fatal here, unlike chapter alignment, and that asymmetry is the design.**
 * A subtly wrong chapter list is worse than none, so `main()` turns it fatal; a missing blurb
 * is not — text and chapters are the product, a blurb is not. So a network error, a timeout, a
 * non-200 (a 404 for a wrong work id included), unparseable JSON, and valid JSON carrying
 * neither field all resolve to `{ year: null, description: null, failure }`, and ingestion
 * continues. The reason is printed live by `main()` and written into the committed report.
 *
 * **A manifest `year` wins over the fetched one**, on the same doctrine as the per-locale
 * `summary` overrides: the manifest is the source of truth and a third party is a convenience.
 * Both numbers are carried through separately so the report can attribute each and flag a
 * disagreement — which is the whole reason the override exists, since Open Library's
 * `first_publish_year` is its earliest CATALOGUED edition rather than first publication.
 */
async function prepareMetadata(
	entry: BookManifestEntry,
	options: Options
): Promise<PreparedMetadata> {
	// A declared year with no work id is the niebla/trafalgar case — books deliberately given
	// no `openLibraryWork` because Open Library's description for them is a physical-extent or
	// series note rather than a blurb. Not a failure, and it must still be written.
	const declared = entry.year === undefined ? {} : { manifestYear: entry.year };

	if (!entry.openLibraryWork) {
		// Not a failure: most of the catalog may legitimately sit here.
		return { ...declared, year: entry.year ?? null, description: null };
	}

	const work = entry.openLibraryWork;
	const { payload, failure } = await readOpenLibraryWork(work, entry.slug, options.refresh);
	if (payload === undefined) {
		// The lookup failed outright, so there is no fetched year to compare against — but a
		// declared one still stands, and is still written. That is the always-write posture
		// working in the maintainer's favour for once: a manifest year survives an outage.
		return {
			work,
			...declared,
			year: entry.year ?? null,
			openLibraryYear: null,
			description: null,
			failure: failure!
		};
	}

	const { year, description } = parseOpenLibraryWork(payload);
	if (year === null && description === null) {
		return {
			work,
			...declared,
			year: entry.year ?? null,
			openLibraryYear: null,
			description: null,
			failure:
				failure ??
				`${work} carries neither a usable first publication year nor a usable description.`
		};
	}

	// A partial failure travels WITH the usable half: the report says the year lookup failed
	// rather than showing a blank year that reads as "this work has no year".
	return {
		work,
		...declared,
		year: entry.year ?? year,
		openLibraryYear: year,
		description,
		...(failure ? { failure } : {})
	};
}

async function prepare(entry: BookManifestEntry, options: Options): Promise<PreparedBook> {
	const raw = await readSource(entry, options.refresh);
	const cleaned = cleanSource(raw, entry.cleaning);
	const chunks = chunkParagraphs(cleaned);
	return {
		entry,
		chunks,
		disallowed: findDisallowed(cleaned),
		cover: readCover(entry),
		chapters: await prepareChapters(entry, chunks, options),
		metadata: await prepareMetadata(entry, options)
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
				: {}),
			// Only a successful alignment has rows to show; a failed one is reported via the fatal
			// error in `main()` instead, and "declares no chapters" renders "None declared."
			...(prepared.chapters?.ok ? { chapters: prepared.chapters.chapters } : {}),
			// Always passed, including on failure: this is the ONLY committed record that a
			// non-fatal lookup stopped working, which is what makes it show up in a PR diff
			// rather than as a year that silently went blank.
			metadata: {
				...(prepared.metadata.work ? { work: prepared.metadata.work } : {}),
				year: prepared.metadata.year,
				...(prepared.metadata.manifestYear !== undefined
					? { manifestYear: prepared.metadata.manifestYear }
					: {}),
				...(prepared.metadata.openLibraryYear !== undefined
					? { openLibraryYear: prepared.metadata.openLibraryYear }
					: {}),
				description: prepared.metadata.description,
				...(prepared.entry.summary ? { summaries: prepared.entry.summary } : {}),
				...(prepared.metadata.failure ? { failure: prepared.metadata.failure } : {})
			}
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

/**
 * How many chunk ids one `chunk_attempts` count request may name. See the loop below for why
 * a single unbatched request cannot work on a full-length book.
 */
const ATTEMPT_COUNT_BATCH = 200;

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
	// BATCHED, and it has to be. PostgREST puts `.in(...)` in the query STRING, so a single
	// call over a whole book's chunk ids builds a URL of `37 * n` characters — around 50 KB for
	// don-quijote — and the server answers `400 Bad Request` long before it answers the
	// question. That failure is fatal by design (see below), so an unbatched count did not
	// merely slow the re-cut down: it stopped it, on the first book with more chunks than a URL
	// can name. 200 ids per request is ~7 KB, comfortably inside every proxy's limit.
	const users = new Set<string>();
	let count = 0;

	for (let start = 0; start < chunkIds.length; start += ATTEMPT_COUNT_BATCH) {
		const batch = chunkIds.slice(start, start + ATTEMPT_COUNT_BATCH);
		// A failure here must be fatal, never swallowed. This count IS the safety mechanism, and
		// an error read as an empty result reports "this is free" about a chunk that may carry a
		// user's history — the one direction a safety check must never fail in. (It did exactly
		// that until `service_role` was granted SELECT on chunk_attempts.)
		const { data, error } = await client
			.from('chunk_attempts')
			.select('user_id')
			.in('chunk_id', batch);
		if (error) {
			fail(
				`${slug}: could not count the attempts at risk from ${action} — ${error.message}\n` +
					`  Refusing to proceed without knowing what it would affect.`
			);
		}
		count += data?.length ?? 0;
		for (const row of data ?? []) {
			users.add(row.user_id as string);
		}
	}

	// Counted across batches, never per batch: a user who attempted chunks in two different
	// batches is one user, and summing per-batch set sizes would report them twice.
	return { count, users: users.size };
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

	// PAGINATED, for exactly the reason `readExistingContent` states below: PostgREST caps a
	// response at 1,000 rows, and a re-cut that halves a long book leaves more trailing chunks
	// than that. An unpaginated read would under-report the cost AND under-delete, leaving rows
	// past the new end alive with no `chunk_count` that can reach them — the truncation class
	// this codebase has removed everywhere else.
	const doomedIds: string[] = [];
	let offset = 0;
	for (;;) {
		const { data, error } = await client
			.from('chunks')
			.select('id')
			.eq('book_id', bookId)
			.gte('index', newLength)
			.order('index', { ascending: true })
			.range(offset, offset + RECUT_PAGE_SIZE - 1);
		if (error) {
			fail(
				`${slug}: could not list the chunks at risk from shrinking at offset ${offset} — ${error.message}`
			);
		}
		const page = (data ?? []) as { id: string }[];
		doomedIds.push(...page.map((row) => row.id));
		if (page.length < RECUT_PAGE_SIZE) {
			break;
		}
		offset += RECUT_PAGE_SIZE;
	}
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
				featured: entry.featured,
				// ALWAYS written, including to `null` and `{}` — the same posture `writeCover`
				// takes with `cover_url`, for the same reason: removing `summary.es` from the
				// manifest and re-ingesting must CLEAR it, or a summary the maintainer deleted
				// lingers in the catalog forever. The manifest is the source of truth for what
				// the catalog is, including for absences.
				//
				// THE ACCEPTED TRAP, stated rather than hidden: if Open Library is down during a
				// re-ingest, this wipes a previously good `year` and `default` summary. Accepted
				// because (a) preserving a value nobody can currently reproduce would make the
				// catalog depend on ingestion history instead of on the manifest, which is exactly
				// what the manifest doctrine exists to prevent; (b) the loss is fully recoverable
				// by re-running one command; (c) the report's `## Metadata` blockquote makes it
				// visible in the PR diff rather than silent. Manifest overrides are unaffected —
				// they are local and never depend on the network.
				year: prepared.metadata.year,
				// Manifest overrides merged LAST, so a locale key always wins over Open Library's
				// language-unverified `default`.
				summary: {
					...(prepared.metadata.description ? { default: prepared.metadata.description } : {}),
					...entry.summary
				}
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
		// Batched for the same reason the count above is: the ids travel in the URL, and a
		// full-length book's trailing run is far more than one request can name.
		for (let start = 0; start < shrinkCost.doomedIds.length; start += ATTEMPT_COUNT_BATCH) {
			const batch = shrinkCost.doomedIds.slice(start, start + ATTEMPT_COUNT_BATCH);
			const { error } = await client.from('chunks').delete().in('id', batch);
			if (error) fail(`${entry.slug}: deleting trailing chunks failed — ${error.message}`);
		}
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

	await writeChapters(client, prepared, bookId);

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

/**
 * Rewrites a book's `chapters` rows wholesale (spec #33): delete then, only if there is
 * anything to write, insert. **Always deletes first**, even for a book with no chapters config
 * at all — a manifest edit that REMOVES chapters config must clear stale rows from a previous
 * ingest, the same posture `writeCover` already takes with `cover_url`. No FK relationship to
 * `chunks`/`chunk_attempts`, so this is independent of `--allow-shrink`/`--allow-recut`.
 */
async function writeChapters(
	client: SupabaseClient,
	prepared: PreparedBook,
	bookId: string
): Promise<void> {
	const chapters = prepared.chapters?.ok ? prepared.chapters.chapters : [];

	const { error: deleteError } = await client.from('chapters').delete().eq('book_id', bookId);
	if (deleteError) {
		fail(`${prepared.entry.slug}: clearing existing chapters failed — ${deleteError.message}`);
	}
	if (chapters.length === 0) {
		return;
	}

	const rows = chapters.map((chapter) => ({
		book_id: bookId,
		index: chapter.index,
		title: chapter.title,
		start_chunk_index: chapter.startChunkIndex
	}));
	const { error: insertError } = await client.from('chapters').insert(rows);
	if (insertError) fail(`${prepared.entry.slug}: writing chapters failed — ${insertError.message}`);
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
		// Printed live as well as written to the report: the report is for the reviewer reading
		// the diff later, this line is for the operator watching the run now. A failure that is
		// only discoverable after the fact is one nobody fixes in the same sitting.
		if (book.metadata.failure) {
			console.warn(`  metadata: ${book.metadata.failure} Continuing — this is not fatal.`);
		} else if (book.metadata.work || book.metadata.manifestYear !== undefined) {
			const year = book.metadata.year ?? 'no year';
			const description = book.metadata.description
				? `${book.metadata.description.length}-char description`
				: 'no description';
			console.log(`  metadata: ${year}, ${description}`);
		}
		// Surfaced live as well as in the report: an operator who has just edited a manifest year
		// should learn on the spot that it contradicts Open Library, not three files later.
		if (
			book.metadata.manifestYear !== undefined &&
			typeof book.metadata.openLibraryYear === 'number' &&
			book.metadata.openLibraryYear !== book.metadata.manifestYear
		) {
			console.warn(
				`  metadata: manifest declares ${book.metadata.manifestYear}, Open Library reports ` +
					`${book.metadata.openLibraryYear} — the manifest wins.`
			);
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
		if (book.chapters && !book.chapters.ok) {
			fail(
				`${entry.slug}: chapter alignment failed:\n${book.chapters.problems.map((p) => `  - ${p}`).join('\n')}\n` +
					`  See the report. A subtly wrong chapter list is worse than none (spec #33).`
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
