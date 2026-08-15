import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * End-to-end coverage for the script wrapper: the pure classification is
 * tested in `src/lib/migrations/append-only.spec.ts`, but the decisions that
 * actually gate a merge live here — which git revisions get compared,
 * `--staged` vs working tree, and skip-vs-fail when the base ref is missing.
 *
 * The script resolves its repo root from its own location, so a fixture repo
 * has to reproduce the real layout: the script and the module it imports are
 * copied in at the same relative paths, and git runs inside the fixture.
 */

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const scriptRelativePath = 'scripts/check-migrations-append-only.js';
const libRelativePath = 'src/lib/migrations/append-only.js';
const migrationPath = 'supabase/migrations/20260101000000_create_books.sql';

let repo: string;

/** Runs git in the fixture repo, with an identity so commits succeed anywhere. */
function git(...args: string[]): string {
	return execFileSync('git', args, {
		cwd: repo,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'ignore']
	});
}

function write(relativePath: string, contents: string): void {
	const absolute = join(repo, relativePath);
	mkdirSync(dirname(absolute), { recursive: true });
	writeFileSync(absolute, contents);
}

/**
 * Runs the copied script. `spawnSync` rather than `execFileSync` because a
 * non-zero exit *is* the behavior under test, not a harness failure.
 *
 * `CI` is always set explicitly — inheriting the real one would flip the
 * skip-vs-fail branch depending on where the suite happens to run.
 */
function check(options: { args?: string[]; baseRef?: string; ci?: boolean } = {}) {
	const { args = [], baseRef = 'main', ci = false } = options;
	const result = spawnSync(process.execPath, [join(repo, scriptRelativePath), ...args], {
		cwd: repo,
		encoding: 'utf8',
		env: {
			...process.env,
			CI: ci ? 'true' : '',
			MIGRATIONS_APPEND_ONLY_BASE_REF: baseRef
		}
	});
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

beforeEach(() => {
	repo = mkdtempSync(join(tmpdir(), 'append-only-'));

	git('init', '--initial-branch=main');
	git('config', 'user.email', 'test@example.com');
	git('config', 'user.name', 'Test');
	// Rename detection must not depend on the developer's global git config.
	git('config', 'diff.renames', 'true');

	cpSync(join(projectRoot, scriptRelativePath), join(repo, scriptRelativePath), {
		recursive: false
	});
	mkdirSync(join(repo, dirname(libRelativePath)), { recursive: true });
	cpSync(join(projectRoot, libRelativePath), join(repo, libRelativePath));

	// The migration that is "already applied": present on `main`.
	write(migrationPath, 'create table books (id uuid primary key);\n');
	git('add', '.');
	git('commit', '--message', 'baseline with an applied migration');

	git('checkout', '--quiet', '-b', 'feature');
});

afterEach(() => {
	rmSync(repo, { recursive: true, force: true });
});

describe('check-migrations-append-only', () => {
	it('passes when the branch only adds a new migration', () => {
		write('supabase/migrations/20260202000000_add_chunks.sql', 'create table chunks ();\n');
		git('add', '.');
		git('commit', '--message', 'add a migration');

		const result = check();

		expect(result.status).toBe(0);
		expect(result.stdout).toContain('Append-only check OK');
	});

	it('passes when a migration added on this branch is edited again', () => {
		const added = 'supabase/migrations/20260202000000_add_chunks.sql';
		write(added, 'create table chunks ();\n');
		git('add', '.');
		git('commit', '--message', 'add a migration');

		write(added, 'create table chunks (id uuid primary key);\n');
		git('add', '.');
		git('commit', '--message', 'fix it before it ever reached main');

		expect(check().status).toBe(0);
	});

	it('fails when a migration already on the base ref is modified', () => {
		write(migrationPath, 'create table books (id uuid primary key, title text);\n');
		git('add', '.');
		git('commit', '--message', 'edit an applied migration');

		const result = check();

		expect(result.status).toBe(1);
		expect(result.stderr).toContain(`modified: ${migrationPath}`);
		expect(result.stderr).toContain('must be append-only');
	});

	it('fails when a migration already on the base ref is deleted', () => {
		git('rm', '--quiet', migrationPath);
		git('commit', '--message', 'delete an applied migration');

		const result = check();

		expect(result.status).toBe(1);
		expect(result.stderr).toContain(`deleted: ${migrationPath}`);
	});

	it('reports a rename against the path that existed on the base ref', () => {
		git('mv', migrationPath, 'supabase/migrations/20260101000000_create_books_v2.sql');
		git('commit', '--message', 'rename an applied migration');

		const result = check();

		expect(result.status).toBe(1);
		expect(result.stderr).toContain(`renamed: ${migrationPath}`);
	});

	it('ignores changes outside supabase/migrations', () => {
		write('src/lib/whatever.ts', 'export const value = 1;\n');
		git('add', '.');
		git('commit', '--message', 'unrelated change');

		expect(check().status).toBe(0);
	});

	describe('--staged', () => {
		it('fails on a staged edit to an applied migration', () => {
			write(migrationPath, 'create table books (id uuid primary key, title text);\n');
			git('add', '.');

			const result = check({ args: ['--staged'] });

			expect(result.status).toBe(1);
			expect(result.stderr).toContain(`modified: ${migrationPath}`);
			expect(result.stderr).toContain('staged changes');
		});

		it('ignores an unstaged edit that is not part of the commit', () => {
			write(migrationPath, 'create table books (id uuid primary key, title text);\n');

			expect(check({ args: ['--staged'] }).status).toBe(0);
			// ...which the working-tree comparison does still report.
			expect(check().status).toBe(1);
		});
	});

	describe('missing base ref', () => {
		it('skips with a warning locally', () => {
			const result = check({ baseRef: 'origin/does-not-exist' });

			expect(result.status).toBe(0);
			expect(result.stderr).toContain('skipping the append-only check');
		});

		it('fails in CI rather than reporting a green no-op', () => {
			const result = check({ baseRef: 'origin/does-not-exist', ci: true });

			expect(result.status).toBe(1);
			expect(result.stderr).toContain('cannot run in CI');
			expect(result.stderr).toContain('fetch-depth: 0');
		});
	});
});
