import { expect } from '@playwright/test';
import { anonClient, type AnyClient } from './supabase';

/**
 * Probe books for the windowed-reading specs (spec #18, phase 7).
 *
 * Spec #18's UI criteria are all about what happens at and past a WINDOW BOUNDARY, and no
 * seeded fixture book is long enough to have one: the longest is 6 chunks against a window
 * of 10. The two full-length books spec #17 ingested would qualify, but they are
 * deliberately unpublished — publishing them is §11, the user's call after final validation,
 * and it is explicitly not something a test may do. So the specs arrange their own books.
 *
 * **Local stack only.** Every function here writes with the ingestion (service) role, which
 * bypasses RLS and can publish. Callers must already be guarded on `isLocalStack` and
 * `localSecretKey()` — the same contract `resume-rpc.e2e.ts` and `publication.e2e.ts` hold.
 *
 * **Arrangement only.** Nothing here is ever used to assert that something is readable: a
 * service-role read bypasses the policy under test and every check it satisfies is vacuous.
 * Assertions belong to the browser, to `anonClient()` and to a signed-up user.
 *
 * Books are upserted under FIXED slugs and torn down by being RETIRED (unpublished and
 * unfeatured), never deleted: the ingestion role has no `delete` grant on `books`, on purpose
 * — deleting one would cascade away every user's attempts and rollups. A retired book is
 * invisible to `anon` and `authenticated` alike, so it is harmless to the next run, and the
 * fixed slug means a re-run reuses its rows rather than accumulating probes.
 */

/** A chapter as the manifest/ingestion would produce it — 0-based, in reading order. */
export interface ProbeChapterSpec {
	/** 0-based sequence number within the book. */
	index: number;
	title: string;
	/** 0-based chunk index whose first character opens this chapter. */
	startChunkIndex: number;
}

export interface ProbeBookSpec {
	slug: string;
	title: string;
	author: string;
	language: 'en' | 'es';
	/** Chunk contents in index order. `chunk_count` is derived from this, never passed in. */
	contents: readonly string[];
	/**
	 * The detail screen's back-cover facts (spec #34). Optional here because most probe books
	 * predate them, but ALWAYS WRITTEN — see the "written on every arrangement" note below.
	 *
	 * The published seeded fixtures carry neither: they are excerpts with no Open Library work
	 * and no chapter structure, which is exactly why the metadata and chapter criteria need a
	 * probe book rather than a fixture. Publishing the real catalog books to get their metadata
	 * is not an option — they are deliberately unpublished, and publishing one is the user's
	 * call, not a test's.
	 */
	year?: number | null;
	/**
	 * The raw per-locale map as `books.summary` holds it: a `default` key standing in for Open
	 * Library's description, plus locale keys that win over it. Passed through unresolved so a
	 * spec can arrange the exact shape `resolveSummary` is meant to narrow.
	 */
	summary?: Record<string, string>;
	/** A cover URL to attach at arrangement time, so no spec has to follow up with an update. */
	coverUrl?: string | null;
	/** Chapter structure. `[]` and omitted are the same thing: a book with no structure. */
	chapters?: readonly ProbeChapterSpec[];
}

/** A probe book as the database holds it, in the shape the specs address it by. */
export interface ProbeBook {
	/** `books.id` (uuid) — what `chunk_attempts.book_id` is keyed by. */
	id: string;
	/** `books.slug` — what the routes and `TypeableTextSummary.id` use. */
	slug: string;
	chunkCount: number;
	/** `chunks.id` in `index` order, read back rather than assumed from the upsert. */
	chunkIds: string[];
	/** Chunk contents in index order — what a test actually types. */
	contents: readonly string[];
	/** The chapters as arranged, in reading order. Empty for a book with no structure. */
	chapters: readonly ProbeChapterSpec[];
}

/**
 * Upsert a probe book and its chunks, PUBLISHED, and read the result back.
 *
 * Published because every criterion these books serve is reached through the browser, and
 * the publication-gating policy (20260731120000) makes an unpublished book a 404 on the
 * typing route. It is published locally and only for the duration of the spec —
 * {@link retireProbeBook} takes it back out of the catalog in `afterAll`.
 *
 * **`year`, `summary` and `cover_url` are written on EVERY arrangement, including to
 * `null`/`{}`/`null` when the spec omits them.** This is deliberately the same always-write
 * posture `scripts/ingest.ts` takes with the same three columns (spec #34 Feature Brief,
 * §"Write posture"): probe slugs are FIXED and reused across runs, so a value left behind by
 * a previous spec would otherwise leak into the next one's assertions — and the case that
 * leaks worst is "a book with no summary renders without an empty panel", which passes
 * vacuously right up until some other spec's summary is still sitting on the row.
 */
export async function arrangeProbeBook(
	service: AnyClient,
	spec: ProbeBookSpec
): Promise<ProbeBook> {
	const book = await service
		.from('books')
		.upsert(
			{
				slug: spec.slug,
				title: spec.title,
				author: spec.author,
				language: spec.language,
				chunk_count: spec.contents.length,
				published_at: new Date().toISOString(),
				featured: false,
				year: spec.year ?? null,
				summary: spec.summary ?? {},
				cover_url: spec.coverUrl ?? null
			},
			{ onConflict: 'slug' }
		)
		.select('id')
		.single();
	expect(book.error, `arranging ${spec.slug} failed: ${book.error?.message}`).toBeNull();

	const rows = spec.contents.map((content, index) => ({
		book_id: book.data!.id,
		index,
		content,
		char_count: [...content].length
	}));
	const chunks = await service.from('chunks').upsert(rows, { onConflict: 'book_id,index' });
	expect(
		chunks.error,
		`arranging ${spec.slug}'s chunks failed: ${chunks.error?.message}`
	).toBeNull();

	// Read the ids back in index order rather than trusting the upsert's row order: every
	// completion assertion in these specs is keyed by `chunks.id`, and a silently reordered
	// list would make them pass against the wrong passage.
	const read = await service
		.from('chunks')
		.select('id, index, content')
		.eq('book_id', book.data!.id)
		.order('index');
	expect(read.error, `reading ${spec.slug}'s chunks failed: ${read.error?.message}`).toBeNull();
	const inRange = read.data!.filter((chunk) => chunk.index < spec.contents.length);
	expect(inRange.length, `${spec.slug} should hold ${spec.contents.length} chunks`).toBe(
		spec.contents.length
	);

	// Chapters (spec #33) are DELETED AND REINSERTED, never upserted — the ingestion role has
	// `select, insert, delete` on `chapters` and deliberately no `update` (20260809180633),
	// because ingestion always rewrites a book's chapter list whole. Doing the same here means
	// a probe re-run with fewer chapters than the last one cannot leave a stale row behind,
	// and it keeps the arrangement on the same grants the real writer has.
	const wipe = await service.from('chapters').delete().eq('book_id', book.data!.id);
	expect(wipe.error, `clearing ${spec.slug}'s chapters failed: ${wipe.error?.message}`).toBeNull();

	const chapters = spec.chapters ?? [];
	if (chapters.length > 0) {
		const { error } = await service.from('chapters').insert(
			chapters.map((chapter) => ({
				book_id: book.data!.id,
				index: chapter.index,
				title: chapter.title,
				start_chunk_index: chapter.startChunkIndex
			}))
		);
		expect(error, `arranging ${spec.slug}'s chapters failed: ${error?.message}`).toBeNull();
	}

	// Publication, confirmed through a CLIENT role rather than assumed from the write.
	//
	// This is the one place a service-role read would be worthless, so it is the one place
	// this module does not use one: `published_at` being set is not the same fact as the book
	// being reachable, and the difference is exactly what every browser assertion downstream
	// depends on. When it is wrong the symptom is a 404 on the typing route, several tests
	// later, which reads as a product bug rather than as arrangement that did not take.
	const visible = await anonClient()
		.from('books')
		.select('slug, chunk_count')
		.eq('slug', spec.slug)
		.maybeSingle();
	expect(
		visible.data,
		`${spec.slug} was written but is not readable as anon — publication did not take`
	).not.toBeNull();
	expect(visible.data!.chunk_count).toBe(spec.contents.length);

	return {
		id: book.data!.id,
		slug: spec.slug,
		chunkCount: spec.contents.length,
		chunkIds: inRange.map((chunk) => chunk.id),
		contents: spec.contents,
		chapters
	};
}

/**
 * Take a probe book back out of the catalog: unpublished and unfeatured.
 *
 * This is the whole teardown, and it is why every probe here is safe to leave behind. A
 * retired book is invisible to both client roles, so it cannot leak into another spec's
 * catalog assertions, and `npm run db:reset` removes the rows entirely.
 *
 * Failures are reported, never thrown: a teardown failure must not overwrite the test
 * result a run is actually about — the same contract `deleteUsers` holds.
 */
export async function retireProbeBook(service: AnyClient, slug: string): Promise<void> {
	const { error } = await service
		.from('books')
		.update({ published_at: null, featured: false })
		.eq('slug', slug);
	if (error) {
		console.warn(`[e2e] failed to retire probe book ${slug}: ${error.message}`);
	}
}

/**
 * Feature an EXISTING book in its language, for the landing-hero criterion.
 *
 * Separate from {@link arrangeProbeBook} because the hero test features a book the catalog
 * already has rather than inventing one: `getHeroBook` reads through RLS, so the hero book
 * must be published anyway, and pointing the hero at a seeded fixture keeps what the test
 * types honest content rather than probe filler.
 *
 * `books_featured_per_language_idx` allows at most one featured book per language, so this
 * fails loudly if something else in that language is already featured — which is the
 * database saying the hero is already spoken for, not a flake.
 */
export async function setFeatured(
	service: AnyClient,
	slug: string,
	featured: boolean
): Promise<void> {
	const { error } = await service.from('books').update({ featured }).eq('slug', slug);
	if (featured) {
		expect(error, `featuring ${slug} failed: ${error?.message}`).toBeNull();
	} else if (error) {
		console.warn(`[e2e] failed to unfeature ${slug}: ${error.message}`);
	}
}
