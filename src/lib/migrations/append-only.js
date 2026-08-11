/**
 * Pure classification of a `git diff --name-status` listing for
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
 * Classifies each line of a `git diff --name-status <base> -- <pathspec>`
 * listing. Only `A` (added) is allowed — every other status means a file
 * that existed at the base ref was touched.
 *
 * Renames and copies (`R###` / `C###`, two path columns) are reported
 * against their *source* path: from the base ref's point of view, that
 * source file has disappeared, which is exactly the "an applied migration
 * is gone" case this check exists to catch.
 *
 * @param {string} nameStatusOutput - raw stdout of `git diff --name-status`
 * @returns {MigrationOffense[]}
 */
export function classifyMigrationDiff(nameStatusOutput) {
	/** @type {MigrationOffense[]} */
	const offenses = [];

	for (const rawLine of nameStatusOutput.split('\n')) {
		const line = rawLine.trim();
		if (!line) continue;

		const [status, ...paths] = line.split('\t');
		if (!status || paths.length === 0) continue;

		if (status.startsWith('A')) continue; // new file at/after the base — always fine

		if (status.startsWith('R') || status.startsWith('C')) {
			offenses.push({ kind: 'renamed', path: paths[0] });
			continue;
		}

		const path = paths[0];
		if (status.startsWith('D')) {
			offenses.push({ kind: 'deleted', path });
		} else if (status.startsWith('M')) {
			offenses.push({ kind: 'modified', path });
		} else {
			// T (type change), U (unmerged), etc. — treat conservatively as a violation.
			offenses.push({ kind: 'changed', path });
		}
	}

	return offenses;
}
