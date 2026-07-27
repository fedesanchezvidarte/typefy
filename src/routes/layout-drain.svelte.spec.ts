import { page } from 'vitest/browser';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { createRawSnippet } from 'svelte';
import type { User } from '@supabase/supabase-js';
import { ATTEMPT_BUFFER_KEY, type BufferedChunkAttempt } from '$lib/progress/buffer';
import type { DrainResult } from '$lib/progress/drain';
import Layout from './+layout.svelte';

/**
 * The root layout's two drain triggers and the sign-out hygiene rule (spec #15 §4, §5, §11).
 *
 * `drain-once.spec.ts` proves what a drain does and how often; what only this component can
 * prove is **who fires it, when, and whether `invalidateAll()` follows** — the half of §11
 * that `TypingSession.svelte.spec.ts` asserts the negative of. So `drainOnce` is the seam:
 * mocked, because a real one would need the Supabase chunk this layout exists to avoid
 * loading.
 *
 * The buffer is NOT mocked. It is the real module over the real `localStorage`, because the
 * synchronous `readAll(...).length === 0` gate in `maybeDrain` is the load-bearing line of
 * the whole guest bundle guarantee, and stubbing it out would leave nothing under test.
 *
 * The file is named without a `+` prefix on purpose: `src/routes/**` treats `+`-prefixed
 * files as route modules.
 */
const drainOnce = vi.hoisted(() => vi.fn());
const invalidateAll = vi.hoisted(() => vi.fn());

vi.mock('$lib/progress/drain-once', () => ({ drainOnce }));
vi.mock('$app/navigation', () => ({ invalidateAll }));
// The hidden locale links at the bottom of the layout read `page.url`; there is no
// SvelteKit router here to populate it.
vi.mock('$app/state', () => ({
	page: { url: new URL('http://localhost/type'), data: {}, params: {}, route: { id: null } }
}));
// `resolve` maps an app path to a href through the router's manifest, which does not exist
// outside a running app. Identity is enough: no assertion here reads a href.
vi.mock('$app/paths', () => ({ resolve: (path: string) => path, base: '', assets: '' }));

const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';

function user(id: string): User {
	// Only `id` is read by the layout's triggers; the rest is the shape `AppHeader` renders.
	return {
		id,
		app_metadata: {},
		user_metadata: { full_name: 'Test Typist' },
		aud: 'authenticated',
		created_at: new Date(0).toISOString(),
		email: 'typist@typefy.test'
	} as User;
}

function entry(over: Partial<BufferedChunkAttempt> = {}): BufferedChunkAttempt {
	return {
		userId: null,
		chunkId: 'chunk-1',
		bookId: '44444444-4444-4444-4444-444444444444',
		completed: true,
		grossWpm: 60,
		accuracyRaw: 0.98,
		elapsedMs: 30_000,
		startedAt: Date.now() - 600_000,
		bufferedAt: Date.now() - 590_000,
		...over
	};
}

function seedBuffer(entries: BufferedChunkAttempt[]): void {
	localStorage.setItem(ATTEMPT_BUFFER_KEY, JSON.stringify(entries));
}

function bufferEntries(): BufferedChunkAttempt[] {
	const raw = localStorage.getItem(ATTEMPT_BUFFER_KEY);
	return raw === null ? [] : (JSON.parse(raw) as BufferedChunkAttempt[]);
}

/** A minimal page body, so `{@render children()}` has something to render. */
const children = createRawSnippet(() => ({
	render: () => '<main data-testid="layout-child">page</main>'
}));

function renderLayout(currentUser: User | null) {
	return render(Layout, {
		children,
		data: { session: null, user: currentUser, palette: null, font: null }
	});
}

function drainResult(over: Partial<DrainResult> = {}): DrainResult {
	return { written: 0, discarded: 0, remaining: 0, ...over };
}

beforeEach(() => {
	vi.clearAllMocks();
	drainOnce.mockResolvedValue(drainResult());
	localStorage.removeItem(ATTEMPT_BUFFER_KEY);
});

describe('+layout.svelte — the mount drain trigger (spec #15 §4)', () => {
	it('drains as the signed-in user when the buffer is non-empty', async () => {
		seedBuffer([entry()]);

		renderLayout(user(USER_A));

		await expect.element(page.getByTestId('layout-child')).toBeInTheDocument();
		await expect.poll(() => drainOnce.mock.calls).toEqual([[USER_A]]);
	});

	it('does not drain for a guest, however full the buffer is', async () => {
		// The guest's entries are exactly what the sign-in prompt promises to recover, so
		// they stay — but there is no session to write them under, so nothing is attempted.
		seedBuffer([entry(), entry({ chunkId: 'chunk-2' })]);

		renderLayout(null);

		await expect.element(page.getByTestId('layout-child')).toBeInTheDocument();
		expect(drainOnce).not.toHaveBeenCalled();
		expect(bufferEntries()).toHaveLength(2);
	});

	it('does not drain when the buffer is empty — the synchronous gate that keeps the Supabase chunk unfetched', async () => {
		renderLayout(user(USER_A));

		await expect.element(page.getByTestId('layout-child')).toBeInTheDocument();
		expect(drainOnce).not.toHaveBeenCalled();
	});

	it('does not drain when every buffered entry has expired', async () => {
		// TTL is evaluated inside `readAll`, so an all-expired buffer reads as empty and the
		// gate holds: a 31-day-old entry must not cost a chunk fetch on every page load.
		seedBuffer([entry({ bufferedAt: Date.now() - 31 * 24 * 60 * 60 * 1000 })]);

		renderLayout(user(USER_A));

		await expect.element(page.getByTestId('layout-child')).toBeInTheDocument();
		expect(drainOnce).not.toHaveBeenCalled();
	});
});

describe('+layout.svelte — invalidateAll after a drain (spec #15 §11)', () => {
	it('invalidates when the mount drain wrote something, so the figures on screen catch up', async () => {
		seedBuffer([entry()]);
		drainOnce.mockResolvedValue(drainResult({ written: 2 }));

		renderLayout(user(USER_A));

		await vi.waitFor(() => expect(invalidateAll).toHaveBeenCalledTimes(1));
	});

	it('does not invalidate when the drain wrote nothing', async () => {
		// Every entry skipped or discarded: no rollup moved, so there is nothing to refresh
		// and a reload would be pure cost.
		seedBuffer([entry({ userId: USER_B })]);
		drainOnce.mockResolvedValue(drainResult({ discarded: 1, remaining: 1 }));

		renderLayout(user(USER_A));

		await expect.poll(() => drainOnce.mock.calls.length).toBe(1);
		expect(invalidateAll).not.toHaveBeenCalled();
	});

	it('does not invalidate when the drain reported nothing to do at all', async () => {
		seedBuffer([entry()]);
		drainOnce.mockResolvedValue(null);

		renderLayout(user(USER_A));

		await expect.poll(() => drainOnce.mock.calls.length).toBe(1);
		expect(invalidateAll).not.toHaveBeenCalled();
	});
});

describe('+layout.svelte — the online drain trigger (spec #15 §4)', () => {
	it('drains again when connectivity returns, and invalidates when that wrote', async () => {
		seedBuffer([entry()]);
		drainOnce.mockResolvedValue(drainResult({ written: 1 }));

		renderLayout(user(USER_A));
		await vi.waitFor(() => expect(invalidateAll).toHaveBeenCalledTimes(1));

		// The buffer is still non-empty as far as the layout can see (the mocked drain does
		// not empty it), which is the case a reconnect after a partial drain produces.
		window.dispatchEvent(new Event('online'));

		await vi.waitFor(() => expect(drainOnce).toHaveBeenCalledTimes(2));
		await vi.waitFor(() => expect(invalidateAll).toHaveBeenCalledTimes(2));
	});

	it('ignores an online event for a guest', async () => {
		seedBuffer([entry()]);

		renderLayout(null);
		window.dispatchEvent(new Event('online'));

		await expect.element(page.getByTestId('layout-child')).toBeInTheDocument();
		expect(drainOnce).not.toHaveBeenCalled();
	});

	it('stops listening once the layout is destroyed', async () => {
		seedBuffer([entry()]);
		const screen = renderLayout(user(USER_A));
		await expect.poll(() => drainOnce.mock.calls.length).toBe(1);

		screen.unmount();
		window.dispatchEvent(new Event('online'));

		// A listener that outlived its layout would keep draining as a user who may since
		// have signed out.
		await expect.poll(() => drainOnce.mock.calls.length).toBe(1);
	});
});

describe('+layout.svelte — sign-out and attribution hygiene (spec #15 §5)', () => {
	it('drops every signed-in-authored entry and keeps the guest-authored ones when no user is present', async () => {
		const guestAuthored = entry({ chunkId: 'guest-chunk' });
		seedBuffer([
			entry({ userId: USER_A, chunkId: 'a-chunk' }),
			guestAuthored,
			entry({ userId: USER_B, chunkId: 'b-chunk' })
		]);

		renderLayout(null);

		// The rule is `'*'`, not "the user who just left": it covers sign-out, session expiry
		// and any other transition to guest in one pass, including entries left by a user
		// this browser can no longer name.
		await expect.poll(bufferEntries).toEqual([guestAuthored]);
	});

	it('leaves the buffer untouched while a user is present', async () => {
		const owned = entry({ userId: USER_A, chunkId: 'a-chunk' });
		const guestAuthored = entry({ chunkId: 'guest-chunk' });
		seedBuffer([owned, guestAuthored]);

		renderLayout(user(USER_A));

		await expect.poll(() => drainOnce.mock.calls.length).toBe(1);
		// The drain — not the hygiene rule — is what empties the buffer for a signed-in user,
		// and it is mocked here, so both entries are still standing.
		expect(bufferEntries()).toHaveLength(2);
	});

	it('does not drop another user’s entries merely because this user is signed in', async () => {
		// Hygiene runs only on the transition to guest. While B is signed in, A's entries are
		// left alone and the drain's own attribution invariant is what keeps them unwritten.
		const foreign = entry({ userId: USER_A, chunkId: 'a-chunk' });
		seedBuffer([foreign]);

		renderLayout(user(USER_B));

		await expect.poll(() => drainOnce.mock.calls).toEqual([[USER_B]]);
		expect(bufferEntries()).toEqual([foreign]);
	});
});
