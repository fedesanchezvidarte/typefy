import type { CharacterState, ChunkEngineState, ChunkEvent, Keystroke } from './types.js';

/**
 * Per-chunk typing state machine (ADR-0004: free typing, correction required to complete).
 *
 * Pure reducer: `applyChunkEvent(state, event)` returns a new state; timestamps arrive
 * inside events (never read from a clock here). The keystroke log is the single source
 * of truth — "was this position ever incorrect" is derived from it, and metrics are
 * computed from it by a separate module this one never imports.
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
	if (event.type === 'char') {
		return applyChar(state, event.char, event.timestamp);
	}
	return applyBackspace(state, event.timestamp);
}

function applyChar(state: ChunkEngineState, char: string, timestamp: number): ChunkEngineState {
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
		timestamp
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

function applyBackspace(state: ChunkEngineState, timestamp: number): ChunkEngineState {
	if (state.cursor === 0) {
		return state; // no-op at the start of the chunk
	}

	const position = state.cursor - 1;
	const stroke: Keystroke = {
		kind: 'backspace',
		position,
		firstAttempt: false,
		timestamp
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
