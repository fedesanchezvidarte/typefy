import { expect, test } from '@playwright/test';
import {
	anonClient,
	deleteUsers,
	epoch,
	isLocalStack,
	signUpUser,
	SUPABASE_URL,
	type AnyClient,
	type TestUser
} from './support/supabase';

/**
 * RLS isolation + the profile trigger, exercised against the local Supabase stack
 * (spec #7): "a signed-out client cannot read any row of chunk_attempts,
 * chunk_progress, book_progress, or another user's profiles — verified by test, not by
 * inspection", and "creating an auth.users row creates exactly one matching profiles
 * row".
 *
 * These are database-level tests: they talk to PostgREST/GoTrue directly with
 * supabase-js and never open a page. They live in the Playwright suite rather than in
 * Vitest because the unit suite is forbidden from touching a real database
 * (testing-patterns); the E2E suite already runs against a seeded local stack in CI.
 *
 * They create throwaway users, so they refuse to run against anything but a local
 * stack.
 *
 * Trigger *behaviour* belongs to `progress.e2e.ts`; what this file asserts about the
 * rollups is only that RLS still seals them once they hold rows.
 */

/** Tables that must be invisible to a signed-out client (spec #7 → RLS). */
const PRIVATE_TABLES = ['chunk_attempts', 'chunk_progress', 'book_progress', 'profiles'] as const;

/** The rollups have no client write policy at all — 2b's trigger is their only writer. */
const ROLLUP_TABLES = ['chunk_progress', 'book_progress'] as const;

/** The seeded attempt every rollup assertion below is derived from. */
const SEED_ATTEMPT = {
	gross_wpm: 42,
	accuracy_raw: 0.97,
	elapsed_ms: 30_000
} as const;

/**
 * A read that RLS must not satisfy: either PostgREST refuses it (no grant, 42501) or
 * the policy filters every row away. Both are "cannot read"; which one applies depends
 * on whether the role holds a table grant, and the test should not care.
 */
function expectNoRows(result: { data: unknown[] | null; error: { code?: string } | null }) {
	if (result.error) {
		expect(result.error.code).toBe('42501');
		return;
	}
	expect(result.data ?? []).toEqual([]);
}

test.describe('database access rules', () => {
	// Serial: the suite shares two users and one seeded attempt row.
	test.describe.configure({ mode: 'serial' });
	test.skip(
		!isLocalStack,
		`refusing to create throwaway users against a non-local Supabase (${SUPABASE_URL})`
	);

	let anon: AnyClient;
	let alice: TestUser;
	let bob: TestUser;
	let bookId: string;
	let chunkId: string;
	/** The server clock stamped on the seeded attempt — every rollup timestamp must equal it. */
	let attemptCreatedAt: string;

	test.beforeAll(async () => {
		anon = anonClient();
		[alice, bob] = await Promise.all([signUpUser('rls'), signUpUser('rls')]);

		// A real chunk to hang an attempt off, read as a guest (content is world-readable).
		const { data, error } = await anon.from('chunks').select('id, book_id').limit(1);
		expect(error, `reading chunks failed: ${error?.message}`).toBeNull();
		expect(data?.length, 'the local stack must be seeded (npm run db:reset)').toBe(1);
		chunkId = data![0].id;
		bookId = data![0].book_id;

		// The attempt row is what makes the isolation checks below non-vacuous: Bob and the
		// guest must miss a row that demonstrably exists. Since 2b's trigger fires on this
		// insert, it is also what populates the rollups the last two tests read — the seed
		// values and those assertions are a coupled pair.
		const seeded = await alice.client
			.from('chunk_attempts')
			.insert({
				user_id: alice.id,
				chunk_id: chunkId,
				book_id: bookId,
				completed: true,
				...SEED_ATTEMPT,
				started_at: new Date().toISOString()
			})
			.select('created_at')
			.single();
		expect(seeded.error, `seeding an attempt failed: ${seeded.error?.message}`).toBeNull();
		attemptCreatedAt = seeded.data!.created_at;
	});

	test.afterAll(async () => {
		// Deleting the auth user cascades to profiles and every progress row.
		await deleteUsers(alice.id, bob.id);
	});

	test('a signed-out client can read books and chunks', async () => {
		const books = await anon.from('books').select('id, slug, title, language');
		expect(books.error, `books read failed: ${books.error?.message}`).toBeNull();
		expect(books.data!.length).toBeGreaterThan(0);

		const chunks = await anon.from('chunks').select('id, book_id, index, content');
		expect(chunks.error, `chunks read failed: ${chunks.error?.message}`).toBeNull();
		expect(chunks.data!.length).toBeGreaterThan(0);
	});

	for (const table of PRIVATE_TABLES) {
		test(`a signed-out client cannot read ${table}`, async () => {
			expectNoRows(await anon.from(table).select('*'));
		});
	}

	test('a signed-in user reads their own attempt but never another user’s', async () => {
		const own = await alice.client.from('chunk_attempts').select('id, user_id');
		expect(own.error, `Alice's own read failed: ${own.error?.message}`).toBeNull();
		expect(own.data!.length).toBe(1);
		expect(own.data![0].user_id).toBe(alice.id);

		// Bob sees nothing at all, and nothing when asking for Alice's rows by id either.
		expectNoRows(await bob.client.from('chunk_attempts').select('*'));
		expectNoRows(await bob.client.from('chunk_attempts').select('*').eq('user_id', alice.id));
	});

	test('a signed-in user reads only their own profile', async () => {
		const own = await bob.client.from('profiles').select('id');
		expect(own.error, `Bob's profile read failed: ${own.error?.message}`).toBeNull();
		expect(own.data).toEqual([{ id: bob.id }]);

		expectNoRows(await bob.client.from('profiles').select('*').eq('id', alice.id));
	});

	test('chunk_attempts is append-only: a user cannot update or delete their own attempt', async () => {
		const update = await alice.client
			.from('chunk_attempts')
			.update({ gross_wpm: 999 })
			.eq('user_id', alice.id)
			.select();
		// No update policy and no update grant: refused outright, or silently matching no row.
		if (!update.error) expect(update.data).toEqual([]);

		const remove = await alice.client
			.from('chunk_attempts')
			.delete()
			.eq('user_id', alice.id)
			.select();
		if (!remove.error) expect(remove.data).toEqual([]);

		const still = await alice.client.from('chunk_attempts').select('gross_wpm');
		expect(still.data).toEqual([{ gross_wpm: SEED_ATTEMPT.gross_wpm }]);
	});

	for (const table of ROLLUP_TABLES) {
		test(`${table} is readable only per-user and not writable by a client`, async () => {
			// 2b's trigger populated these from the seeded attempt, so the isolation check
			// is no longer vacuous: there is a real row for Bob and the guest to miss.
			const own = await alice.client.from(table).select('user_id');
			expect(own.error, `${table} read failed: ${own.error?.message}`).toBeNull();
			expect(own.data).toEqual([{ user_id: alice.id }]);

			expectNoRows(await bob.client.from(table).select('*'));
			expectNoRows(await bob.client.from(table).select('*').eq('user_id', alice.id));
			expectNoRows(await anon.from(table).select('*'));

			// No client write policy and no write grant: the trigger is the sole writer.
			const write = await alice.client.from(table).insert({
				user_id: alice.id,
				book_id: bookId,
				...(table === 'chunk_progress' && { chunk_id: chunkId })
			});
			expect(write.error, `${table} accepted a client write`).not.toBeNull();
		});
	}

	test('the seeded attempt is rolled up into chunk_progress', async () => {
		const { data, error } = await alice.client.from('chunk_progress').select('*').single();
		expect(error, `chunk_progress read failed: ${error?.message}`).toBeNull();
		expect(data!.chunk_id).toBe(chunkId);
		expect(data!.book_id).toBe(bookId);
		expect(data!.attempt_count).toBe(1);
		expect(Number(data!.best_wpm)).toBeCloseTo(SEED_ATTEMPT.gross_wpm, 6);
		expect(Number(data!.best_accuracy_raw)).toBeCloseTo(SEED_ATTEMPT.accuracy_raw, 6);
		// Both timestamps derive from the attempt's server-clock created_at.
		expect(epoch(data!.first_completed_at)).toBe(epoch(attemptCreatedAt));
		expect(epoch(data!.last_attempt_at)).toBe(epoch(attemptCreatedAt));
	});

	test('the seeded attempt is rolled up into book_progress', async () => {
		const { data, error } = await alice.client.from('book_progress').select('*').single();
		expect(error, `book_progress read failed: ${error?.message}`).toBeNull();
		expect(data!.book_id).toBe(bookId);
		expect(data!.chunks_completed).toBe(1);
		expect(epoch(data!.last_active_at)).toBe(epoch(attemptCreatedAt));
	});

	test('creating an auth user creates exactly one matching profiles row', async () => {
		const carol = await signUpUser('rls');
		try {
			// Counted with the head request so the assertion is about row count, not payload.
			const { count, error } = await carol.client
				.from('profiles')
				.select('*', { count: 'exact', head: true });
			expect(error, `profile count failed: ${error?.message}`).toBeNull();
			// RLS scopes the count to Carol's own rows, so 1 means exactly one profile
			// exists for the auth user the trigger just saw.
			expect(count).toBe(1);

			const { data } = await carol.client.from('profiles').select('id, locale');
			expect(data).toEqual([{ id: carol.id, locale: null }]);
		} finally {
			await deleteUsers(carol.id);
		}
	});
});
