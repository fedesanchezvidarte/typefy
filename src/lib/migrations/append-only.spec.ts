import { describe, expect, it } from 'vitest';
import { classifyMigrationDiff } from './append-only.js';

describe('classifyMigrationDiff', () => {
	it('returns no offenses for an empty diff', () => {
		expect(classifyMigrationDiff('')).toEqual([]);
		expect(classifyMigrationDiff('\n\n')).toEqual([]);
	});

	it('allows a newly added migration', () => {
		const diff = 'A\tsupabase/migrations/20260812000000_new_thing.sql';
		expect(classifyMigrationDiff(diff)).toEqual([]);
	});

	it('flags a modified migration', () => {
		const diff = 'M\tsupabase/migrations/20260722161957_create_books_and_chunks.sql';
		expect(classifyMigrationDiff(diff)).toEqual([
			{ kind: 'modified', path: 'supabase/migrations/20260722161957_create_books_and_chunks.sql' }
		]);
	});

	it('flags a deleted migration', () => {
		const diff = 'D\tsupabase/migrations/20260722162819_create_profiles.sql';
		expect(classifyMigrationDiff(diff)).toEqual([
			{ kind: 'deleted', path: 'supabase/migrations/20260722162819_create_profiles.sql' }
		]);
	});

	it('flags a renamed migration against its source path', () => {
		const diff =
			'R100\tsupabase/migrations/20260722162819_create_profiles.sql\tsupabase/migrations/20260722162819_create_profiles_v2.sql';
		expect(classifyMigrationDiff(diff)).toEqual([
			{ kind: 'renamed', path: 'supabase/migrations/20260722162819_create_profiles.sql' }
		]);
	});

	it('flags a copied migration against its source path', () => {
		const diff =
			'C100\tsupabase/migrations/20260722162819_create_profiles.sql\tsupabase/migrations/20260722162820_copy.sql';
		expect(classifyMigrationDiff(diff)).toEqual([
			{ kind: 'renamed', path: 'supabase/migrations/20260722162819_create_profiles.sql' }
		]);
	});

	it('conservatively flags a type change as a violation', () => {
		const diff = 'T\tsupabase/migrations/20260722161957_create_books_and_chunks.sql';
		expect(classifyMigrationDiff(diff)).toEqual([
			{ kind: 'changed', path: 'supabase/migrations/20260722161957_create_books_and_chunks.sql' }
		]);
	});

	it('reports multiple offenses in one diff, in order', () => {
		const diff = [
			'M\tsupabase/migrations/a.sql',
			'A\tsupabase/migrations/b.sql',
			'D\tsupabase/migrations/c.sql'
		].join('\n');
		expect(classifyMigrationDiff(diff)).toEqual([
			{ kind: 'modified', path: 'supabase/migrations/a.sql' },
			{ kind: 'deleted', path: 'supabase/migrations/c.sql' }
		]);
	});

	it('ignores blank lines interleaved with real entries', () => {
		const diff = '\nM\tsupabase/migrations/a.sql\n\n';
		expect(classifyMigrationDiff(diff)).toEqual([
			{ kind: 'modified', path: 'supabase/migrations/a.sql' }
		]);
	});
});
