/**
 * Pure classification of a `git diff --name-status -z` listing for
 * `supabase/migrations/`, used to enforce that a migration file already
 * merged to `main` is never modified or deleted — only appended to.
 *
 * Why this exists: an applied migration is a fact recorded in
 * `supabase_migrations.schema_migrations` on each database, keyed by
 * filename. Editing the file after the fact does not re-run it — the
 * database that already applied it never notices the edit, and it silently
 * diverges from a fresh replay (see issue #35: an edited-after-merge
 * migration file left hosted permanently missing a row that local, replaying
 * from scratch, picked up). Corrections belong in a new migration file.
 *
 * Kept as plain ESM JavaScript, like `src/lib/i18n/parity.js`, so
 * `scripts/check-migrations-append-only.js` can import it directly under
 * Node with no build step.
 */

/**
 * @typedef {object} MigrationOffense
 * @property {'modified' | 'deleted' | 'renamed' | 'changed'} kind
 * @property {string} path - path of the file as it exists at the base ref
 */

/**
 * Classifies the records of a `git diff --name-status -z <base> -- <pathspec>`
 * listing. Only additions are allowed — every other status means a file that
 * existed at the base ref was touched.
 *
 * `-z` (NUL-separated) rather than the default line/tab format: git quotes
 * paths containing tabs, newlines or non-ASCII bytes (`core.quotePath`), which
 * silently corrupts tab-splitting. NUL separators have no escaping at all, so
 * the parse is exact for any path git can produce.
 *
 * The output is a flat token stream — `status NUL path NUL` per record, except
 * `R###`/`C###`, which carry both a source and a destination path
 * (`status NUL src NUL dst NUL`). Statuses are consumed sequentially, taking
 * one or two paths depending on the status.
 *
 * Per status:
 * - `A` — new file at/after the base. Allowed.
 * - `C` — a copy: the destination is new and the *source is left intact*, so
 *   nothing that already reached the base ref changed. Allowed. (Copy
 *   detection is off unless `diff.renames=copies` is configured, so this is
 *   rare — but treating it as a deletion would be a false positive.)
 * - `R` — a rename: the source path is gone from the base ref's point of view,
 *   which is exactly the "an applied migration disappeared" case. Reported
 *   against the *source* path.
 * - `D` / `M` — reported as-is.
 * - anything else (`T` type change, `U` unmerged, `X`) — reported
 *   conservatively as a violation rather than ignored.
 *
 * @param {string} nameStatusOutput - raw stdout of `git diff --name-status -z`
 * @returns {MigrationOffense[]}
 */
export function classifyMigrationDiff(nameStatusOutput) {
	/** @type {MigrationOffense[]} */
	const offenses = [];

	// A trailing NUL leaves an empty final token; blank tokens are dropped
	// rather than treated as records.
	const tokens = nameStatusOutput.split('\0').filter((token) => token !== '');

	let index = 0;
	while (index < tokens.length) {
		const status = tokens[index++];
		const takesTwoPaths = status.startsWith('R') || status.startsWith('C');

		const source = tokens[index++];
		const destination = takesTwoPaths ? tokens[index++] : undefined;

		// Truncated trailing record (interrupted git, hand-built input): nothing
		// to classify against, so there is no path to report.
		if (source === undefined) break;
		if (takesTwoPaths && destination === undefined) break;

		if (status.startsWith('A') || status.startsWith('C')) continue;

		if (status.startsWith('R')) {
			offenses.push({ kind: 'renamed', path: source });
		} else if (status.startsWith('D')) {
			offenses.push({ kind: 'deleted', path: source });
		} else if (status.startsWith('M')) {
			offenses.push({ kind: 'modified', path: source });
		} else {
			offenses.push({ kind: 'changed', path: source });
		}
	}

	return offenses;
}
