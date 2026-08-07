import { isMode } from '$lib/types';
import type { ChunkAttemptInput } from './client';

/**
 * The attempt buffer (spec #15 §2): a capped, per-browser store of completed chunk
 * attempts that could not be persisted at the completion instant — a guest's (no session
 * to write under) or a signed-in user's transient write failure (no connectivity to write
 * over). A drain flushes it into `chunk_attempts` once a valid session exists.
 *
 * **Pure, over an injected storage port** (`lib-patterns` two-tier rule). This module
 * names no browser global and imports nothing from `@supabase/*` — both asserted by test,
 * not left to convention. That is what preserves the 2b bundle guarantee: a guest reaches
 * the buffer statically and still fetches neither `@supabase/ssr` nor
 * `@supabase/supabase-js`, and the mount-time "is there anything to drain?" check costs a
 * synchronous read and no dynamic import.
 *
 * **Every function here is total and silent.** An absent binding, a `SecurityError` on
 * read, malformed JSON, a value that is not the expected shape, a quota error — all read
 * as an empty buffer, and none of them throws. A buffer failure must never interrupt
 * typing, exactly as a save failure is data rather than an exception in 2b.
 */

/**
 * The injected storage port. Deliberately string-in/string-out: serialisation, shape
 * validation and all error swallowing live in this module, so the adapter stays dumb and
 * an in-memory fake for tests is three lines.
 */
export interface AttemptStorage {
	read(): string | null;
	write(value: string): void;
	clear(): void;
}

/**
 * One buffered completed chunk attempt.
 *
 * Still **derived** from `ChunkAttemptInput` rather than declared independently, so the
 * payload has exactly one definition: if a twelfth column is ever added there, the drain's
 * spread stops compiling until the buffer carries it. That failure is the point, and the
 * `Omit`/`Partial<Pick>` pair below is written the way it is to keep it.
 *
 * `mode`, `measuredMs` and `measuredChars` are **optional here and only here** (spec #24 §9).
 * The key stays `v1`: bumping it would silently discard every unsent guest completion sitting
 * in every existing browser, which is precisely the loss the buffer exists to prevent. An
 * entry written before spec #24 simply lacks the three fields, and the drain defaults it to
 * fully-Normal on the same construction argument as the database backfill — every pre-4a
 * entry was produced by an engine that always measured the whole passage.
 *
 * Optional on READ only. Every entry `enqueue` receives today carries all three.
 */
export interface BufferedChunkAttempt
	extends
		Omit<ChunkAttemptInput, 'userId' | 'mode' | 'measuredMs' | 'measuredChars'>,
		Partial<Pick<ChunkAttemptInput, 'mode' | 'measuredMs' | 'measuredChars'>> {
	/**
	 * `null` = guest-authored: typed by nobody, attributable to whoever signs in next on
	 * this browser. A string = signed-in-authored: the user held a session when they typed
	 * and the write merely failed, so the entry is drainable only under that same user.
	 */
	userId: string | null;
	/** ms epoch. FIFO ordering and TTL only — NEVER sent to the database. */
	bufferedAt: number;
}

/**
 * Versioned by suffix. A future shape change bumps `v1` and abandons the old key rather
 * than migrating it — the data is at most 30 days of unsaved attempts, not an asset worth
 * a migration path.
 */
export const ATTEMPT_BUFFER_KEY = 'typefy:attempt-buffer:v1';

/**
 * A guest would have to complete fifty passages in one browser without ever signing in to
 * reach this. Exported rather than inlined because the sign-in prompt clamps its count
 * against it, and because it is a LATENCY budget as much as a storage one: `enqueue` is
 * synchronous `localStorage` I/O on the completion instant, parsing and re-serialising the
 * whole array (~7.5 kB at the cap). Do not raise it without re-measuring.
 */
export const ATTEMPT_BUFFER_CAP = 50;

/** 30 days, evaluated on read. Expired entries are dropped and never drained. */
export const ATTEMPT_BUFFER_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Shape validation of one parsed element. `JSON.parse` is not trusted: the buffer sits on
 * disk, plainly readable and editable (ADR-0012 amendment), and a shape change or a hand
 * edit must degrade to "this entry does not exist" rather than to a `TypeError` thrown
 * into the typing path or a malformed row offered to PostgREST.
 *
 * Two rules here are load-bearing rather than mechanical:
 *
 * 1. **`grossWpm` and `accuracyRaw` must accept `null`.** They are nullable since spec #24 —
 *    a Zen traversal asserts no figure at all. `isFiniteNumber(null)` is `false`, so
 *    validating them with it would make **every guest's Zen completion read as malformed and
 *    be dropped in silence**, which is the exact loss this module exists to prevent. Only
 *    these two fields are nullable; `elapsedMs`, `startedAt` and `bufferedAt` are not, and
 *    are deliberately still checked with the strict helper.
 * 2. **The three span fields are tolerated when ABSENT and validated when PRESENT.** Absent
 *    means "written before spec #24" and drains as fully-Normal. Present-but-wrong means a
 *    hand edit or a bug, and is dropped — a `mode` outside the axis would otherwise travel
 *    all the way to the database's CHECK constraint and come back as a permanent refusal,
 *    discarding the entry there instead, one round trip later.
 */
function isBufferedChunkAttempt(value: unknown): value is BufferedChunkAttempt {
	if (typeof value !== 'object' || value === null) return false;
	const entry = value as Record<string, unknown>;
	return (
		(entry.userId === null || typeof entry.userId === 'string') &&
		typeof entry.chunkId === 'string' &&
		typeof entry.bookId === 'string' &&
		typeof entry.completed === 'boolean' &&
		isNullableFiniteNumber(entry.grossWpm) &&
		isNullableFiniteNumber(entry.accuracyRaw) &&
		isFiniteNumber(entry.elapsedMs) &&
		isFiniteNumber(entry.startedAt) &&
		isFiniteNumber(entry.bufferedAt) &&
		(entry.mode === undefined || isMode(entry.mode)) &&
		(entry.measuredMs === undefined || isFiniteNumber(entry.measuredMs)) &&
		(entry.measuredChars === undefined || isFiniteNumber(entry.measuredChars))
	);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

/**
 * `null` or a finite number — and nothing else. Written as its own helper rather than as an
 * inline `=== null ||` at the two call sites so the nullable fields are visibly a closed set
 * of two, and so widening it to a third is a deliberate edit rather than a copied clause.
 */
function isNullableFiniteNumber(value: unknown): value is number | null {
	return value === null || isFiniteNumber(value);
}

/** Best-effort clear. The binding can throw here too; that is still not our caller's problem. */
function clearQuietly(storage: AttemptStorage | null): void {
	try {
		storage?.clear();
	} catch {
		// Nothing left to do: the buffer is already being treated as empty.
	}
}

/**
 * Writes the list back, or clears the key if the write is refused. A quota error leaves
 * the key holding a list we know is stale; clearing is the only outcome that keeps the
 * stored value and the buffer's behaviour in agreement.
 */
function persist(storage: AttemptStorage | null, entries: BufferedChunkAttempt[]): void {
	if (!storage) return;
	try {
		storage.write(JSON.stringify(entries));
	} catch {
		clearQuietly(storage);
	}
}

/**
 * Parses and repairs in one pass. Returns the surviving entries plus whether anything was
 * dropped, so callers only write when the stored value actually needs correcting — the
 * mount-time read runs on every page load and must not churn the key.
 */
function load(
	storage: AttemptStorage | null,
	now: number
): { entries: BufferedChunkAttempt[]; pruned: boolean } {
	if (!storage) return { entries: [], pruned: false };

	let raw: string | null;
	try {
		raw = storage.read();
	} catch {
		// A `SecurityError` on access (private mode, blocked storage): unreadable is empty.
		return { entries: [], pruned: false };
	}
	if (raw === null || raw === '') return { entries: [], pruned: false };

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		// Garbage that will never become valid — drop the key rather than re-parsing it
		// on every page load for the next 30 days.
		clearQuietly(storage);
		return { entries: [], pruned: false };
	}
	if (!Array.isArray(parsed)) {
		clearQuietly(storage);
		return { entries: [], pruned: false };
	}

	const cutoff = now - ATTEMPT_BUFFER_TTL_MS;
	const entries = parsed
		.filter(isBufferedChunkAttempt)
		.filter((entry) => entry.bufferedAt >= cutoff)
		.sort((a, b) => a.bufferedAt - b.bufferedAt);

	return { entries, pruned: entries.length !== parsed.length };
}

/**
 * Every buffered entry, oldest first by `bufferedAt`. TTL-expired and wrong-shaped entries
 * are dropped from the result AND from storage — a read repairs, so a corrupt element can
 * never wedge the drain.
 *
 * Oldest-first is the drain's replay order: it is the honest one (it replays in typing
 * order) and it makes `last_attempt_at` land on the genuinely-latest attempt.
 */
export function readAll(storage: AttemptStorage | null, now: number): BufferedChunkAttempt[] {
	const { entries, pruned } = load(storage, now);
	if (pruned) persist(storage, entries);
	return entries;
}

/**
 * Appends one entry, then trims to the cap by evicting the LOWEST `bufferedAt` first —
 * by timestamp, not by insertion order, so an entry that arrives late but was buffered
 * early is still the one evicted.
 */
export function enqueue(
	storage: AttemptStorage | null,
	entry: BufferedChunkAttempt,
	now: number
): void {
	if (!storage) return;
	const { entries } = load(storage, now);
	entries.push(entry);
	entries.sort((a, b) => a.bufferedAt - b.bufferedAt);
	persist(storage, entries.slice(Math.max(0, entries.length - ATTEMPT_BUFFER_CAP)));
}

/**
 * Removes by VALUE identity `(userId, chunkId, startedAt)` — the same triple the database's
 * unique index uses, widened by `userId: null` for guest-authored entries. Object identity
 * is unavailable: the drain reads its entries back through `JSON.parse`, so the object it
 * hands here is never the object that was enqueued.
 *
 * Called only after a write is acknowledged (or refused permanently), never before.
 */
export function remove(
	storage: AttemptStorage | null,
	entry: BufferedChunkAttempt,
	now: number
): void {
	if (!storage) return;
	const { entries } = load(storage, now);
	persist(
		storage,
		entries.filter(
			(candidate) =>
				!(
					candidate.userId === entry.userId &&
					candidate.chunkId === entry.chunkId &&
					candidate.startedAt === entry.startedAt
				)
		)
	);
}

/**
 * Attribution hygiene (spec #15 §5). `owner` is a user id, or `'*'` for every
 * signed-in-authored entry — the sign-out rule, which covers sign-out, session expiry and
 * any other transition to guest in one pass. `'*'` cannot collide with a uuid.
 *
 * **Guest-authored entries are never dropped here.** They are not anybody's yet; they
 * belong to whoever signs in next on this browser.
 */
export function dropForUser(
	storage: AttemptStorage | null,
	owner: string | '*',
	now: number
): void {
	if (!storage) return;
	const { entries, pruned } = load(storage, now);
	const kept = entries.filter(
		(entry) => entry.userId === null || !(owner === '*' || entry.userId === owner)
	);
	if (!pruned && kept.length === entries.length) return;
	persist(storage, kept);
}
