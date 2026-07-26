import { afterEach, describe, expect, it } from 'vitest';
import { getAttemptStorage } from './storage';

/**
 * Adapter tests (spec #15 §2). The Feature Brief marked this module "no unit test" on the
 * `supabase/browser.ts` precedent, but that precedent covers a constructor with no branch
 * and no error path — this one has three (absent binding, a throw on property access, a
 * throw on `getItem`) and every one of them is load-bearing for "the buffer never throws
 * into the typing path". So they are tested.
 *
 * The node project has no `localStorage`, which is exactly the SSR condition, so the
 * absent-binding case needs no stub at all.
 */

const KEY = 'typefy:attempt-buffer:v1';

/** Installs a stand-in for the `localStorage` global; `undefined` removes it again. */
function withLocalStorage(stub: unknown): void {
	if (stub === undefined) {
		delete (globalThis as Record<string, unknown>).localStorage;
		return;
	}
	Object.defineProperty(globalThis, 'localStorage', {
		value: stub,
		configurable: true,
		writable: true
	});
}

afterEach(() => withLocalStorage(undefined));

function memoryLocalStorage() {
	const values = new Map<string, string>();
	return {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => void values.set(key, value),
		removeItem: (key: string) => void values.delete(key),
		get size() {
			return values.size;
		}
	};
}

describe('getAttemptStorage', () => {
	it('returns null when there is no localStorage binding at all (SSR)', () => {
		expect(getAttemptStorage(KEY)).toBeNull();
	});

	it('returns null when touching the binding throws — a SecurityError in blocked storage', () => {
		Object.defineProperty(globalThis, 'localStorage', {
			configurable: true,
			get() {
				throw new Error('SecurityError');
			}
		});

		expect(getAttemptStorage(KEY)).toBeNull();
	});

	it('returns null when the binding exists but refuses to be read', () => {
		withLocalStorage({
			getItem: () => {
				throw new Error('SecurityError');
			},
			setItem: () => {},
			removeItem: () => {}
		});

		expect(getAttemptStorage(KEY)).toBeNull();
	});

	it('reads, writes and clears exactly the key it was given', () => {
		const backing = memoryLocalStorage();
		withLocalStorage(backing);

		const storage = getAttemptStorage(KEY);
		expect(storage).not.toBeNull();

		expect(storage?.read()).toBeNull();
		storage?.write('[]');
		expect(backing.getItem(KEY)).toBe('[]');
		expect(storage?.read()).toBe('[]');
		storage?.clear();
		expect(backing.getItem(KEY)).toBeNull();
		expect(backing.size).toBe(0);
	});

	it('surfaces a write refusal to the caller, which is where the swallowing lives', () => {
		withLocalStorage({
			getItem: () => null,
			setItem: () => {
				throw new Error('QuotaExceededError');
			},
			removeItem: () => {}
		});

		// The adapter stays dumb: `buffer.ts` owns the totality contract, and it can only
		// honour it (clear the key on a quota error) if the throw actually reaches it.
		expect(() => getAttemptStorage(KEY)?.write('[]')).toThrow();
	});
});
