import type { CharacterState, ChunkEngineState, ChunkEvent, Keystroke } from './types.js';

/**
 * Per-chunk typing state machine (ADR-0004: free typing, correction required to complete).
 *
 * Pure reducer: `applyChunkEvent(state, event)` returns a new state; timestamps arrive
 * inside events (never read from a clock here). The keystroke log is the single source
 * of truth — "was this position ever incorrect" is derived from it, and metrics are
 * computed from it by a separate module this one never imports.
 *
 * The page model (spec #32) needed **no change to the state machine**, which is worth
 * recording rather than leaving as an absence: `\n` is judged by the same exact comparison as
 * every other character, so it takes a `CharacterState`, counts as a char stroke, and
 * backspaces to `pending` for free. `chunk.spec.ts`'s "the newline is an ordinary character"
 * block is the proof, and it is what a future whitespace special case would break.
 */

/** Code-point-safe split so precomposed characters (á, ñ, ¿…) occupy one position each. */
function toCharacters(text: string): readonly string[] {
	return Array.from(text);
}

export function createChunk(text: string): ChunkEngineState {
	const length = toCharacters(text).length;
	return {
		text,
		cursor: 0,
		display: Array.from({ length }, (): CharacterState => 'pending'),
		firstAttempts: Array.from({ length }, () => null),
		log: [],
		startedAt: null,
		completedAt: null,
		completed: false
	};
}

/**
 * The second constructor (spec #32 §8): a chunk reopened with its first `prefixLength`
 * characters already typed, for in-page restore.
 *
 * The prefix is **correct but UNJUDGED**, and that is the whole design rather than a detail:
 *
 * - `display[0..N)` is `correct`, so the page looks the way the user left it.
 * - `firstAttempts` is **all null**, so the prefix contributes to neither the accuracy
 *   numerator nor its denominator. It was judged in a sitting that is over, and re-asserting
 *   that judgement here would let a page be re-scored every time it was resumed.
 * - the log is empty and `startedAt` is null, so no keystroke and no millisecond of the time
 *   the user was away can reach `measured_chars` or `measured_ms` (ADR-0014). **Restoring
 *   never fabricates a WPM.** The 100-character best floor then excludes a trivial tail
 *   automatically, because the tail is all there is to measure.
 *
 * Note what this means for the completion rule: `corrected`/`correct` both satisfy it, so a
 * restored page completes on its remaining characters alone, exactly as if the prefix had
 * been typed cleanly a moment ago.
 *
 * `prefixLength` is clamped into `0..length`. The callers are a hand-editable storage entry
 * and a chunk whose content may have changed under a stable id, and neither has anything
 * better to do with an exception than lose the page — while a cursor past the end would be an
 * unfinishable chunk that ignores every keystroke.
 */
export function restoreChunk(text: string, prefixLength: number): ChunkEngineState {
	const characters = toCharacters(text);
	const prefix = Number.isFinite(prefixLength)
		? Math.min(Math.max(Math.floor(prefixLength), 0), characters.length)
		: 0;
	return {
		text,
		cursor: prefix,
		display: characters.map((_, i): CharacterState => (i < prefix ? 'correct' : 'pending')),
		firstAttempts: characters.map(() => null),
		log: [],
		startedAt: null,
		completedAt: null,
		completed: false
	};
}

/** Derived from the log: a position is ever-incorrect iff any char stroke missed it. */
function wasEverIncorrect(log: readonly Keystroke[], position: number): boolean {
	return log.some((k) => k.kind === 'char' && k.position === position && k.judgment === 'miss');
}

export function applyChunkEvent(state: ChunkEngineState, event: ChunkEvent): ChunkEngineState {
	if (event.type === 'restart') {
		return createChunk(state.text);
	}
	if (state.completed) {
		return state; // further keystrokes are ignored once complete
	}
	// `measured` is copied off the event exactly as `timestamp` is — absent means measured
	// (spec #24 §3). This module still knows nothing about modes and imports nothing new:
	// the flag is provenance travelling with the stroke, not a metric being computed.
	const measured = event.measured !== false;
	if (event.type === 'char') {
		return applyChar(state, event.char, event.timestamp, measured);
	}
	return applyBackspace(state, event.timestamp, measured);
}

function applyChar(
	state: ChunkEngineState,
	char: string,
	timestamp: number,
	measured: boolean
): ChunkEngineState {
	const characters = toCharacters(state.text);
	if (state.cursor >= characters.length) {
		return state; // end reached with errors remaining: backspace-only recovery
	}

	const position = state.cursor;
	const expected = characters[position];
	const hit = char === expected;
	const isFirstAttempt = state.firstAttempts[position] === null;

	const stroke: Keystroke = {
		kind: 'char',
		char,
		expected,
		position,
		judgment: hit ? 'hit' : 'miss',
		firstAttempt: isFirstAttempt,
		timestamp,
		measured
	};

	const display = state.display.slice();
	display[position] = hit
		? wasEverIncorrect(state.log, position)
			? 'corrected'
			: 'correct'
		: 'incorrect';

	const firstAttempts = isFirstAttempt
		? state.firstAttempts.map((record, i) => (i === position ? stroke.judgment! : record))
		: state.firstAttempts;

	const cursor = position + 1;
	const completed =
		cursor === characters.length && display.every((s) => s === 'correct' || s === 'corrected');

	return {
		...state,
		cursor,
		display,
		firstAttempts,
		log: [...state.log, stroke],
		startedAt: state.startedAt ?? timestamp,
		completedAt: completed ? timestamp : null,
		completed
	};
}

function applyBackspace(
	state: ChunkEngineState,
	timestamp: number,
	measured: boolean
): ChunkEngineState {
	if (state.cursor === 0) {
		return state; // no-op at the start of the chunk
	}

	const position = state.cursor - 1;
	const stroke: Keystroke = {
		kind: 'backspace',
		position,
		firstAttempt: false,
		timestamp,
		measured
	};

	const display = state.display.slice();
	display[position] = 'pending';

	return {
		...state,
		cursor: position,
		display,
		log: [...state.log, stroke]
	};
}
