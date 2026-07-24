import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../src/lib/database.types';

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
 */

const SUPABASE_URL = process.env.PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54321';
const PUBLISHABLE_KEY =
	process.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';

const isLocalStack = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(SUPABASE_URL);

/** Tables that must be invisible to a signed-out client (spec #7 → RLS). */
const PRIVATE_TABLES = ['chunk_attempts', 'chunk_progress', 'book_progress', 'profiles'] as const;

/** The rollups have no client write policy at all — 2b's trigger is their only writer. */
const ROLLUP_TABLES = ['chunk_progress', 'book_progress'] as const;

type AnyClient = SupabaseClient<Database>;

function anonClient(): AnyClient {
	return createClient<Database>(SUPABASE_URL, PUBLISHABLE_KEY, {
		auth: { persistSession: false, autoRefreshToken: false }
	});
}

/**
 * The local secret key, used only to delete the throwaway users afterwards. It is
 * machine-specific, so it is read from the running stack rather than hardcoded; when it
 * cannot be read the tests still run and simply leave their users behind (a `db:reset`
 * clears them).
 */
function localSecretKey(): string | null {
	if (process.env.SUPABASE_SECRET_KEY) return process.env.SUPABASE_SECRET_KEY;
	try {
		const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
		const status = execFileSync(npx, ['supabase', 'status', '-o', 'json'], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore']
		});
		const parsed: unknown = JSON.parse(status);
		const key = (parsed as Record<string, unknown>)?.SECRET_KEY;
		return typeof key === 'string' ? key : null;
	} catch {
		return null;
	}
}

interface TestUser {
	client: AnyClient;
	id: string;
}

async function signUpUser(): Promise<TestUser> {
	const client = anonClient();
	const { data, error } = await client.auth.signUp({
		email: `rls-${randomUUID()}@typefy.test`,
		password: `Pw-${randomUUID()}`
	});
	expect(error, `sign-up failed: ${error?.message}`).toBeNull();
	expect(
		data.session,
		'local sign-up should return a session (confirmations disabled)'
	).not.toBeNull();
	expect(data.user).not.toBeNull();
	return { client, id: data.user!.id };
}

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

	test.beforeAll(async () => {
		anon = anonClient();
		[alice, bob] = await Promise.all([signUpUser(), signUpUser()]);

		// A real chunk to hang an attempt off, read as a guest (content is world-readable).
		const { data, error } = await anon.from('chunks').select('id, book_id').limit(1);
		expect(error, `reading chunks failed: ${error?.message}`).toBeNull();
		expect(data?.length, 'the local stack must be seeded (npm run db:reset)').toBe(1);
		chunkId = data![0].id;
		bookId = data![0].book_id;

		// 2a writes no progress, but the attempt row is what makes the isolation checks
		// below non-vacuous: Bob and the guest must miss a row that demonstrably exists.
		const { error: insertError } = await alice.client.from('chunk_attempts').insert({
			user_id: alice.id,
			chunk_id: chunkId,
			book_id: bookId,
			completed: true,
			gross_wpm: 42,
			accuracy_raw: 0.97,
			elapsed_ms: 30_000,
			started_at: new Date().toISOString()
		});
		expect(insertError, `seeding an attempt failed: ${insertError?.message}`).toBeNull();
	});

	test.afterAll(async () => {
		const secret = localSecretKey();
		if (!secret) return;
		const admin = createClient<Database>(SUPABASE_URL, secret, {
			auth: { persistSession: false, autoRefreshToken: false }
		});
		// Deleting the auth user cascades to profiles and every progress row.
		await Promise.all([admin.auth.admin.deleteUser(alice.id), admin.auth.admin.deleteUser(bob.id)]);
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
		expect(still.data).toEqual([{ gross_wpm: 42 }]);
	});

	for (const table of ROLLUP_TABLES) {
		test(`${table} is readable only per-user and not writable by a client`, async () => {
			// 2a never writes the rollups, so there is no row to hide — what is verified
			// here is that the tables are sealed: reads are scoped and writes are refused.
			const own = await alice.client.from(table).select('*');
			expect(own.error, `${table} read failed: ${own.error?.message}`).toBeNull();
			expect(own.data).toEqual([]);

			const write = await alice.client.from(table).insert({
				user_id: alice.id,
				book_id: bookId,
				...(table === 'chunk_progress' && { chunk_id: chunkId })
			});
			expect(write.error, `${table} accepted a client write`).not.toBeNull();
		});
	}

	test('creating an auth user creates exactly one matching profiles row', async () => {
		const carol = await signUpUser();
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
			const secret = localSecretKey();
			if (secret) {
				const admin = createClient<Database>(SUPABASE_URL, secret, {
					auth: { persistSession: false, autoRefreshToken: false }
				});
				await admin.auth.admin.deleteUser(carol.id);
			}
		}
	});
});
