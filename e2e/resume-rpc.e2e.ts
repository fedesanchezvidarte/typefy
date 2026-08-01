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
 * `first_incomplete_chunk_index` — resume computed in SQL (spec #18 §2,
 * `20260801105912_windowed_reads.sql`), plus the `books.featured` partial unique index.
 *
 * Database-level tests in the `publication.e2e.ts` / `progress.e2e.ts` style: throwaway users
 * signed up against the local stack, PostgREST driven directly through supabase-js, no page ever
 * opened. Driving PostgREST directly is the point rather than a convenience — the function is
 * exposed at `/rest/v1/rpc/first_incomplete_chunk_index` to anyone holding the publishable key,
 * so the route's own 404 is not what protects it. These tests call it the way an attacker would.
 *
 * **They are pulled forward into Phase 2 on purpose.** Phase 3 deletes
 * `src/lib/progress/resume.ts`'s `firstIncompleteIndex` and with it the only executable
 * specification of the gaps-count rule. The replacement has to exist before the original goes,
 * or the rule is unpinned for a phase.
 *
 * Every completion below is arranged by inserting a `chunk_attempts` row **as the user** and
 * letting the 2b rollup trigger write `chunk_progress`. No test writes a rollup directly: the
 * function's whole correctness question is which rollup rows count as "completed", and seeding
 * that table by hand would answer it by assumption.
 */

/** Fixed slugs, so re-running locally reuses the rows instead of accumulating probes. */
const PUBLISHED_SLUG = 'resume-rpc-probe';
const UNPUBLISHED_SLUG = 'resume-rpc-unpublished-probe';
/** Enough chunks for a gap, a fill, and a completion: indices 0..3. */
const CHUNK_COUNT = 4;

test.describe('first_incomplete_chunk_index', () => {
	// Serial: one probe book whose progress accumulates test by test, so the order below is
	// the specification — "no progress", then a completion, then a gap, then a fill.
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
	let service: AnyClient;
	/** The caller whose progress every expectation is about. */
	let alice: TestUser;
	/** A second signed-in user, to prove the answer is derived from auth.uid() and not shared. */
	let bob: TestUser;
	let bookId: string;
	let unpublishedBookId: string;
	/** `chunks.id` in `index` order, so `chunkIds[n]` is chunk n. */
	let chunkIds: string[];
	let unpublishedChunkIds: string[];

	/** Arrange a probe book and its chunks as the ingestion role, and return its id. */
	async function upsertProbeBook(slug: string, published: boolean): Promise<string> {
		const book = await service
			.from('books')
			.upsert(
				{
					slug,
					title: `Resume RPC probe (${published ? 'published' : 'unpublished'})`,
					author: 'probe',
					language: 'en',
					chunk_count: CHUNK_COUNT,
					published_at: published ? new Date().toISOString() : null,
					featured: false
				},
				{ onConflict: 'slug' }
			)
			.select('id')
			.single();
		expect(book.error, `arranging ${slug} failed: ${book.error?.message}`).toBeNull();

		const rows = Array.from({ length: CHUNK_COUNT }, (_, index) => ({
			book_id: book.data!.id,
			index,
			content: `Probe chunk ${index}.`,
			char_count: 16
		}));
		const chunks = await service.from('chunks').upsert(rows, { onConflict: 'book_id,index' });
		expect(chunks.error, `arranging ${slug}'s chunks failed: ${chunks.error?.message}`).toBeNull();
		return book.data!.id;
	}

	/**
	 * Record one attempt as `user`. `completed: false` is the load-bearing case: the rollup
	 * trigger still writes a `chunk_progress` row, so a function that tested row existence
	 * instead of `first_completed_at is not null` would resume the user past this passage.
	 */
	async function attempt(
		user: TestUser,
		index: number,
		completed: boolean,
		book: { id: string; chunkIds: string[] } = { id: bookId, chunkIds }
	): Promise<void> {
		const { error } = await user.client.from('chunk_attempts').insert({
			user_id: user.id,
			chunk_id: book.chunkIds[index],
			book_id: book.id,
			completed,
			gross_wpm: 50,
			accuracy_raw: 0.95,
			elapsed_ms: 30_000,
			started_at: new Date().toISOString()
		});
		expect(error, `recording an attempt at chunk ${index} failed: ${error?.message}`).toBeNull();
	}

	/** A book's chunk ids in `index` order, read rather than assumed from the upsert's ordering. */
	async function readChunkIds(client: AnyClient, id: string): Promise<string[]> {
		const chunks = await client.from('chunks').select('id, index').eq('book_id', id).order('index');
		expect(chunks.error, `reading probe chunks failed: ${chunks.error?.message}`).toBeNull();
		expect(chunks.data!.length).toBe(CHUNK_COUNT);
		return chunks.data!.map((c) => c.id);
	}

	/** Call the RPC exactly as the app will: no user argument exists to pass. */
	async function resumeIndex(client: AnyClient, p_book_id: string): Promise<number> {
		const { data, error } = await client.rpc('first_incomplete_chunk_index', { p_book_id });
		expect(error, `rpc failed: ${error?.message}`).toBeNull();
		return data as number;
	}

	test.beforeAll(async () => {
		anon = anonClient();
		service = secretClient()!;
		alice = await signUpUser('resume-a');
		bob = await signUpUser('resume-b');

		bookId = await upsertProbeBook(PUBLISHED_SLUG, true);
		unpublishedBookId = await upsertProbeBook(UNPUBLISHED_SLUG, false);

		// Read the ids back in index order rather than assuming the upsert's ordering. The
		// unpublished book's chunks are readable only as the service role, which is the whole
		// premise of the leak test below.
		chunkIds = await readChunkIds(anon, bookId);
		unpublishedChunkIds = await readChunkIds(service, unpublishedBookId);

		/*
		 * Arrange the leak test so it can actually fail. Alice completes chunk 0 of the
		 * UNPUBLISHED book — reachable because `chunk_attempts`' insert policy only checks
		 * `user_id = auth.uid()`, and a foreign key does not consult RLS. (It is also a real
		 * situation: publication can be revoked from a book people have already typed.)
		 *
		 * Without this she would have no progress there, the honest answer would be 0 anyway,
		 * and the assertion would hold whether or not the function gates on `published_at` —
		 * a test that passes for the wrong reason. Verified: with the predicate removed from
		 * the function on a running database, the leak test below fails with 1.
		 */
		await attempt(alice, 0, true, { id: unpublishedBookId, chunkIds: unpublishedChunkIds });
	});

	test.afterAll(async () => {
		// The probe books cannot be torn down — the service role has no DELETE grant on `books`,
		// deliberately, because deleting one cascades away every user's attempts and rollups.
		// Deleting the users is enough for the PROGRESS rows: chunk_attempts and both rollups
		// cascade with them.
		//
		// But the books themselves must also be RETIRED, and that means BOTH of them. The
		// published probe is a real, world-readable catalog entry for as long as it stays
		// published: `typing.e2e.ts` asserts the grid holds exactly the seeded fixtures, so a
		// probe left behind here fails a spec in another FILE, on the next run, with an
		// off-by-one card count and no hint of where the extra book came from. Unpublishing is
		// the whole teardown a book gets (see `support/probe-books.ts`), and it has to cover
		// every book this spec published, not only the one whose published state it toggled.
		await service
			.from('books')
			.update({ published_at: null })
			.in('id', [bookId, unpublishedBookId]);
		await deleteUsers(alice.id, bob.id);
	});

	test('a book with no progress resumes at 0', async () => {
		expect(await resumeIndex(alice.client, bookId)).toBe(0);
	});

	test('completing a chunk moves the resume index to the next one', async () => {
		await attempt(alice, 0, true);
		expect(await resumeIndex(alice.client, bookId)).toBe(1);
	});

	/*
	 * The gaps rule, and the reason these tests exist at all: this is what
	 * `firstIncompleteIndex`'s unit test pinned before Phase 3 deletes it. Completing 2 while 1
	 * is still open must NOT advance past 1 — the answer is the LOWEST incomplete index, not the
	 * highest completed one plus one, and not a count of completions.
	 */
	test('a gap keeps the resume index at the lowest incomplete chunk', async () => {
		await attempt(alice, 2, true);
		expect(await resumeIndex(alice.client, bookId)).toBe(1);
	});

	/*
	 * The invariant the migration comment calls out, made executable. The trigger writes a
	 * chunk_progress row for this attempt too; only `first_completed_at` distinguishes it. If the
	 * function ever tested row existence, this expectation goes from 1 to 3 — the user is dumped
	 * three passages past the one they abandoned.
	 */
	test('an attempted-but-abandoned chunk is not complete', async () => {
		await attempt(alice, 1, false);
		expect(await resumeIndex(alice.client, bookId)).toBe(1);
	});

	/*
	 * The function takes no user parameter — this is what that buys. Bob's progress differs from
	 * Alice's, and each signed-in caller gets their own answer from the same argument. A
	 * `p_user_id` parameter on a SECURITY DEFINER function would have made Alice's index readable
	 * by Bob for the asking.
	 */
	test('each signed-in user gets their own resume index, never another user’s', async () => {
		await attempt(bob, 0, true);
		await attempt(bob, 1, true);
		expect(await resumeIndex(bob.client, bookId)).toBe(2);
		expect(await resumeIndex(alice.client, bookId)).toBe(1);
	});

	/*
	 * There is no "finished" state (CONTEXT.md, Resume): a fully complete book restarts at 0,
	 * which is the same answer as a book never touched. Deliberate — the UI has one entry point.
	 */
	test('a fully complete book resumes at 0', async () => {
		await attempt(alice, 1, true);
		await attempt(alice, 3, true);
		expect(await resumeIndex(alice.client, bookId)).toBe(0);
	});

	test('an unknown book id resumes at 0', async () => {
		expect(await resumeIndex(alice.client, '00000000-0000-0000-0000-000000000000')).toBe(0);
	});

	/*
	 * The leak test. SECURITY DEFINER bypasses `20260731120000`'s RLS policies, so without the
	 * function's own `published_at is not null` predicate this would return a real index — and
	 * leak the existence, the length and the caller's position in a book that is not fit to read.
	 * Asserted as `authenticated`, because that is the role PostgREST hands the publishable key.
	 *
	 * Alice has a completed chunk 0 there (arranged in `beforeAll`), so the ungated answer would
	 * be 1. The 0 below is the gate, not an absence of data.
	 */
	test('an unpublished book resumes at 0 for an authenticated caller', async () => {
		expect(await resumeIndex(alice.client, unpublishedBookId)).toBe(0);
	});

	/*
	 * anon is refused outright rather than merely answered 0. auth.uid() would be null there, so
	 * the answer would be harmless — but "harmless by coincidence" is not a grant policy, and the
	 * revoke is what a later `grant execute ... to public` would have to undo visibly.
	 */
	test('anon cannot execute the function at all', async () => {
		const { data, error } = await anon.rpc('first_incomplete_chunk_index', { p_book_id: bookId });
		expect(error, 'anon must be refused, not answered').not.toBeNull();
		expect(data).toBeNull();
	});
});

/**
 * `books_featured_per_language_idx` — the partial unique index behind the landing hero
 * (spec #18 §7). It is what lets `getHeroBook` use `.maybeSingle()` honestly: at most one
 * featured book per language is a database guarantee, not a manifest convention.
 */
test.describe('books.featured', () => {
	test.describe.configure({ mode: 'serial' });
	test.skip(
		!isLocalStack,
		`refusing to write probe books against a non-local Supabase (${SUPABASE_URL})`
	);
	test.skip(!localSecretKey(), 'needs the local secret key: no client role may write books');

	let service: AnyClient;
	const slugs = ['featured-probe-en-1', 'featured-probe-en-2', 'featured-probe-es-1'];

	async function upsert(slug: string, language: 'en' | 'es', featured: boolean) {
		return service
			.from('books')
			.upsert(
				{ slug, title: slug, author: 'probe', language, chunk_count: 0, featured },
				{ onConflict: 'slug' }
			)
			.select('id')
			.single();
	}

	test.beforeAll(async () => {
		service = secretClient()!;
		// Start from a clean slate: unfeatured, so a re-run does not collide with itself.
		for (const slug of slugs) {
			const language = slug.includes('-es-') ? 'es' : 'en';
			const created = await upsert(slug, language as 'en' | 'es', false);
			expect(created.error, `arranging ${slug} failed: ${created.error?.message}`).toBeNull();
		}
	});

	test.afterAll(async () => {
		// Books cannot be deleted (no DELETE grant), so leave them unfeatured and unpublished —
		// invisible to every client, and harmless to the next run.
		for (const slug of slugs) {
			await service.from('books').update({ featured: false }).eq('slug', slug);
		}
	});

	test('a second featured book in the same language is rejected', async () => {
		const first = await upsert('featured-probe-en-1', 'en', true);
		expect(
			first.error,
			`the first featured book must be accepted: ${first.error?.message}`
		).toBeNull();

		const second = await upsert('featured-probe-en-2', 'en', true);
		expect(second.error, 'a second featured English book must be rejected').not.toBeNull();
		expect(second.error!.message).toContain('books_featured_per_language_idx');
	});

	test('one featured book per language is permitted', async () => {
		const spanish = await upsert('featured-probe-es-1', 'es', true);
		expect(
			spanish.error,
			`a featured Spanish book must coexist with a featured English one: ${spanish.error?.message}`
		).toBeNull();
	});

	/*
	 * The index is PARTIAL for a reason: a plain `unique (language)` would cap the whole catalog
	 * at one book per language, which is the opposite of what Phase 3 is building.
	 */
	test('unfeatured books in a language are unconstrained', async () => {
		const another = await upsert('featured-probe-en-2', 'en', false);
		expect(
			another.error,
			`an unfeatured second English book must be accepted: ${another.error?.message}`
		).toBeNull();
	});
});
