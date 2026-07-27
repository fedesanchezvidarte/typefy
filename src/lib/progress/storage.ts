import type { AttemptStorage } from './buffer';

/**
 * The attempt buffer's `localStorage` adapter (spec #15 §2) — the ONE module in the app
 * that names `localStorage`, exactly as `src/lib/supabase/browser.ts` is the one module
 * that constructs a browser Supabase client. Every consumer receives the port instead
 * (`lib-patterns`), which is what lets `buffer.ts` stay pure and fake-testable.
 *
 * **One deliberate divergence from that precedent: this module is statically importable.**
 * `browser.ts` is dynamic-import-only because it drags ~100 kB of third-party code into
 * whoever touches it. This adapter has zero dependencies, and the mount-time "is there
 * anything to drain?" check has to be synchronous and free — a dynamic import there would
 * put an `await` in front of a question that is usually answered "no".
 *
 * It lives beside the attempt buffer rather than under some `storage/` directory because
 * it constructs the *attempt buffer's* storage, and the port it satisfies is declared by
 * its consumer — the correct dependency direction.
 */

/**
 * The buffer's window onto one `localStorage` key, or `null` when the binding is
 * unreachable: SSR (there is no such global), private mode, or storage disabled by policy.
 *
 * The probe sits INSIDE the try/catch on purpose. A blocked-storage `SecurityError` is
 * thrown on *property access* to `window.localStorage`, not on the later `getItem`, so a
 * try/catch wrapped around only the calls would never see it.
 *
 * `read` is probed here rather than assumed, so a binding that exists but refuses to be
 * read resolves to `null` once, at construction, instead of throwing on the first use.
 *
 * `write` and `clear` are NOT wrapped: a quota error must reach `buffer.ts`, which owns
 * the totality contract and responds by clearing the key. Swallowing it here would leave
 * the stored value and the buffer's behaviour silently disagreeing.
 */
export function getAttemptStorage(key: string): AttemptStorage | null {
	try {
		const binding = globalThis.localStorage;
		if (!binding) return null;
		binding.getItem(key);
		return {
			read: () => binding.getItem(key),
			write: (value: string) => binding.setItem(key, value),
			clear: () => binding.removeItem(key)
		};
	} catch {
		return null;
	}
}
