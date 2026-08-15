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
 * offline stand-in: **merged to `main` = applied.** Compare against the
 * merge-base with `origin/main` and fail on any migration file that exists
 * there and was modified, deleted, or renamed away. A migration added on the
 * current branch — absent at the merge-base — stays freely editable; that is
 * exactly the case #35 was *not* (the edited file already existed on `main`).
 *
 * The verdict is only as fresh as the local `origin/main`: a migration merged
 * to `main` since the last fetch is absent from the merge-base and therefore
 * still looks editable. CI, which always fetches, is the backstop.
 *
 * Deliberate bypass, visible in history rather than baked into a silent
 * flag: `git commit --no-verify` locally, or editing the CI step.
 *
 * Usage: node scripts/check-migrations-append-only.js [--staged]
 *   --staged  Compare the *index* against the base instead of the working
 *             tree — what a pre-commit hook must check, since only staged
 *             content is about to be committed.
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
const stagedOnly = process.argv.includes('--staged');

/**
 * `stderr: 'ignore'` so git's own diagnostics stay out of the output — the ref
 * and merge-base probes below are expected to fail on a fresh clone, and the
 * messages this script prints instead say what to do about it.
 *
 * @param {string[]} args
 * @returns {string}
 */
function git(args) {
	return execFileSync('git', args, {
		cwd: repoRoot,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'ignore']
	});
}

/**
 * Bails out when the base ref is unusable. Locally that is a soft skip — a
 * fresh clone or a fork without `origin/main` should not block a commit. In
 * CI it is a hard failure: a silently-skipped gate that reports green is the
 * same shape of invisible drift as #35 itself.
 *
 * @param {string} message
 * @returns {never}
 */
function skip(message) {
	if (process.env.CI) {
		console.error(
			`[migrations] ${message} — the append-only check cannot run in CI, failing instead of ` +
				'passing silently. Ensure the checkout has full history (`fetch-depth: 0`) and an ' +
				`"${baseRef}" ref.`
		);
		process.exit(1);
	}
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

let mergeBase;
try {
	mergeBase = git(['merge-base', 'HEAD', baseRef]).trim();
} catch {
	skip(
		`could not compute a merge-base between HEAD and "${baseRef}" (unrelated or shallow history)`
	);
}

let diffOutput;
try {
	diffOutput = git([
		'diff',
		'--name-status',
		'-z',
		// Explicit so the result does not depend on the user's `diff.renames`
		// config: a rename must surface as `R` (reported against its source),
		// not as an unrelated add/delete pair.
		'--find-renames',
		...(stagedOnly ? ['--cached'] : []),
		mergeBase,
		'--',
		migrationsPathspec
	]);
} catch (err) {
	console.error(
		`[migrations] failed to diff against ${mergeBase}: ${/** @type {Error} */ (err).message}`
	);
	process.exit(1);
}

const offenses = classifyMigrationDiff(diffOutput);
const scope = stagedOnly ? 'staged changes' : 'working tree';

if (offenses.length === 0) {
	console.log(
		`[migrations] Append-only check OK — no migration already on ${baseRef} was touched (${scope}).`
	);
	process.exit(0);
}

console.error(
	`[migrations] Applied migrations must be append-only. The following files already exist on ` +
		`${baseRef} and were changed on this branch (${scope}):\n`
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
