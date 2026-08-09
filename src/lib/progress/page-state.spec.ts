import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AttemptStorage } from './buffer';
import {
	PAGE_STATE_CAP,
	PAGE_STATE_KEY,
	PAGE_STATE_TTL_MS,
	clearPageState,
	readPageState,
	resolvedPrefixLength,
	savePageState,
	type PageState
} from './page-state';
import { ATTEMPT_BUFFER_KEY } from './buffer';

/**
 * In-page restore storage (spec #32 §8, TDD per ADR-0009). The storage port is faked in
 * memory — a unit test never touches `localStorage`, which only `storage.ts` may name.
 */

const NOW = 1_700_000_000_000;

function fakeStorage(initial: string | null = null) {
	let value = initial;
	return {
		read: () => value,
		write: (next: string) => {
			value = next;
		},
		clear: () => {
			value = null;
		},
		get stored() {
			return value;
		}
	};
}

function throwingReadStorage(): AttemptStorage {
	return {
		read: () => {
			throw new Error('SecurityError');
		},
		write: () => {},
		clear: () => {}
	};
}

function quotaStorage(initial: string | null = null) {
	let value = initial;
	let cleared = false;
	return {
		read: () => value,
		write: () => {
			throw new Error('QuotaExceededError');
		},
		clear: () => {
			value = null;
			cleared = true;
		},
		get cleared() {
			return cleared;
		}
	};
}

const entry = (over: Partial<PageState> = {}): PageState => ({
	bookId: 'book-1',
	chunkId: 'chunk-7',
	index: 7,
	prefixLength: 120,
	savedTextLength: 1400,
	savedAt: NOW,
	...over
});

const query = (over: Partial<PageState> = {}) => {
	const e = entry(over);
	return { bookId: e.bookId, chunkId: e.chunkId, index: e.index, textLength: e.savedTextLength };
};

describe('the key', () => {
	/*
	 * Its OWN key, deliberately not the attempt buffer's. The buffer holds completed attempts
	 * destined for the server and sitting in the drain's path; this holds one UNCOMPLETED page
	 * destined for nobody. Sharing the slot would put a never-sendable entry in front of the
	 * drain.
	 */
	it('is versioned and distinct from the attempt buffer', () => {
		expect(PAGE_STATE_KEY).toBe('typefy:page-state:v1');
		expect(PAGE_STATE_KEY).not.toBe(ATTEMPT_BUFFER_KEY);
	});

	it('expires after 30 days, matching the attempt buffer', () => {
		expect(PAGE_STATE_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
	});
});

describe('resolvedPrefixLength', () => {
	/*
	 * Only the longest correct-or-corrected prefix is restorable. A prefix containing an
	 * unresolved `incorrect` character cannot be restored as "already correct" without lying,
	 * and a `pending` one is simply where the typing stopped.
	 */
	it('counts a fully correct prefix', () => {
		expect(resolvedPrefixLength(['correct', 'correct', 'pending', 'pending'])).toBe(2);
	});

	it('counts a corrected character as resolved — it renders like correct and is correct', () => {
		expect(resolvedPrefixLength(['correct', 'corrected', 'pending'])).toBe(2);
	});

	it('truncates at the first incorrect character, even with correct characters past it', () => {
		expect(resolvedPrefixLength(['correct', 'incorrect', 'correct', 'correct'])).toBe(1);
	});

	it('truncates at the first pending character, even with correct characters past it', () => {
		expect(resolvedPrefixLength(['correct', 'pending', 'correct'])).toBe(1);
	});

	it('is 0 when nothing has been resolved yet', () => {
		expect(resolvedPrefixLength(['pending', 'pending'])).toBe(0);
		expect(resolvedPrefixLength([])).toBe(0);
	});

	it('is the whole length for a completed page', () => {
		expect(resolvedPrefixLength(['correct', 'corrected', 'correct'])).toBe(3);
	});
});

describe('savePageState / readPageState', () => {
	it('returns the saved page for the same book, index, chunk id and text length', () => {
		const storage = fakeStorage();
		savePageState(storage, entry(), NOW);
		expect(readPageState(storage, query(), NOW)).toEqual(entry());
	});

	it('stores the prefix LENGTH, never the typed text — the chunk content is authoritative', () => {
		const storage = fakeStorage();
		savePageState(storage, entry(), NOW);
		const parsed = JSON.parse(storage.stored ?? '[]');
		for (const record of parsed) {
			expect(Object.keys(record).sort()).toEqual(
				['bookId', 'chunkId', 'index', 'prefixLength', 'savedAt', 'savedTextLength'].sort()
			);
		}
		expect(storage.stored).toContain('prefixLength');
	});

	it('keeps one entry per page, so re-saving the same page overwrites rather than accumulates', () => {
		const storage = fakeStorage();
		savePageState(storage, entry({ prefixLength: 10 }), NOW);
		savePageState(storage, entry({ prefixLength: 200, savedAt: NOW + 1000 }), NOW + 1000);
		expect(readPageState(storage, query(), NOW + 1000)?.prefixLength).toBe(200);
		expect(JSON.parse(storage.stored!)).toHaveLength(1);
	});

	it('keeps pages of different indices in the same book apart', () => {
		const storage = fakeStorage();
		savePageState(storage, entry({ index: 7, prefixLength: 10 }), NOW);
		savePageState(storage, entry({ index: 8, chunkId: 'chunk-8', prefixLength: 20 }), NOW);
		expect(readPageState(storage, query({ index: 7 }), NOW)?.prefixLength).toBe(10);
		expect(readPageState(storage, query({ index: 8, chunkId: 'chunk-8' }), NOW)?.prefixLength).toBe(
			20
		);
	});

	it('returns null for a page that was never saved', () => {
		expect(readPageState(fakeStorage(), query(), NOW)).toBeNull();
	});

	/*
	 * The invalidation guard (spec #32 §8). A re-ingest replaces content under a STABLE chunk
	 * id, so an id match alone proves nothing: the saved prefix would restore a stretch of text
	 * that is no longer there. A length mismatch is enough to discard it, silently.
	 */
	it('discards a saved page whose chunk is now a different length', () => {
		const storage = fakeStorage();
		savePageState(storage, entry(), NOW);
		expect(readPageState(storage, { ...query(), textLength: 1399 }, NOW)).toBeNull();
	});

	it('discards a saved page whose chunk id no longer matches the index', () => {
		const storage = fakeStorage();
		savePageState(storage, entry(), NOW);
		expect(readPageState(storage, { ...query(), chunkId: 'chunk-other' }, NOW)).toBeNull();
	});

	it('discards a saved page older than the TTL', () => {
		const storage = fakeStorage();
		savePageState(storage, entry(), NOW);
		expect(readPageState(storage, query(), NOW + PAGE_STATE_TTL_MS + 1)).toBeNull();
	});

	it('saves nothing at all when no character has been resolved yet', () => {
		const storage = fakeStorage();
		savePageState(storage, entry({ prefixLength: 0 }), NOW);
		expect(readPageState(storage, query(), NOW)).toBeNull();
	});

	it('removes an existing entry when the page is re-saved with nothing resolved', () => {
		// Backspacing to the start of the page must not leave yesterday's longer prefix behind.
		const storage = fakeStorage();
		savePageState(storage, entry({ prefixLength: 120 }), NOW);
		savePageState(storage, entry({ prefixLength: 0, savedAt: NOW + 10 }), NOW + 10);
		expect(readPageState(storage, query(), NOW + 10)).toBeNull();
	});

	it('evicts the oldest page once the cap is reached', () => {
		const storage = fakeStorage();
		for (let i = 0; i <= PAGE_STATE_CAP; i += 1) {
			savePageState(storage, entry({ index: i, chunkId: `chunk-${i}`, savedAt: NOW + i }), NOW + i);
		}
		expect(JSON.parse(storage.stored!)).toHaveLength(PAGE_STATE_CAP);
		expect(readPageState(storage, query({ index: 0, chunkId: 'chunk-0' }), NOW)).toBeNull();
		expect(
			readPageState(
				storage,
				query({ index: PAGE_STATE_CAP, chunkId: `chunk-${PAGE_STATE_CAP}` }),
				NOW
			)
		).not.toBeNull();
	});
});

describe('clearPageState', () => {
	it('removes exactly the page named and leaves the others alone', () => {
		const storage = fakeStorage();
		savePageState(storage, entry({ index: 7 }), NOW);
		savePageState(storage, entry({ index: 8, chunkId: 'chunk-8' }), NOW);
		clearPageState(storage, { bookId: 'book-1', index: 7 }, NOW);
		expect(readPageState(storage, query({ index: 7 }), NOW)).toBeNull();
		expect(readPageState(storage, query({ index: 8, chunkId: 'chunk-8' }), NOW)).not.toBeNull();
	});

	it('is a no-op for a page that was never saved', () => {
		const storage = fakeStorage();
		expect(() => clearPageState(storage, { bookId: 'book-1', index: 3 }, NOW)).not.toThrow();
	});
});

/*
 * Total and silent, exactly as the attempt buffer is: a storage failure must never interrupt
 * typing. Every one of these reads as "there is no saved page" rather than as an exception.
 */
describe('totality', () => {
	it('treats a null storage port (SSR, private mode) as no saved page', () => {
		expect(readPageState(null, query(), NOW)).toBeNull();
		expect(() => savePageState(null, entry(), NOW)).not.toThrow();
		expect(() => clearPageState(null, { bookId: 'b', index: 1 }, NOW)).not.toThrow();
	});

	it('treats a storage whose read throws as no saved page', () => {
		expect(readPageState(throwingReadStorage(), query(), NOW)).toBeNull();
	});

	it('treats unparseable JSON as no saved page and drops the key', () => {
		const storage = fakeStorage('{not json');
		expect(readPageState(storage, query(), NOW)).toBeNull();
		expect(storage.stored).toBeNull();
	});

	it('treats a stored value that is not an array as no saved page', () => {
		const storage = fakeStorage('{"bookId":"book-1"}');
		expect(readPageState(storage, query(), NOW)).toBeNull();
	});

	it('drops a wrong-shaped entry and keeps the well-formed one beside it', () => {
		const storage = fakeStorage(JSON.stringify([{ bookId: 'book-1', index: 'seven' }, entry()]));
		expect(readPageState(storage, query(), NOW)).toEqual(entry());
	});

	it('clears the key rather than leaving a stale value when the write is refused', () => {
		const storage = quotaStorage();
		savePageState(storage, entry(), NOW);
		expect(storage.cleared).toBe(true);
	});
});

describe('module purity (lib-patterns tier 1, asserted rather than conventional)', () => {
	const raw = readFileSync(fileURLToPath(new URL('./page-state.ts', import.meta.url)), 'utf8');
	const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

	it('names no browser global — storage is reached only through the injected port', () => {
		expect(code).not.toMatch(/\b(localStorage|sessionStorage|window|document|navigator)\b/);
	});

	it('imports nothing from @supabase/* — a half-typed page is never a database row', () => {
		expect(code).not.toMatch(/@supabase\//);
	});

	it('reads no ambient clock — `now` is injected on every operation', () => {
		expect(code).not.toMatch(/Date\.now\(\)/);
	});
});
