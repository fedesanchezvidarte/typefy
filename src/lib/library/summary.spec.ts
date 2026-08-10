import { describe, expect, it } from 'vitest';
import { resolveSummary } from './summary.js';
import type { Json } from '$lib/database.types';

/**
 * `resolveSummary` is the ONE place `books.summary`'s raw `Json` becomes a `string | null`.
 * Half of these cases are therefore about malformed input: the acceptance rule is that a bad
 * row renders a screen without a summary panel, never a 500.
 */
describe('resolveSummary', () => {
	describe('the resolution rule — summary[locale] ?? summary.default ?? null', () => {
		it('prefers the locale key over the default', () => {
			const summary = { default: 'An English blurb', es: 'Una reseña en español' };
			expect(resolveSummary(summary, 'es')).toBe('Una reseña en español');
			expect(resolveSummary(summary, 'en')).toBe('An English blurb');
		});

		it('falls back to the default when the locale has no override', () => {
			// The `default` key exists precisely because Open Library's description has an
			// UNVERIFIED language — it is the fallback for every locale, not the English one.
			expect(resolveSummary({ default: 'Fallback' }, 'es')).toBe('Fallback');
			expect(resolveSummary({ default: 'Fallback' }, 'en')).toBe('Fallback');
		});

		it('uses a locale override even when there is no default at all', () => {
			expect(resolveSummary({ es: 'Solo español' }, 'es')).toBe('Solo español');
		});

		it('is null when the locale has no override and there is no default', () => {
			expect(resolveSummary({ es: 'Solo español' }, 'en')).toBeNull();
		});

		it('is null for the empty map — the column default, and a normal state', () => {
			expect(resolveSummary({}, 'en')).toBeNull();
		});
	});

	describe('absent values fall through rather than resolving', () => {
		it('treats an empty locale value as absent and uses the default', () => {
			expect(resolveSummary({ default: 'Fallback', es: '' }, 'es')).toBe('Fallback');
		});

		it('treats a whitespace-only locale value as absent and uses the default', () => {
			expect(resolveSummary({ default: 'Fallback', es: '   \n\t ' }, 'es')).toBe('Fallback');
		});

		it('treats a non-string locale value as absent and uses the default', () => {
			const summary = { default: 'Fallback', es: 42 } as unknown as Json;
			expect(resolveSummary(summary, 'es')).toBe('Fallback');
		});

		it('is null when both the locale value and the default are unusable', () => {
			const summary = { default: '  ', es: null } as unknown as Json;
			expect(resolveSummary(summary, 'es')).toBeNull();
		});

		it('trims the resolved summary so trailing ingest whitespace never reaches the UI', () => {
			expect(resolveSummary({ default: '  A blurb.\n' }, 'en')).toBe('A blurb.');
		});
	});

	describe('malformed rows resolve as absent and never throw', () => {
		it.each([
			['null', null],
			['a string', 'not a map'],
			['a number', 7],
			['a boolean', true],
			['an array', ['a', 'b']]
		])('returns null for %s', (_label, value) => {
			expect(() => resolveSummary(value as Json, 'en')).not.toThrow();
			expect(resolveSummary(value as Json, 'en')).toBeNull();
		});

		it('returns null for undefined, which `Json` admits inside an object', () => {
			expect(resolveSummary(undefined as unknown as Json, 'en')).toBeNull();
		});

		it('ignores unrelated keys rather than guessing at one', () => {
			const summary = { fr: 'Un résumé', de: 'Eine Zusammenfassung' } as unknown as Json;
			expect(resolveSummary(summary, 'en')).toBeNull();
		});
	});
});
