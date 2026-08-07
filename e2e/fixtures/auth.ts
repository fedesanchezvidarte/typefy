import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test as base, type BrowserContext } from '@playwright/test';
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
 * ## Two fixtures, one minting path (spec #15, Phase 7)
 *
 * `test` is the original: one throwaway user, `storageState` overridden, so every page opens
 * already signed in. Two spec #15 criteria cannot use it, for reasons of construction rather
 * than convenience:
 *
 * - **Guest → sign-in backfill** must START as a guest and BECOME signed in mid-test.
 *   `storageState` is applied when the context is created and cannot be revised afterwards.
 * - **A/B attribution** needs a SECOND distinct user in the same browser profile, which is
 *   one more than `storageState` can express.
 *
 * So `guestTest` opens with no session at all and hands the test `mintUser` (create a
 * throwaway user on demand, torn down with the test) and `session.signInAs` / `session.reset`
 * (put that user's cookies on the live context, or take every cookie away). The minting and
 * teardown code is shared with `test` rather than forked — a second sign-up path would be a
 * second thing to keep in step with `@supabase/ssr`.
 *
 * ## What `signInAs` does and does not simulate
 *
 * The app's only sign-in is Google OAuth, which cannot be driven from a test: it is a
 * third-party consent screen on a domain we do not control, behind bot detection. What CAN be
 * reproduced exactly is its OUTCOME. `/auth/callback` calls `exchangeCodeForSession`, and
 * `hooks.server.ts` writes whatever cookies `@supabase/ssr` emits for the resulting session;
 * this module runs the same library over the same callback shape and puts the same cookies on
 * the context. Everything downstream of the cookie — `safeGetSession`, the layout's
 * `data.user`, the mount drain, RLS on every write — is then the real code path, reached by a
 * real full page load, which is exactly how a returning OAuth user arrives.
 *
 * Not covered, and not claimed to be: the redirect chain to Google and back, the PKCE
 * exchange, and `/auth/callback` itself. Those are `src/routes/auth/`'s to prove.
 *
 * This file deliberately does NOT match Playwright's `**\/*.e2e.{ts,js}` testMatch glob:
 * it is a fixture module, not a spec. Keep it that way.
 */

/**
 * Metrics for a seeded completion. Plausible, and never asserted on — only completion is.
 *
 * Fully-Normal since spec #24 (`measured_ms = elapsed_ms`, a measured span past the
 * 100-character best guard), so a seeded passage looks exactly like one the app would have
 * written in Normal rather than like a row that opted out of measurement.
 */
const SEEDED_ATTEMPT = {
	gross_wpm: 55,
	accuracy_raw: 0.97,
	elapsed_ms: 30_000,
	mode: 'normal',
	measured_ms: 30_000,
	measured_chars: 420
} as const;

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
	 * The same session as `storageStatePath`, in the shape `context.addCookies` takes — the
	 * only way to hand a session to a context that already exists. `storageState` is fixed at
	 * context creation, so a test that signs in midway, or that swaps one user for another,
	 * has to go through here.
	 */
	cookies: PlaywrightCookie[];
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

/** Exactly what `BrowserContext.addCookies` and a `storageState` file both accept. */
type PlaywrightCookie = Parameters<BrowserContext['addCookies']>[0][number];

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
 * Translate recorded cookies into Playwright's cookie shape, scoped to the app's host.
 *
 * The domain is the app's HOSTNAME, never `host:port`: cookies are not port-scoped, and
 * Playwright rejects a domain carrying one.
 *
 * One shape feeds both consumers — the `storageState` file the original fixture writes and
 * the `context.addCookies` call the mid-test sign-in makes — so the two can never disagree
 * about what a session looks like.
 */
function toPlaywrightCookies(cookies: RecordedCookie[], appUrl: URL): PlaywrightCookie[] {
	return cookies.map(({ name, value, options }) => ({
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
	}));
}

async function writeStorageState(cookies: PlaywrightCookie[]): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), 'typefy-e2e-auth-'));
	const path = join(directory, 'storage-state.json');
	await writeFile(path, JSON.stringify({ cookies, origins: [] }), 'utf8');
	return path;
}

/**
 * Sign a throwaway user up and return everything a test can do with it: read its rows, seed
 * its progress, hand its session to a context, or open a whole browser on it.
 *
 * Exported so a spec can mint a SECOND user — the A/B attribution criterion needs two
 * distinct accounts in one browser profile, which no `storageState`-shaped fixture can hold.
 * Pair it with {@link disposeUser}; the fixtures below do that for you.
 */
export async function mintUser(baseURL: string): Promise<AuthUser> {
	if (!isLocalStack) {
		throw new Error(
			`refusing to create a throwaway user against a non-local Supabase (${SUPABASE_URL})`
		);
	}

	const { id, email, client, cookies } = await signUpRecordingCookies();
	const playwrightCookies = toPlaywrightCookies(cookies, new URL(baseURL));
	const storageStatePath = await writeStorageState(playwrightCookies);

	return {
		id,
		email,
		client,
		storageStatePath,
		cookies: playwrightCookies,
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
 * Delete the throwaway auth user (which cascades to `profiles`, `chunk_attempts` and both
 * rollups) and remove its temp state file. When the secret key cannot be read the user is
 * left behind and `npm run db:reset` clears it — the same tolerance `rls.e2e.ts` already
 * accepts, for the same reason (the key is machine-specific).
 */
export async function disposeUser(user: AuthUser): Promise<void> {
	await deleteUsers(user.id);
	await rm(dirname(user.storageStatePath), { recursive: true, force: true });
}

/**
 * `authUser` creates the user; `storageState` — Playwright's own option fixture, which the
 * built-in `context` depends on — is overridden to point at the file `authUser` produced, so
 * every page in the test opens already signed in.
 */
export const test = base.extend<{ authUser: AuthUser }>({
	authUser: async ({ baseURL }, use) => {
		expect(baseURL, 'playwright.config.ts must define use.baseURL').toBeTruthy();
		const user = await mintUser(baseURL!);
		try {
			await use(user);
		} finally {
			await disposeUser(user);
		}
	},
	storageState: async ({ authUser }, use) => {
		await use(authUser.storageStatePath);
	}
});

/**
 * Switches the live browser context between sessions. This is the seam `storageState` cannot
 * reach: it is read once, when the context is created.
 */
export interface SessionControl {
	/**
	 * Make the browser this user's. Every existing cookie is cleared first, so signing in as
	 * B genuinely REPLACES A rather than layering a second session cookie over the first —
	 * which is also what makes the A/B attribution test honest.
	 *
	 * The cookies only take effect on the next document load; the caller navigates.
	 */
	signInAs(user: AuthUser): Promise<void>;
	/** Take every cookie away: the browser is a guest again, as after `/auth/signout`. */
	reset(): Promise<void>;
}

/**
 * The guest-first fixture. No `storageState` override, so the browser opens with no session
 * at all — and `mintUser` / `session` are what let a test acquire one partway through.
 *
 * Users minted here are torn down when the test ends, however many were made.
 */
export const guestTest = base.extend<{
	/** Create a throwaway user, registered for teardown. Call it twice for an A/B test. */
	mintUser: () => Promise<AuthUser>;
	session: SessionControl;
}>({
	mintUser: async ({ baseURL }, use) => {
		expect(baseURL, 'playwright.config.ts must define use.baseURL').toBeTruthy();
		const minted: AuthUser[] = [];
		try {
			await use(async () => {
				const user = await mintUser(baseURL!);
				minted.push(user);
				return user;
			});
		} finally {
			// Sequential and error-tolerant by way of `disposeUser`, which never throws: one
			// failed teardown must not strand the other user's rows.
			for (const user of minted) await disposeUser(user);
		}
	},
	session: async ({ context }, use) => {
		await use({
			async signInAs(user) {
				await context.clearCookies();
				await context.addCookies(user.cookies);
			},
			async reset() {
				await context.clearCookies();
			}
		});
	}
});

export { expect } from '@playwright/test';
