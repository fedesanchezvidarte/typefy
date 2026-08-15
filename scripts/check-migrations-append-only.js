#!/usr/bin/env node
/**
 * CI + pre-commit gate: an applied migration is append-only. Corrections go
 * in a new file — editing or deleting a migration file that already reached
 * `main` is exactly how #35 happened (hosted had recorded the old version as
 * applied and never replayed the edit; local, replaying from scratch, got a
 * different result). Nothing surfaced the drift until someone went looking.
 *
 * "Already applied" is not knowable from the working tree alone — it is
 * state in `supabase_migrations.schema_migrations` on each database, and
 * this check must run with no database connection and no credentials. The
 * offline stand-in: **merged to `main` = applied.** Compare the working tree
 * against the merge-base with `origin/main` and fail on any migration file
 * that exists there and was modified, deleted, or renamed away. A migration
 * added on the current branch — absent at the merge-base — stays freely
 * editable; that is exactly the case #35 was *not* (the edited file already
 * existed on `main`).
 *
 * Deliberate bypass, visible in history rather than baked into a silent
 * flag: `git commit --no-verify` locally, or editing the CI step.
 *
 * Usage: node scripts/check-migrations-append-only.js
 * Override the base ref (e.g. for a fork without an `origin` remote) with
 * MIGRATIONS_APPEND_ONLY_BASE_REF.
 */
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyMigrationDiff } from '../src/lib/migrations/append-only.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsPathspec = 'supabase/migrations';
const baseRef = process.env.MIGRATIONS_APPEND_ONLY_BASE_REF || 'origin/main';

/** @param {string[]} args @returns {string} */
function git(args) {
	return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

/** @param {string} message */
function skip(message) {
	console.warn(`[migrations] ${message} — skipping the append-only check.`);
	process.exit(0);
}

try {
	git(['rev-parse', '--verify', '--quiet', baseRef]);
} catch {
	skip(
		`base ref "${baseRef}" was not found locally (run \`git fetch origin main\` to enable this check)`
	);
}

/** @type {string} */
let mergeBase;
try {
	mergeBase = git(['merge-base', 'HEAD', baseRef]);
} catch {
	skip(
		`could not compute a merge-base between HEAD and "${baseRef}" (unrelated or shallow history)`
	);
}

/** @type {string} */
let diffOutput;
try {
	diffOutput = git(['diff', '--name-status', mergeBase, '--', migrationsPathspec]);
} catch (err) {
	console.error(
		`[migrations] failed to diff against ${mergeBase}: ${/** @type {Error} */ (err).message}`
	);
	process.exit(1);
}

const offenses = classifyMigrationDiff(diffOutput);

if (offenses.length === 0) {
	console.log('[migrations] Append-only check OK — no migration already on main was touched.');
	process.exit(0);
}

console.error(
	'[migrations] Applied migrations must be append-only. The following files already exist on ' +
		`${baseRef} and were changed on this branch:\n`
);
for (const { kind, path } of offenses) {
	console.error(`  ${kind}: ${path}`);
}
console.error(
	'\nWrite a new migration instead of editing one that already reached main: ' +
		'`supabase migration new <name>` (see .claude/skills/supabase/SKILL.md).\n' +
		'(Deliberate bypass: `git commit --no-verify`, or edit the CI step in .github/workflows/ci.yml — both visible in history.)'
);
process.exit(1);
