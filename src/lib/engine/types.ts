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
}

export type ChunkEvent =
	| { type: 'char'; char: string; timestamp: number }
	| { type: 'backspace'; timestamp: number }
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
