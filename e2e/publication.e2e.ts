import { expect, test } from '@playwright/test';
import {
	anonClient,
	deleteUsers,
	isLocalStack,
	localSecretKey,
	secretClient,
	signUpUser,
	SUPABASE_URL,
	type AnyClient,
	type TestUser
} from './support/supabase';

/**
 * Publication gating (spec #17 §1, ADR-0006's Phase 3a amendment).
 *
 * Phase 3 ingests real books into the database before they are fit to read, so
 * `books.published_at` decides what a client may see. The rule is enforced in **RLS**, not in
 * a query: filtering in `src/lib/server/books.ts` would be bypassable, since any client can
 * reach PostgREST directly with the publishable key — which is exactly what these tests do.
 *
 * These checks were originally run by hand while writing the migration. That is a guarantee
 * with a shelf life: nothing would have caught a later policy edit that quietly re-exposed an
 * unpublished book. They live here now.
 *
 * **Every assertion runs as `anon` AND as `authenticated`.** The service role bypasses RLS
 * entirely, so a check that "passes" as the service role proves nothing at all; it appears
 * below only to arrange the fixture, which no client role is permitted to create.
 */

/** Fixed, so re-running locally reuses one row instead of accumulating probes. */
const PROBE_SLUG = 'rls-publication-probe';

test.describe('publication gating', () => {
	// Serial: one shared probe book whose published_at the last tests deliberately flip.
	test.describe.configure({ mode: 'serial' });
	test.skip(
		!isLocalStack,
		`refusing to create throwaway users against a non-local Supabase (${SUPABASE_URL})`
	);
	test.skip(
		!localSecretKey(),
		'needs the local secret key to arrange an unpublished book (no client role may create one)'
	);

	let anon: AnyClient;
	let user: TestUser;
	let service: AnyClient;
	let probeBookId: string;
	/** A published book to contrast against, so "invisible" never means "everything is". */
	let publishedSlug: string;

	/** The pair of roles every visibility rule below is checked against. */
	function roles(): [string, AnyClient][] {
		return [
			['anon', anon],
			['authenticated', user.client]
		];
	}

	test.beforeAll(async () => {
		anon = anonClient();
		service = secretClient()!;
		user = await signUpUser('publication');

		const seeded = await anon.from('books').select('slug').limit(1);
		expect(seeded.data?.length, 'the local stack must be seeded (npm run db:reset)').toBe(1);
		publishedSlug = seeded.data![0].slug;

		// Upserted rather than inserted so a re-run reuses the row: the service role has no
		// DELETE grant on `books` (deleting one cascades away every user's attempts), so this
		// fixture cannot be torn down — only reset.
		const book = await service
			.from('books')
			.upsert(
				{
					slug: PROBE_SLUG,
					title: 'RLS publication probe',
					author: 'probe',
					language: 'en',
					chunk_count: 1,
					published_at: null
				},
				{ onConflict: 'slug' }
			)
			.select('id')
			.single();
		expect(book.error, `arranging the probe book failed: ${book.error?.message}`).toBeNull();
		probeBookId = book.data!.id;

		const chunk = await service.from('chunks').upsert(
			{
				book_id: probeBookId,
				index: 0,
				content: 'A chunk of an unpublished book, which no client may read.',
				char_count: 57
			},
			{ onConflict: 'book_id,index' }
		);
		expect(chunk.error, `arranging the probe chunk failed: ${chunk.error?.message}`).toBeNull();

		// A chapter of the same unpublished book (spec #33): the chapters RLS policy gates on
		// the identical books.published_at join as chunks, so it needs the same probe.
		//
		// Deleted then inserted, not upserted: `service_role` deliberately holds no UPDATE grant
		// on chapters (ingestion always deletes + reinserts a book's chapters, per the migration),
		// and an upsert's `ON CONFLICT DO UPDATE` plan requires that privilege even on a run that
		// never hits the conflict path. This mirrors ingestion's actual write pattern.
		await service.from('chapters').delete().eq('book_id', probeBookId);
		const chapter = await service.from('chapters').insert({
			book_id: probeBookId,
			index: 0,
			title: 'Probe chapter',
			start_chunk_index: 0
		});
		expect(
			chapter.error,
			`arranging the probe chapter failed: ${chapter.error?.message}`
		).toBeNull();
	});

	test.afterAll(async () => {
		// Leave the probe unpublished, whatever the last test did to it.
		await service.from('books').update({ published_at: null }).eq('id', probeBookId);
		await deleteUsers(user.id);
	});

	for (const role of ['anon', 'authenticated'] as const) {
		test(`${role} cannot see an unpublished book`, async () => {
			const client = roles().find(([name]) => name === role)![1];
			const books = await client.from('books').select('slug').eq('slug', PROBE_SLUG);
			expect(books.error, `books read failed: ${books.error?.message}`).toBeNull();
			expect(books.data).toEqual([]);
		});

		/*
		 * The load-bearing one. Narrowing the `books` policy alone would leave chunks readable
		 * by a direct `book_id` query — the content is what actually matters, and a client
		 * that already knows the id does not need the listing.
		 */
		test(`${role} cannot read an unpublished book's chunks by book_id`, async () => {
			const client = roles().find(([name]) => name === role)![1];
			const chunks = await client.from('chunks').select('id, content').eq('book_id', probeBookId);
			expect(chunks.error, `chunks read failed: ${chunks.error?.message}`).toBeNull();
			expect(chunks.data).toEqual([]);
		});

		test(`${role} still reads published books and their chunks`, async () => {
			const client = roles().find(([name]) => name === role)![1];
			const book = await client
				.from('books')
				.select('id, chunk_count, chunks(id)')
				.eq('slug', publishedSlug)
				.single();
			expect(book.error, `published book read failed: ${book.error?.message}`).toBeNull();
			expect(book.data!.chunks.length).toBe(book.data!.chunk_count);
		});

		/*
		 * The chapters analogue of the load-bearing chunks check above: chapters (spec #33) is
		 * gated on the identical books.published_at join, and that gate is only proven by a test
		 * that queries chapters directly by book_id rather than through a published book.
		 */
		test(`${role} cannot read an unpublished book's chapters by book_id`, async () => {
			const client = roles().find(([name]) => name === role)![1];
			const chapters = await client.from('chapters').select('id, title').eq('book_id', probeBookId);
			expect(chapters.error, `chapters read failed: ${chapters.error?.message}`).toBeNull();
			expect(chapters.data).toEqual([]);
		});

		test(`${role} cannot create a chapter`, async () => {
			const client = roles().find(([name]) => name === role)![1];
			const insert = await client.from('chapters').insert({
				book_id: probeBookId,
				index: 1,
				title: 'nope',
				start_chunk_index: 0
			});
			expect(insert.error, 'inserting a chapter must be refused').not.toBeNull();
		});

		test(`${role} cannot create a book`, async () => {
			const client = roles().find(([name]) => name === role)![1];
			const insert = await client.from('books').insert({
				slug: `${PROBE_SLUG}-${role}-write`,
				title: 'nope',
				author: 'nope',
				language: 'en'
			});
			expect(insert.error, 'inserting a book must be refused').not.toBeNull();
		});

		/*
		 * Publishing is a privileged act. Without this, a client could make its own row visible
		 * — or worse, publish a half-ingested book — by PATCHing one column.
		 */
		test(`${role} cannot publish a book`, async () => {
			const client = roles().find(([name]) => name === role)![1];
			await client
				.from('books')
				.update({ published_at: new Date().toISOString() })
				.eq('id', probeBookId);

			const stillHidden = await client.from('books').select('slug').eq('slug', PROBE_SLUG);
			expect(stillHidden.data).toEqual([]);

			// Confirmed against the row itself, not just against the client's own view: RLS
			// would hide a successful update from the updater, which looks identical to a
			// refusal from here.
			const asService = await service
				.from('books')
				.select('published_at')
				.eq('id', probeBookId)
				.single();
			expect(asService.data!.published_at).toBeNull();
		});
	}

	/*
	 * Ingestion reads `chunk_attempts` to report what a destructive re-chunk would cascade
	 * away, and needs SELECT for that. It must never gain more: progress is append-only and
	 * written by the browser under RLS (ADR-0012), and an offline pipeline has no business
	 * touching it. This pins the grant's scope, which a later "just add the grants" change
	 * could widen without anyone noticing.
	 */
	test('the ingestion role can read attempts but never write them', async () => {
		const read = await service.from('chunk_attempts').select('id').limit(1);
		expect(
			read.error,
			`the shrink guard's count query must work: ${read.error?.message}`
		).toBeNull();

		const chunk = await service.from('chunks').select('id').eq('book_id', probeBookId).single();
		const write = await service.from('chunk_attempts').insert({
			user_id: user.id,
			chunk_id: chunk.data!.id,
			book_id: probeBookId,
			completed: true,
			gross_wpm: 42,
			accuracy_raw: 0.95,
			elapsed_ms: 30_000,
			started_at: new Date().toISOString()
		});
		expect(write.error, 'the ingestion role must not be able to write progress').not.toBeNull();
	});

	test('publishing reveals the book and its chunks to both roles', async () => {
		const published = await service
			.from('books')
			.update({ published_at: new Date().toISOString() })
			.eq('id', probeBookId);
		expect(published.error, `publishing failed: ${published.error?.message}`).toBeNull();

		for (const [name, client] of roles()) {
			const book = await client
				.from('books')
				.select('slug, chunks(id), chapters(id)')
				.eq('slug', PROBE_SLUG)
				.single();
			expect(book.error, `${name} could not read the published probe`).toBeNull();
			expect(book.data!.chunks.length, `${name} saw no chunks`).toBe(1);
			expect(book.data!.chapters.length, `${name} saw no chapters`).toBe(1);
		}
	});
});
