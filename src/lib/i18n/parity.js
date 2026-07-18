/**
 * Pure key-parity diff between two Paraglide message bundles.
 *
 * `$`-prefixed keys (e.g. `$schema`) are metadata, not messages, and are ignored.
 * Kept as plain ESM JavaScript so `scripts/check-i18n-parity.js` can import it
 * directly under Node without a build step.
 *
 * @param {Record<string, unknown>} a - first message bundle
 * @param {Record<string, unknown>} b - second message bundle
 * @returns {{ missingInA: string[]; missingInB: string[] }} keys absent from one side
 */
export function diffMessageKeys(a, b) {
	const keysA = new Set(Object.keys(a).filter((key) => !key.startsWith('$')));
	const keysB = new Set(Object.keys(b).filter((key) => !key.startsWith('$')));

	return {
		missingInA: [...keysB].filter((key) => !keysA.has(key)).sort(),
		missingInB: [...keysA].filter((key) => !keysB.has(key)).sort()
	};
}
