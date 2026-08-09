import type { CharacterState } from '$lib/engine/types';
import type { AttemptStorage } from './buffer';

/**
 * In-page restore (spec #32 §8): the one page a user left half-typed, remembered per browser
 * so returning to it does not throw the typing away.
 *
 * **Pure, over an injected storage port** (`lib-patterns` two-tier rule) — the same shape as
 * `buffer.ts`, whose cap / TTL / validation discipline this module copies. It reuses
 * `storage.ts` verbatim (already key-parameterised) and touches `buffer.ts` not at all.
 *
 * **Its own key, deliberately.** The attempt buffer holds COMPLETED attempts destined for the
 * server and sitting in the drain's path; this holds one UNCOMPLETED page destined for
 * nobody. Sharing the slot would park a never-sendable entry in front of the drain. Nothing
 * here is ever sent anywhere, and nothing here is user-scoped: no entry can become a database
 * row, so the buffer's attribution rules have nothing to attach to.
 *
 * **Every function is total and silent**, exactly as the buffer's are. An absent binding, a
 * `SecurityError`, malformed JSON, a wrong shape, a quota error — all read as "there is no
 * saved page", and none of them throws. Losing a half-typed page is a small cost; interrupting
 * typing is not.
 */

/**
 * One remembered page.
 *
 * Deliberately **not the typed text**: the chunk's content is authoritative and the prefix is
 * by definition its first N characters, so storing the text would be a second copy that can
 * disagree with the first.
 *
 * `savedTextLength` is the invalidation guard. Chunks upsert on `(book_id, index)` and ids are
 * stable across a re-ingest, so a matching `chunkId` proves nothing on its own — the content
 * underneath it may have been replaced. A length mismatch is enough to discard the entry.
 */
export interface PageState {
	bookId: string;
	chunkId: string;
	index: number;
	/** Characters (code points) already typed and resolved. Never 0 in storage. */
	prefixLength: number;
	/** `chunks.content.length` when the page was saved — see above. */
	savedTextLength: number;
	/** ms epoch. Eviction order and TTL only. */
	savedAt: number;
}

/** What a caller knows on mount, and everything needed to decide whether to trust an entry. */
export interface PageQuery {
	bookId: string;
	chunkId: string;
	index: number;
	textLength: number;
}

/** Which page to forget. No chunk id: completion clears the slot whatever is in it. */
export interface PageRef {
	bookId: string;
	index: number;
}

/**
 * Versioned by suffix, and NOT the attempt buffer's key (see the module comment). A future
 * shape change bumps `v1` and abandons the old key rather than migrating it — the data is at
 * most one unfinished page per book, not an asset worth a migration path.
 */
export const PAGE_STATE_KEY = 'typefy:page-state:v1';

/**
 * Twenty half-typed pages across every book in one browser. The cap is a latency budget as
 * much as a storage one — a save is synchronous `localStorage` I/O that re-serialises the
 * whole array — but each entry is six small fields, so twenty is well under a kilobyte.
 */
export const PAGE_STATE_CAP = 20;

/** 30 days, evaluated on read. Matches the attempt buffer, for one rule instead of two. */
export const PAGE_STATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How much of a page is restorable: the longest `correct`-or-`corrected` prefix.
 *
 * It truncates at the first `pending` **or** `incorrect` position rather than counting
 * resolved characters anywhere in the page. A prefix containing an unresolved `incorrect`
 * character cannot be restored as "already correct" without lying about it, and correct
 * characters BEYOND an unresolved one cannot be restored at all — the cursor has to sit
 * somewhere, and the only honest place is the first thing still to do.
 *
 * `corrected` counts as resolved: it renders like `correct` and satisfies completion
 * (ADR-0004). Its cost — a miss in raw accuracy — was already paid in the sitting that
 * produced it, and `restoreChunk` deliberately drops it rather than re-charging it.
 */
export function resolvedPrefixLength(display: readonly CharacterState[]): number {
	let length = 0;
	for (const state of display) {
		if (state !== 'correct' && state !== 'corrected') break;
		length += 1;
	}
	return length;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Shape validation of one parsed element. `JSON.parse` is not trusted: this sits on disk,
 * plainly readable and editable (ADR-0012 amendment), and a hand edit must degrade to "this
 * page was never saved" rather than to a `TypeError` thrown into the typing path or a cursor
 * placed somewhere the engine cannot recover from.
 */
function isPageState(value: unknown): value is PageState {
	if (typeof value !== 'object' || value === null) return false;
	const entry = value as Record<string, unknown>;
	return (
		typeof entry.bookId === 'string' &&
		typeof entry.chunkId === 'string' &&
		isFiniteNumber(entry.index) &&
		isFiniteNumber(entry.prefixLength) &&
		isFiniteNumber(entry.savedTextLength) &&
		isFiniteNumber(entry.savedAt)
	);
}

function samePage(entry: PageState, ref: PageRef): boolean {
	return entry.bookId === ref.bookId && entry.index === ref.index;
}

/** Best-effort clear. The binding can throw here too; that is still not our caller's problem. */
function clearQuietly(storage: AttemptStorage | null): void {
	try {
		storage?.clear();
	} catch {
		// Nothing left to do: the slot is already being treated as empty.
	}
}

/**
 * Writes the list back, or clears the key if the write is refused. A quota error leaves the
 * key holding a list we know is stale; clearing is the only outcome that keeps the stored
 * value and this module's behaviour in agreement.
 */
function persist(storage: AttemptStorage | null, entries: PageState[]): void {
	if (!storage) return;
	try {
		storage.write(JSON.stringify(entries));
	} catch {
		clearQuietly(storage);
	}
}

/** Parses, validates and expires in one pass. Oldest first, which is the eviction order. */
function load(storage: AttemptStorage | null, now: number): PageState[] {
	if (!storage) return [];

	let raw: string | null;
	try {
		raw = storage.read();
	} catch {
		// A `SecurityError` on access (private mode, blocked storage): unreadable is empty.
		return [];
	}
	if (raw === null || raw === '') return [];

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		// Garbage that will never become valid — drop the key rather than re-parsing it on
		// every page load for the next 30 days.
		clearQuietly(storage);
		return [];
	}
	if (!Array.isArray(parsed)) {
		clearQuietly(storage);
		return [];
	}

	const cutoff = now - PAGE_STATE_TTL_MS;
	return parsed
		.filter(isPageState)
		.filter((entry) => entry.savedAt >= cutoff)
		.sort((a, b) => a.savedAt - b.savedAt);
}

/**
 * Remembers one page, replacing whatever was remembered for the same `(bookId, index)`.
 *
 * **A prefix of zero clears the slot instead of saving.** There is nothing to restore, and
 * backspacing to the start of a page must not leave yesterday's longer prefix behind — which
 * is the one way this module could silently restore text the user had already rejected.
 *
 * Over the cap, the LOWEST `savedAt` is evicted: by timestamp rather than insertion order, so
 * an entry that arrives late but was saved early is still the one that goes.
 */
export function savePageState(storage: AttemptStorage | null, entry: PageState, now: number): void {
	if (!storage) return;
	const others = load(storage, now).filter((candidate) => !samePage(candidate, entry));
	if (entry.prefixLength <= 0) {
		persist(storage, others);
		return;
	}
	const entries = [...others, entry].sort((a, b) => a.savedAt - b.savedAt);
	persist(storage, entries.slice(Math.max(0, entries.length - PAGE_STATE_CAP)));
}

/**
 * The remembered page for this query, or `null` — which covers every reason not to trust one:
 * nothing saved, expired, a different chunk id at that index, or content of a different
 * length under the same id. All four are one answer to the caller, because the caller does
 * exactly the same thing in each case.
 */
export function readPageState(
	storage: AttemptStorage | null,
	query: PageQuery,
	now: number
): PageState | null {
	const entry = load(storage, now).find((candidate) => samePage(candidate, query));
	if (!entry) return null;
	if (entry.chunkId !== query.chunkId) return null;
	if (entry.savedTextLength !== query.textLength) return null;
	return entry;
}

/**
 * Forgets one page. Called on completion — the `chunk_attempts` row supersedes it — and
 * whenever a restored page is finished or abandoned deliberately.
 */
export function clearPageState(storage: AttemptStorage | null, ref: PageRef, now: number): void {
	if (!storage) return;
	const entries = load(storage, now);
	const kept = entries.filter((entry) => !samePage(entry, ref));
	if (kept.length === entries.length) return;
	persist(storage, kept);
}
