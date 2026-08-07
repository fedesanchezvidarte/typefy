import type { Chunk } from '../types.js';

export type CharacterState = 'pending' | 'correct' | 'corrected' | 'incorrect';

/**
 * What a session knows about the typeable text it is typing (spec #18): how long the text
 * is, and which chunks it currently holds — keyed by ABSOLUTE index, so windowing never
 * renumbers anything. Replaces `TypeableText` on the typing path.
 *
 * Note what it does NOT carry: `title`, `author`, `language`, `coverUrl`, `bookId`. The
 * engine never needed them; they belong on the `TypeableTextSummary` the UI holds beside it.
 *
 * Loaded chunks ACCUMULATE for the life of a session and are never evicted — an explicit,
 * bounded decision. Ten chunks are ~5 KB, so a thirty-window sitting holds ~150 KB, while
 * eviction would break both `sessionSummary`'s `charCount` lookup and `restart-session`.
 */
export interface LoadedChunks {
	/** `books.chunk_count` — the text's real length, NEVER how much is loaded. */
	readonly chunkCount: number;
	readonly chunks: ReadonlyMap<number, Chunk>;
}

/** One entry in the keystroke log — the single source of truth for all metrics. */
export interface Keystroke {
	kind: 'char' | 'backspace';
	char?: string; // the composed character as delivered by beforeinput/input (e.g. 'á', never a dead key)
	expected?: string; // expected character at the position (kind 'char' only)
	position: number; // cursor position the event applied to
	judgment?: 'hit' | 'miss'; // kind 'char' only
	firstAttempt: boolean; // true iff this stroke created the position's first-attempt record
	timestamp: number; // ms — injected by the caller (fake-clock friendly)
	/**
	 * Was this stroke inside a MEASURED span (spec #24 §3)? Written on every real stroke by
	 * `chunk.ts`, copied straight off the event exactly as `timestamp` is.
	 *
	 * Typed OPTIONAL on purpose: **absent means measured.** That keeps every pre-4a fixture
	 * and the whole pre-4a regression corpus valid without a rewrite, and it is the same
	 * construction argument the schema backfill and the v1 attempt buffer use — everything
	 * written before the mode axis existed was, by construction, fully measured.
	 *
	 * It is provenance, not a metric: the log stays the single source of truth, and a slice
	 * can now be scored without a second source of truth about when the mode changed.
	 */
	measured?: boolean;
}

/**
 * `measured` rides on the event exactly like `timestamp`, which is what lets `chunk.ts`
 * keep its metrics-free promise: it copies the flag and learns nothing about modes.
 * `session.ts` is the only module that stamps it, from `SessionState.mode`.
 */
export type ChunkEvent =
	| { type: 'char'; char: string; timestamp: number; measured?: boolean }
	| { type: 'backspace'; timestamp: number; measured?: boolean }
	| { type: 'restart' };

export interface ChunkEngineState {
	readonly text: string;
	readonly cursor: number;
	readonly display: readonly CharacterState[]; // what the UI renders
	readonly firstAttempts: readonly ('hit' | 'miss' | null)[]; // immutable once set; drives Accuracy (raw)
	readonly log: readonly Keystroke[];
	readonly startedAt: number | null; // timestamp of first keystroke
	readonly completedAt: number | null; // set the instant no char is pending/incorrect
	readonly completed: boolean;
}
