import { describe, expect, it } from 'vitest';
import { classifyMigrationDiff } from './append-only.js';

/**
 * Builds a `git diff --name-status -z` payload: every field is NUL-terminated,
 * including the last one.
 */
const nameStatusZ = (...fields: string[]) => fields.map((field) => `${field}\0`).join('');

describe('classifyMigrationDiff', () => {
	it('returns no offenses for an empty diff', () => {
		expect(classifyMigrationDiff('')).toEqual([]);
		expect(classifyMigrationDiff('\0\0')).toEqual([]);
	});

	it('allows a newly added migration', () => {
		const diff = nameStatusZ('A', 'supabase/migrations/20260812000000_new_thing.sql');
		expect(classifyMigrationDiff(diff)).toEqual([]);
	});

	it('flags a modified migration', () => {
		const diff = nameStatusZ('M', 'supabase/migrations/20260722161957_create_books_and_chunks.sql');
		expect(classifyMigrationDiff(diff)).toEqual([
			{ kind: 'modified', path: 'supabase/migrations/20260722161957_create_books_and_chunks.sql' }
		]);
	});

	it('flags a deleted migration', () => {
		const diff = nameStatusZ('D', 'supabase/migrations/20260722162819_create_profiles.sql');
		expect(classifyMigrationDiff(diff)).toEqual([
			{ kind: 'deleted', path: 'supabase/migrations/20260722162819_create_profiles.sql' }
		]);
	});

	it('flags a renamed migration against its source path', () => {
		const diff = nameStatusZ(
			'R100',
			'supabase/migrations/20260722162819_create_profiles.sql',
			'supabase/migrations/20260722162819_create_profiles_v2.sql'
		);
		expect(classifyMigrationDiff(diff)).toEqual([
			{ kind: 'renamed', path: 'supabase/migrations/20260722162819_create_profiles.sql' }
		]);
	});

	it('allows a copied migration, whose source is left intact', () => {
		const diff = nameStatusZ(
			'C100',
			'supabase/migrations/20260722162819_create_profiles.sql',
			'supabase/migrations/20260722162820_copy.sql'
		);
		expect(classifyMigrationDiff(diff)).toEqual([]);
	});

	it('conservatively flags a type change as a violation', () => {
		const diff = nameStatusZ('T', 'supabase/migrations/20260722161957_create_books_and_chunks.sql');
		expect(classifyMigrationDiff(diff)).toEqual([
			{ kind: 'changed', path: 'supabase/migrations/20260722161957_create_books_and_chunks.sql' }
		]);
	});

	it('reports multiple offenses in one diff, in order', () => {
		const diff = nameStatusZ(
			'M',
			'supabase/migrations/a.sql',
			'A',
			'supabase/migrations/b.sql',
			'D',
			'supabase/migrations/c.sql'
		);
		expect(classifyMigrationDiff(diff)).toEqual([
			{ kind: 'modified', path: 'supabase/migrations/a.sql' },
			{ kind: 'deleted', path: 'supabase/migrations/c.sql' }
		]);
	});

	it('keeps its place in the token stream after a two-path record', () => {
		const diff = nameStatusZ(
			'R100',
			'supabase/migrations/a.sql',
			'supabase/migrations/a_renamed.sql',
			'M',
			'supabase/migrations/b.sql'
		);
		expect(classifyMigrationDiff(diff)).toEqual([
			{ kind: 'renamed', path: 'supabase/migrations/a.sql' },
			{ kind: 'modified', path: 'supabase/migrations/b.sql' }
		]);
	});

	it('preserves paths that the line/tab format would have quoted or split', () => {
		const awkwardPath = 'supabase/migrations/20260812000000_añadir\ttabulación.sql';
		const diff = nameStatusZ('M', awkwardPath);
		expect(classifyMigrationDiff(diff)).toEqual([{ kind: 'modified', path: awkwardPath }]);
	});

	it('ignores a truncated trailing record rather than inventing a path', () => {
		const diff = nameStatusZ('M', 'supabase/migrations/a.sql') + 'D\0';
		expect(classifyMigrationDiff(diff)).toEqual([
			{ kind: 'modified', path: 'supabase/migrations/a.sql' }
		]);
	});
});
