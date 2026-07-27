/**
 * Pure parity diff between two Paraglide message bundles.
 *
 * Two levels are compared:
 *
 * 1. **Top-level message keys.** `$`-prefixed keys (e.g. `$schema`) are metadata,
 *    not messages, and are ignored.
 * 2. **Variant arms.** A pluralised message is stored by
 *    `@inlang/plugin-message-format` as an array whose first element carries
 *    `declarations` / `selectors` / `match`, where `match` maps a selector
 *    expression (`"countPlural=one"`, `"countPlural=*"`) to a pattern. Comparing
 *    only top-level keys lets a locale ship a message that is missing an entire
 *    arm — it is one key on both sides, so it passes. Comparing the `match` key
 *    sets closes that.
 *
 * A flat string message has an empty arm set, so a message that is a variant in
 * one bundle and a plain string in the other surfaces as the flat side missing
 * every arm — which is exactly the failure it is.
 *
 * Kept as plain ESM JavaScript so `scripts/check-i18n-parity.js` can import it
 * directly under Node without a build step.
 */

/**
 * Normalizes a `match` key so cosmetic whitespace is not a parity difference.
 * `"countPlural = one"` and `"countPlural=one"` select the same variant.
 *
 * @param {string} matchKey
 * @returns {string}
 */
const normalizeMatchKey = (matchKey) => matchKey.replace(/\s+/g, '');

/**
 * The sorted, normalized `match` keys of a message value. A plain string
 * message (the common case) has no variants and yields `[]`.
 *
 * @param {unknown} value - a single message's value from a bundle
 * @returns {string[]}
 */
export function messageMatchKeys(value) {
	if (!Array.isArray(value)) return [];

	const variant = value[0];
	if (typeof variant !== 'object' || variant === null) return [];

	const match = /** @type {{ match?: unknown }} */ (variant).match;
	if (typeof match !== 'object' || match === null) return [];

	return Object.keys(match).map(normalizeMatchKey).sort();
}

/**
 * @typedef {object} VariantMismatch
 * @property {string} key - the message key whose arms differ
 * @property {string[]} missingInA - arms present in `b` but absent from `a`
 * @property {string[]} missingInB - arms present in `a` but absent from `b`
 */

/**
 * @param {Record<string, unknown>} a - first message bundle
 * @param {Record<string, unknown>} b - second message bundle
 * @returns {{ missingInA: string[]; missingInB: string[]; variantMismatches: VariantMismatch[] }}
 */
export function diffMessageKeys(a, b) {
	const keysA = new Set(Object.keys(a).filter((key) => !key.startsWith('$')));
	const keysB = new Set(Object.keys(b).filter((key) => !key.startsWith('$')));

	/** @type {VariantMismatch[]} */
	const variantMismatches = [];

	for (const key of [...keysA].filter((key) => keysB.has(key)).sort()) {
		const armsA = new Set(messageMatchKeys(a[key]));
		const armsB = new Set(messageMatchKeys(b[key]));

		const missingInA = [...armsB].filter((arm) => !armsA.has(arm)).sort();
		const missingInB = [...armsA].filter((arm) => !armsB.has(arm)).sort();

		if (missingInA.length > 0 || missingInB.length > 0) {
			variantMismatches.push({ key, missingInA, missingInB });
		}
	}

	return {
		missingInA: [...keysB].filter((key) => !keysA.has(key)).sort(),
		missingInB: [...keysA].filter((key) => !keysB.has(key)).sort(),
		variantMismatches
	};
}
