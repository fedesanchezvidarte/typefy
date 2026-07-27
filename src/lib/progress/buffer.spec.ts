import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	ATTEMPT_BUFFER_CAP,
	ATTEMPT_BUFFER_KEY,
	ATTEMPT_BUFFER_TTL_MS,
	dropForUser,
	enqueue,
	readAll,
	remove,
	type AttemptStorage,
	type BufferedChunkAttempt
} from './buffer';

/**
 * Attempt-buffer tests (spec #15 §2, TDD per ADR-0009). The storage port is faked in
 * memory — a unit test never touches `localStorage` (that binding lives in `storage.ts`,
 * which is the only module allowed to name it).
 */

/** The in-memory `AttemptStorage` the Brief promises is "three lines". */
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
		/** Test-only window onto the stored string. */
		get stored() {
			return value;
		}
	};
}

/** A storage whose `read` throws — a `SecurityError` in the real binding. */
function throwingReadStorage(): AttemptStorage {
	return {
		read: () => {
			throw new Error('SecurityError');
		},
		write: () => {},
		clear: () => {}
	};
}

/** A storage whose `write` throws — the quota error. */
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

const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';

function entry(over: Partial<BufferedChunkAttempt> = {}): BufferedChunkAttempt {
	return {
		userId: null,
		chunkId: '33333333-3333-3333-3333-333333333333',
		bookId: '44444444-4444-4444-4444-444444444444',
		completed: true,
		grossWpm: 61.4321,
		accuracyRaw: 0.9737,
		elapsedMs: 42_124,
		startedAt: 1_700_000_000_000,
		bufferedAt: 1_700_000_000_000,
		...over
	};
}

const NOW = 1_700_000_100_000;

/** A `bufferedAt` `offset` ms into a recent window — inside the TTL, ordered by offset. */
function T(offset: number): number {
	return NOW - 10_000 + offset;
}

function seed(entries: BufferedChunkAttempt[]) {
	return fakeStorage(JSON.stringify(entries));
}

describe('attempt buffer constants', () => {
	it('exposes a versioned storage key so a shape change abandons old data instead of migrating it', () => {
		expect(ATTEMPT_BUFFER_KEY).toMatch(/:v1$/);
	});

	it('exposes the cap as a named constant — the sign-in prompt clamps its count against it', () => {
		expect(ATTEMPT_BUFFER_CAP).toBe(50);
	});

	it('exposes a 30-day TTL', () => {
		expect(ATTEMPT_BUFFER_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
	});
});

describe('readAll', () => {
	it('returns the stored entries oldest first by bufferedAt', () => {
		const storage = seed([
			entry({ chunkId: 'c3', bufferedAt: T(300) }),
			entry({ chunkId: 'c1', bufferedAt: T(100) }),
			entry({ chunkId: 'c2', bufferedAt: T(200) })
		]);

		expect(readAll(storage, NOW).map((e) => e.chunkId)).toEqual(['c1', 'c2', 'c3']);
	});

	it('reads an absent storage binding as an empty buffer', () => {
		expect(readAll(null, NOW)).toEqual([]);
	});

	it('reads an empty key as an empty buffer', () => {
		expect(readAll(fakeStorage(null), NOW)).toEqual([]);
	});

	it('reads malformed JSON as an empty buffer and clears the key', () => {
		const storage = fakeStorage('{not json');

		expect(readAll(storage, NOW)).toEqual([]);
		expect(storage.stored).toBeNull();
	});

	it('reads a non-array payload as an empty buffer and clears the key', () => {
		const storage = fakeStorage(JSON.stringify({ chunkId: 'c1' }));

		expect(readAll(storage, NOW)).toEqual([]);
		expect(storage.stored).toBeNull();
	});

	it('never throws when the storage binding itself throws on read', () => {
		expect(() => readAll(throwingReadStorage(), NOW)).not.toThrow();
		expect(readAll(throwingReadStorage(), NOW)).toEqual([]);
	});

	it('drops wrong-shaped elements and keeps the valid ones — JSON.parse is not trusted', () => {
		const storage = seed([
			entry({ chunkId: 'good', bufferedAt: T(100) }),
			{ chunkId: 'no-metrics' } as unknown as BufferedChunkAttempt,
			{ ...entry({ chunkId: 'wrong-types' }), grossWpm: 'fast' } as unknown as BufferedChunkAttempt,
			{ ...entry({ chunkId: 'bad-user' }), userId: 42 } as unknown as BufferedChunkAttempt,
			null as unknown as BufferedChunkAttempt
		]);

		expect(readAll(storage, NOW).map((e) => e.chunkId)).toEqual(['good']);
	});

	it('persists the pruned list, so a repaired read is not re-repaired forever', () => {
		const storage = seed([
			entry({ chunkId: 'good', bufferedAt: T(100) }),
			null as unknown as BufferedChunkAttempt
		]);

		readAll(storage, NOW);

		expect(JSON.parse(storage.stored as string)).toHaveLength(1);
	});

	it('does not rewrite the key when nothing needed pruning', () => {
		const original = JSON.stringify([entry({ bufferedAt: T(100) })]);
		const storage = fakeStorage(original);

		readAll(storage, NOW);

		expect(storage.stored).toBe(original);
	});

	it('does not return entries older than the 30-day TTL', () => {
		const storage = seed([
			entry({ chunkId: 'expired', bufferedAt: NOW - ATTEMPT_BUFFER_TTL_MS - 1 }),
			entry({ chunkId: 'fresh', bufferedAt: NOW - 1000 })
		]);

		expect(readAll(storage, NOW).map((e) => e.chunkId)).toEqual(['fresh']);
	});

	it('drops TTL-expired entries from storage, not just from the result', () => {
		const storage = seed([
			entry({ chunkId: 'expired', bufferedAt: NOW - ATTEMPT_BUFFER_TTL_MS - 1 })
		]);

		readAll(storage, NOW);

		expect(JSON.parse(storage.stored as string)).toEqual([]);
	});

	it('keeps an entry exactly at the TTL boundary', () => {
		const storage = seed([entry({ chunkId: 'edge', bufferedAt: NOW - ATTEMPT_BUFFER_TTL_MS })]);

		expect(readAll(storage, NOW)).toHaveLength(1);
	});
});

describe('enqueue', () => {
	it('appends an entry to an empty buffer', () => {
		const storage = fakeStorage(null);

		enqueue(storage, entry({ chunkId: 'c1' }), NOW);

		expect(readAll(storage, NOW).map((e) => e.chunkId)).toEqual(['c1']);
	});

	it('preserves every field of a guest-authored entry, userId null included', () => {
		const storage = fakeStorage(null);
		const guest = entry({ userId: null });

		enqueue(storage, guest, NOW);

		expect(readAll(storage, NOW)[0]).toEqual(guest);
	});

	it('never exceeds the cap and evicts oldest-first by bufferedAt', () => {
		const storage = fakeStorage(null);

		for (let i = 0; i < ATTEMPT_BUFFER_CAP + 5; i += 1) {
			enqueue(storage, entry({ chunkId: `c${i}`, bufferedAt: T(1_000 + i) }), NOW);
		}

		const kept = readAll(storage, NOW);
		expect(kept).toHaveLength(ATTEMPT_BUFFER_CAP);
		expect(kept[0].chunkId).toBe('c5');
		expect(kept.at(-1)?.chunkId).toBe(`c${ATTEMPT_BUFFER_CAP + 4}`);
	});

	it('evicts by bufferedAt rather than by insertion order', () => {
		const storage = seed(
			Array.from({ length: ATTEMPT_BUFFER_CAP }, (_, i) =>
				entry({ chunkId: `c${i}`, bufferedAt: T(2_000 + i) })
			)
		);

		// An entry buffered BEFORE everything already stored: it is the oldest, so it is
		// the one evicted, and the buffer is unchanged.
		enqueue(storage, entry({ chunkId: 'ancient', bufferedAt: T(1) }), NOW);

		const kept = readAll(storage, NOW);
		expect(kept).toHaveLength(ATTEMPT_BUFFER_CAP);
		expect(kept.map((e) => e.chunkId)).not.toContain('ancient');
	});

	it('is a silent no-op when the storage binding is absent', () => {
		expect(() => enqueue(null, entry(), NOW)).not.toThrow();
	});

	it('never throws on a quota error, and clears the key so the buffer stays coherent', () => {
		const storage = quotaStorage(JSON.stringify([entry({ bufferedAt: T(100) })]));

		expect(() => enqueue(storage, entry({ chunkId: 'new' }), NOW)).not.toThrow();
		expect(storage.cleared).toBe(true);
		expect(readAll(storage, NOW)).toEqual([]);
	});

	it('drops TTL-expired entries while enqueuing', () => {
		const storage = seed([
			entry({ chunkId: 'expired', bufferedAt: NOW - ATTEMPT_BUFFER_TTL_MS - 1 })
		]);

		enqueue(storage, entry({ chunkId: 'fresh', bufferedAt: NOW }), NOW);

		expect(readAll(storage, NOW).map((e) => e.chunkId)).toEqual(['fresh']);
	});
});

describe('remove', () => {
	it('removes by value identity (userId, chunkId, startedAt) — the drain round-trips through JSON', () => {
		const kept = entry({ chunkId: 'keep', bufferedAt: T(200) });
		const storage = seed([entry({ chunkId: 'drop', bufferedAt: T(100) }), kept]);

		// A structurally equal COPY, not the same object reference.
		remove(storage, { ...entry({ chunkId: 'drop', bufferedAt: T(100) }) }, NOW);

		expect(readAll(storage, NOW)).toEqual([kept]);
	});

	it('distinguishes a guest-authored entry from a signed-in-authored one at the same chunk', () => {
		const guest = entry({ userId: null, chunkId: 'c1', startedAt: 500, bufferedAt: T(100) });
		const owned = entry({ userId: USER_A, chunkId: 'c1', startedAt: 500, bufferedAt: T(200) });
		const storage = seed([guest, owned]);

		remove(storage, guest, NOW);

		expect(readAll(storage, NOW)).toEqual([owned]);
	});

	it('distinguishes two attempts at the same chunk by startedAt', () => {
		const first = entry({ chunkId: 'c1', startedAt: 500, bufferedAt: T(100) });
		const second = entry({ chunkId: 'c1', startedAt: 900, bufferedAt: T(200) });
		const storage = seed([first, second]);

		remove(storage, first, NOW);

		expect(readAll(storage, NOW)).toEqual([second]);
	});

	it('is a silent no-op when the entry is not present or storage is absent', () => {
		const storage = seed([entry({ chunkId: 'c1', bufferedAt: T(100) })]);

		expect(() => remove(storage, entry({ chunkId: 'nope' }), NOW)).not.toThrow();
		expect(readAll(storage, NOW)).toHaveLength(1);
		expect(() => remove(null, entry(), NOW)).not.toThrow();
	});
});

describe('dropForUser', () => {
	it("drops one user's entries and leaves the other user's alone", () => {
		const storage = seed([
			entry({ userId: USER_A, chunkId: 'a', bufferedAt: T(100) }),
			entry({ userId: USER_B, chunkId: 'b', bufferedAt: T(200) })
		]);

		dropForUser(storage, USER_A, NOW);

		expect(readAll(storage, NOW).map((e) => e.chunkId)).toEqual(['b']);
	});

	it('never drops guest-authored entries — they belong to whoever signs in next', () => {
		const storage = seed([
			entry({ userId: null, chunkId: 'guest', bufferedAt: T(100) }),
			entry({ userId: USER_A, chunkId: 'a', bufferedAt: T(200) })
		]);

		dropForUser(storage, USER_A, NOW);

		expect(readAll(storage, NOW).map((e) => e.chunkId)).toEqual(['guest']);
	});

	it("drops every signed-in-authored entry with '*' — the sign-out rule — and keeps guest-authored ones", () => {
		const storage = seed([
			entry({ userId: USER_A, chunkId: 'a', bufferedAt: T(100) }),
			entry({ userId: USER_B, chunkId: 'b', bufferedAt: T(200) }),
			entry({ userId: null, chunkId: 'guest', bufferedAt: T(300) })
		]);

		dropForUser(storage, '*', NOW);

		expect(readAll(storage, NOW).map((e) => e.chunkId)).toEqual(['guest']);
	});

	it('is a silent no-op when the storage binding is absent or throws', () => {
		expect(() => dropForUser(null, '*', NOW)).not.toThrow();
		expect(() => dropForUser(throwingReadStorage(), '*', NOW)).not.toThrow();
	});

	it('does not rewrite the key when it dropped nothing', () => {
		const original = JSON.stringify([entry({ userId: null, bufferedAt: T(100) })]);
		const storage = fakeStorage(original);

		dropForUser(storage, '*', NOW);

		expect(storage.stored).toBe(original);
	});
});

describe('module purity (spec #15 acceptance criterion, asserted rather than conventional)', () => {
	const source = readFileSync(fileURLToPath(new URL('./buffer.ts', import.meta.url)), 'utf8');
	/** Comments explain these names; only CODE naming them would be a violation. */
	const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

	it('imports nothing from @supabase/* — this is what keeps a guest from fetching the Supabase chunk', () => {
		expect(code).not.toMatch(/@supabase\//);
	});

	it('names no DOM or browser global — localStorage is reached only through the injected port', () => {
		expect(code).not.toMatch(/\b(localStorage|sessionStorage|window|document|navigator)\b/);
	});

	it('imports the shared attempt shape type-only, so no runtime edge reaches client.ts', () => {
		const imports = code.match(/^import .*$/gm) ?? [];
		const fromClient = imports.filter((line) => line.includes("'./client'"));
		expect(fromClient).toHaveLength(1);
		expect(fromClient[0].startsWith('import type ')).toBe(true);
	});

	it('reads no ambient clock — `now` is injected on every operation (lib-patterns)', () => {
		expect(code).not.toMatch(/Date\.now\(\)/);
	});
});
