import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test as base } from '@playwright/test';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../src/lib/database.types';
import {
	deleteUsers,
	isLocalStack,
	PUBLISHABLE_KEY,
	readSeededBook,
	SUPABASE_URL,
	type SeededBook
} from '../support/supabase';

/**
 * The authenticated Playwright fixture (spec #12, Feature Brief §6).
 *
 * Every test that needs a signed-in browser gets its OWN throwaway user, its own seeded
 * progress and its own teardown. That per-test shape is deliberate and is why this is a
 * fixture module rather than a `globalSetup`: the resume criteria need mutually exclusive
 * progress states for the same book (passages 1–3 complete; a gap; fully completed), which
 * one shared user cannot hold without the tests mutating each other's setup.
 *
 * ## How the cookies are produced
 *
 * The session cookie's name, encoding and chunk-splitting are `@supabase/ssr` implementation
 * details that will drift, so they are NEVER hand-constructed. Instead this module runs
 * `createServerClient` in Node with the same `getAll`/`setAll` callback shape
 * `src/hooks.server.ts` uses, signs a user up, and lets the library emit whatever it emits.
 * Whatever lands in the recording jar is written out as a Playwright `storageState`.
 *
 * The only claim made about the result is that at least one cookie was recorded — never
 * their names, never their count — so a future `@supabase/ssr` release that renames the
 * cookie or moves its chunking threshold cannot break this fixture.
 *
 * ## Why sign-up, and why local only
 *
 * Local email sign-up returns a session directly (`enable_confirmations = false` in
 * `supabase/config.toml`), which is what makes a throwaway user cheap. Hosted Supabase has
 * email sign-up disabled, and these users are real rows, so the fixture REFUSES to run
 * against anything but a local stack. Specs carry the matching
 * `test.skip(!isLocalStack, ...)` so a non-local configuration skips rather than fails —
 * the same contract `rls.e2e.ts` and `progress.e2e.ts` already follow.
 *
 * This file deliberately does NOT match Playwright's `**\/*.e2e.{ts,js}` testMatch glob:
 * it is a fixture module, not a spec. Keep it that way.
 */

/** Metrics for a seeded completion. Plausible, and never asserted on — only completion is. */
const SEEDED_ATTEMPT = { gross_wpm: 55, accuracy_raw: 0.97, elapsed_ms: 30_000 } as const;

export interface AuthUser {
	/** `auth.users.id`, which is also every progress row's `user_id`. */
	id: string;
	email: string;
	/**
	 * A supabase-js client already carrying this user's session — the same one whose cookies
	 * the browser context holds. Use it to seed progress and to read back what the app wrote.
	 */
	client: SupabaseClient<Database>;
	/** Path to the generated `storageState` file. Consumed by the `storageState` fixture. */
	storageStatePath: string;
	/**
	 * Mark the given 0-BASED passage positions complete by inserting real `chunk_attempts`
	 * rows; the trigger then produces the rollups. The rollups are never written directly —
	 * they have no client write policy, and going through the trigger is what makes a resume
	 * test honest about the data the app will actually read.
	 *
	 * Returns the book it read, so a test can assert against the seeded chunk count rather
	 * than hardcoding it.
	 */
	completePassages(bookSlug: string, positions: readonly number[]): Promise<SeededBook>;
}

interface RecordedCookie {
	name: string;
	value: string;
	options: CookieOptions;
}

/**
 * Sign a throwaway user up and capture the cookies `@supabase/ssr` writes for its session.
 *
 * `getAll` reads back from the same jar `setAll` fills, rather than returning a constant
 * empty list: the client must be able to re-read its own session (a `getUser()` or a token
 * refresh goes through storage), and a jar that only ever swallows writes would leave it
 * looking signed out halfway through a test.
 */
async function signUpRecordingCookies(): Promise<{
	id: string;
	email: string;
	client: SupabaseClient<Database>;
	cookies: RecordedCookie[];
}> {
	const jar = new Map<string, RecordedCookie>();

	const client = createServerClient<Database>(SUPABASE_URL, PUBLISHABLE_KEY, {
		cookies: {
			getAll: () => [...jar.values()].map(({ name, value }) => ({ name, value })),
			setAll: (cookiesToSet) => {
				for (const cookie of cookiesToSet) {
					jar.set(cookie.name, cookie);
				}
			}
		}
	});

	const email = `e2e-auth-${randomUUID()}@typefy.test`;
	const { data, error } = await client.auth.signUp({ email, password: `Pw-${randomUUID()}` });
	expect(error, `sign-up failed: ${error?.message}`).toBeNull();
	expect(
		data.session,
		'local sign-up should return a session (confirmations disabled)'
	).not.toBeNull();
	expect(data.user).not.toBeNull();

	const cookies = [...jar.values()];
	// The ONLY assertion about the cookies: that the library emitted some. Asserting a name
	// or a count would re-encode the implementation detail this whole approach exists to avoid.
	expect(cookies.length, 'the ssr client recorded no session cookies').toBeGreaterThan(0);

	return { id: data.user!.id, email, client, cookies };
}

/**
 * Serialise recorded cookies as a Playwright `storageState` file, scoped to the app's host.
 *
 * The domain is the app's HOSTNAME, never `host:port`: cookies are not port-scoped, and
 * Playwright rejects a domain carrying one.
 */
async function writeStorageState(cookies: RecordedCookie[], appUrl: URL): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), 'typefy-e2e-auth-'));
	const path = join(directory, 'storage-state.json');
	const state = {
		cookies: cookies.map(({ name, value, options }) => ({
			name,
			value,
			domain: appUrl.hostname,
			path: options.path ?? '/',
			// Playwright wants seconds since epoch, or -1 for a session cookie.
			expires: options.maxAge ? Math.floor(Date.now() / 1000) + options.maxAge : -1,
			// Both match `@supabase/ssr`'s defaults, which is what `hooks.server.ts` writes:
			// the browser client reads the cookie from `document.cookie`, so it cannot be
			// httpOnly, and a local stack is plain http.
			httpOnly: false,
			secure: false,
			sameSite: 'Lax' as const
		})),
		origins: []
	};
	await writeFile(path, JSON.stringify(state), 'utf8');
	return path;
}

async function createAuthenticatedUser(baseURL: string): Promise<AuthUser> {
	if (!isLocalStack) {
		throw new Error(
			`refusing to create a throwaway user against a non-local Supabase (${SUPABASE_URL})`
		);
	}

	const { id, email, client, cookies } = await signUpRecordingCookies();
	const storageStatePath = await writeStorageState(cookies, new URL(baseURL));

	return {
		id,
		email,
		client,
		storageStatePath,
		async completePassages(bookSlug, positions) {
			const book = await readSeededBook(client, bookSlug);
			// Sequential: the two rollup upserts run inside the trigger for every insert, and
			// concurrent attempts on the same (user, book) would contend on `book_progress`
			// for no gain — there are only ever a handful of rows here.
			for (const position of positions) {
				expect(
					book.chunkIds[position],
					`${bookSlug} has no passage at position ${position}`
				).toBeDefined();
				const { error } = await client.from('chunk_attempts').insert({
					user_id: id,
					chunk_id: book.chunkIds[position],
					book_id: book.id,
					completed: true,
					started_at: new Date().toISOString(),
					...SEEDED_ATTEMPT
				});
				expect(error, `seeding passage ${position} failed: ${error?.message}`).toBeNull();
			}
			return book;
		}
	};
}

/**
 * `authUser` creates the user; `storageState` — Playwright's own option fixture, which the
 * built-in `context` depends on — is overridden to point at the file `authUser` produced, so
 * every page in the test opens already signed in.
 *
 * Teardown deletes the auth user with the local secret key, which cascades to `profiles`,
 * `chunk_attempts` and both rollups, and removes the temp state file. When the key cannot be
 * read the user is left behind and `npm run db:reset` clears it — the same tolerance
 * `rls.e2e.ts` already accepts, for the same reason (the key is machine-specific).
 */
export const test = base.extend<{ authUser: AuthUser }>({
	authUser: async ({ baseURL }, use) => {
		expect(baseURL, 'playwright.config.ts must define use.baseURL').toBeTruthy();
		const user = await createAuthenticatedUser(baseURL!);
		try {
			await use(user);
		} finally {
			await deleteUsers(user.id);
			await rm(dirname(user.storageStatePath), { recursive: true, force: true });
		}
	},
	storageState: async ({ authUser }, use) => {
		await use(authUser.storageStatePath);
	}
});

export { expect } from '@playwright/test';
