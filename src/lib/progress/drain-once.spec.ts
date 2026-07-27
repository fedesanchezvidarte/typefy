import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttemptStorage, BufferedChunkAttempt } from './buffer';
import type { DrainResult } from './drain';
import { drainOnce } from './drain-once';

/**
 * Single-flight tests (spec #15 §4). The two Supabase-carrying modules are reached only
 * through `drain-once`'s dynamic `import()`, so they are the things mocked here: what this
 * module actually owns is *how often* a drain runs, not what a drain does.
 */

/**
 * `vi.mock` factories are hoisted above every `const` in the file, so the doubles and the
 * state they read must be created inside `vi.hoisted` to exist by the time they run.
 */
const harness = vi.hoisted(() => {
	const state = {
		/** What the mocked `getAttemptStorage` reports the buffer holds. */
		stored: [] as unknown[],
		/** `false` reproduces an unreachable storage binding. */
		storageAvailable: true,
		/** Lets a test hold a drain open and inspect concurrent callers. */
		gate: null as null | {
			resolve: (result: DrainResult) => void;
			reject: (error: unknown) => void;
		},
		drainResult: { written: 0, discarded: 0, remaining: 0 } as DrainResult
	};

	return {
		state,
		getAttemptStorage: vi.fn((): AttemptStorage | null => {
			if (!state.storageAvailable) return null;
			return {
				read: () => JSON.stringify(state.stored),
				write: () => {},
				clear: () => {}
			};
		}),
		getBrowserSupabase: vi.fn(() => ({}) as never),
		drainAttemptBuffer: vi.fn((): Promise<DrainResult> => {
			if (!state.gate) return Promise.resolve(state.drainResult);
			return new Promise((resolve, reject) => {
				state.gate = { resolve, reject };
			});
		})
	};
});

const { state, getBrowserSupabase, drainAttemptBuffer } = harness;

vi.mock('./storage', () => ({ getAttemptStorage: harness.getAttemptStorage }));
vi.mock('$lib/supabase/browser', () => ({ getBrowserSupabase: harness.getBrowserSupabase }));
vi.mock('./drain', () => ({ drainAttemptBuffer: harness.drainAttemptBuffer }));

const USER = '11111111-1111-1111-1111-111111111111';
const NOW = 1_700_000_100_000;

function entry(over: Partial<BufferedChunkAttempt> = {}): BufferedChunkAttempt {
	return {
		userId: null,
		chunkId: 'chunk-1',
		bookId: '44444444-4444-4444-4444-444444444444',
		completed: true,
		grossWpm: 60,
		accuracyRaw: 0.98,
		elapsedMs: 30_000,
		startedAt: NOW - 60_000,
		bufferedAt: NOW - 10_000,
		...over
	};
}

/**
 * Opens the gate so the next drain hangs until the test settles it.
 *
 * `release`/`fail` await the drain actually starting first: `run()` crosses two dynamic
 * imports before it calls `drainAttemptBuffer`, so settling on the next microtask would
 * settle a gate nobody is holding — and a drain left hanging would wedge the module-level
 * `inFlight` for every test after it.
 */
function holdNextDrain() {
	state.gate = { resolve: () => {}, reject: () => {} };
	const started = () => vi.waitFor(() => expect(drainAttemptBuffer).toHaveBeenCalled());
	return {
		release: async (result: DrainResult) => {
			await started();
			state.gate?.resolve(result);
		},
		fail: async (error: unknown) => {
			await started();
			state.gate?.reject(error);
		}
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	state.stored = [entry()];
	state.storageAvailable = true;
	state.gate = null;
	state.drainResult = { written: 0, discarded: 0, remaining: 0 };
});

describe('drainOnce — the cheap gate', () => {
	it('resolves null and never reaches the Supabase modules when the buffer is empty', async () => {
		state.stored = [];

		await expect(drainOnce(USER, NOW)).resolves.toBeNull();

		// This early return is what preserves the guest bundle guarantee at mount: no
		// dynamic import fires, so `@supabase/*` is never fetched.
		expect(drainAttemptBuffer).not.toHaveBeenCalled();
		expect(getBrowserSupabase).not.toHaveBeenCalled();
	});

	it('resolves null when the storage binding is unreachable', async () => {
		state.storageAvailable = false;

		await expect(drainOnce(USER, NOW)).resolves.toBeNull();
		expect(drainAttemptBuffer).not.toHaveBeenCalled();
	});

	it('drains when the buffer is non-empty, passing the injected clock and user through', async () => {
		state.drainResult = { written: 1, discarded: 0, remaining: 0 };

		const result = await drainOnce(USER, NOW);

		expect(result).toEqual({ written: 1, discarded: 0, remaining: 0 });
		expect(drainAttemptBuffer).toHaveBeenCalledTimes(1);
		expect(drainAttemptBuffer).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			USER,
			NOW
		);
	});
});

describe('drainOnce — reporting back', () => {
	it('reports that it wrote, so the caller can decide whether to invalidate', async () => {
		// The caller owns `invalidateAll()` — spec §11 scopes it to the mount and `online`
		// triggers only — so this module has to hand back enough to make that decision.
		state.drainResult = { written: 3, discarded: 1, remaining: 0 };

		const result = await drainOnce(USER, NOW);

		expect(result?.written).toBe(3);
	});

	it('reports that it wrote nothing when every entry was skipped or discarded', async () => {
		state.drainResult = { written: 0, discarded: 2, remaining: 1 };

		const result = await drainOnce(USER, NOW);

		expect(result?.written).toBe(0);
	});
});

describe('drainOnce — single flight', () => {
	it('joins concurrent triggers into one drain', async () => {
		const gate = holdNextDrain();

		const first = drainOnce(USER, NOW);
		const second = drainOnce(USER, NOW);
		const third = drainOnce(USER, NOW);
		await gate.release({ written: 2, discarded: 0, remaining: 0 });

		const results = await Promise.all([first, second, third]);
		expect(drainAttemptBuffer).toHaveBeenCalledTimes(1);
		expect(results[0]).toEqual({ written: 2, discarded: 0, remaining: 0 });
		expect(results[1]).toBe(results[0]);
		expect(results[2]).toBe(results[0]);
	});

	it('starts a fresh drain once the previous one has settled, rather than joining it', async () => {
		state.drainResult = { written: 1, discarded: 0, remaining: 0 };

		await drainOnce(USER, NOW);
		await drainOnce(USER, NOW);

		// The `online` event can fire repeatedly; each one after the last drain settled
		// must be able to pick up entries buffered since.
		expect(drainAttemptBuffer).toHaveBeenCalledTimes(2);
	});

	it('releases the flight after a failed drain, so a later trigger is not wedged forever', async () => {
		const gate = holdNextDrain();
		const first = drainOnce(USER, NOW);
		await gate.fail(new Error('boom'));

		await expect(first).resolves.toBeNull();

		state.gate = null;
		state.drainResult = { written: 1, discarded: 0, remaining: 0 };
		await expect(drainOnce(USER, NOW)).resolves.toEqual({
			written: 1,
			discarded: 0,
			remaining: 0
		});
		expect(drainAttemptBuffer).toHaveBeenCalledTimes(2);
	});

	it('never rejects — a drain failure must not surface as an unhandled rejection in the typing path', async () => {
		drainAttemptBuffer.mockRejectedValueOnce(new Error('offline'));

		await expect(drainOnce(USER, NOW)).resolves.toBeNull();
	});
});
