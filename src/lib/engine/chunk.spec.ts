import { describe, expect, it } from 'vitest';
import { createChunk, applyChunkEvent } from './chunk.js';
import type { ChunkEngineState, ChunkEvent } from './types.js';

/** Applies a sequence of events, auto-incrementing the injected clock by 100ms per event. */
function run(state: ChunkEngineState, events: readonly ChunkEvent[]): ChunkEngineState {
	return events.reduce((s, e) => applyChunkEvent(s, e), state);
}

/** Builds char events for each code point of `text`, timestamps start+0, start+100, ... */
function chars(text: string, start = 1000, step = 100): ChunkEvent[] {
	return Array.from(text).map((char, i) => ({ type: 'char', char, timestamp: start + i * step }));
}

describe('createChunk', () => {
	it('starts fully pending with no cursor progress, no log, and no timer', () => {
		const state = createChunk('abc');
		expect(state.text).toBe('abc');
		expect(state.cursor).toBe(0);
		expect(state.display).toEqual(['pending', 'pending', 'pending']);
		expect(state.firstAttempts).toEqual([null, null, null]);
		expect(state.log).toEqual([]);
		expect(state.startedAt).toBeNull();
		expect(state.completedAt).toBeNull();
		expect(state.completed).toBe(false);
	});

	it('sizes state by code points so precomposed Spanish characters are single positions', () => {
		const state = createChunk('ñá¿');
		expect(state.display).toHaveLength(3);
		expect(state.firstAttempts).toHaveLength(3);
	});
});

describe('applyChunkEvent — judgment and cursor', () => {
	it('marks a matching character correct and advances the cursor', () => {
		const state = applyChunkEvent(createChunk('abc'), { type: 'char', char: 'a', timestamp: 1000 });
		expect(state.display[0]).toBe('correct');
		expect(state.cursor).toBe(1);
	});

	it('marks a mismatched character incorrect and still advances the cursor (free typing)', () => {
		const state = applyChunkEvent(createChunk('abc'), { type: 'char', char: 'x', timestamp: 1000 });
		expect(state.display[0]).toBe('incorrect');
		expect(state.cursor).toBe(1);
	});

	it('does not mutate the previous state (immutable updates)', () => {
		const before = createChunk('abc');
		applyChunkEvent(before, { type: 'char', char: 'a', timestamp: 1000 });
		expect(before.cursor).toBe(0);
		expect(before.display[0]).toBe('pending');
		expect(before.log).toHaveLength(0);
	});

	it('logs each char stroke with expected character, judgment, and injected timestamp', () => {
		const state = run(createChunk('ab'), [
			{ type: 'char', char: 'a', timestamp: 1000 },
			{ type: 'char', char: 'z', timestamp: 1100 }
		]);
		expect(state.log).toHaveLength(2);
		expect(state.log[0]).toMatchObject({
			kind: 'char',
			char: 'a',
			expected: 'a',
			position: 0,
			judgment: 'hit',
			firstAttempt: true,
			timestamp: 1000
		});
		expect(state.log[1]).toMatchObject({
			kind: 'char',
			char: 'z',
			expected: 'b',
			position: 1,
			judgment: 'miss',
			firstAttempt: true,
			timestamp: 1100
		});
	});

	it('judges an expected space: space is a hit, any other character a miss', () => {
		const hit = applyChunkEvent(createChunk('a b'), { type: 'char', char: 'a', timestamp: 0 });
		const spaceHit = applyChunkEvent(hit, { type: 'char', char: ' ', timestamp: 100 });
		expect(spaceHit.display[1]).toBe('correct');
		const spaceMiss = applyChunkEvent(hit, { type: 'char', char: 'x', timestamp: 100 });
		expect(spaceMiss.display[1]).toBe('incorrect');
	});
});

describe('applyChunkEvent — Spanish composed characters', () => {
	it('judges á é í ó ú ñ ¿ ¡ as single composed characters', () => {
		const text = 'áéíóúñ¿¡';
		const state = run(createChunk(text), chars(text));
		expect(state.display).toEqual(Array.from(text).map(() => 'correct'));
		expect(state.completed).toBe(true);
	});

	it("treats 'a' vs 'á' as a mismatch", () => {
		const state = applyChunkEvent(createChunk('á'), { type: 'char', char: 'a', timestamp: 0 });
		expect(state.display[0]).toBe('incorrect');
	});

	it("treats 'n' vs 'ñ' as a mismatch", () => {
		const state = applyChunkEvent(createChunk('ñ'), { type: 'char', char: 'n', timestamp: 0 });
		expect(state.display[0]).toBe('incorrect');
	});
});

describe('applyChunkEvent — backspace', () => {
	it('moves the cursor back one and returns that position to pending', () => {
		const typed = run(createChunk('abc'), chars('ax'));
		const state = applyChunkEvent(typed, { type: 'backspace', timestamp: 1300 });
		expect(state.cursor).toBe(1);
		expect(state.display[1]).toBe('pending');
		expect(state.display[0]).toBe('correct');
	});

	it('is a no-op at position 0', () => {
		const initial = createChunk('abc');
		const state = applyChunkEvent(initial, { type: 'backspace', timestamp: 1000 });
		expect(state).toEqual(initial);
	});

	it('leaves the first-attempt record untouched', () => {
		const typed = run(createChunk('abc'), chars('ax'));
		const state = applyChunkEvent(typed, { type: 'backspace', timestamp: 1300 });
		expect(state.firstAttempts).toEqual(['hit', 'miss', null]);
	});

	it('is recorded in the log as a backspace stroke (never a typed char)', () => {
		const typed = run(createChunk('abc'), chars('ax'));
		const state = applyChunkEvent(typed, { type: 'backspace', timestamp: 1300 });
		const last = state.log[state.log.length - 1];
		expect(last).toMatchObject({ kind: 'backspace', position: 1, timestamp: 1300 });
	});
});

describe('applyChunkEvent — first-attempt record and retype semantics', () => {
	it('judges each position once: retype after backspace never rewrites the record', () => {
		const state = run(createChunk('ab'), [
			{ type: 'char', char: 'x', timestamp: 0 }, // miss, first attempt
			{ type: 'backspace', timestamp: 100 },
			{ type: 'char', char: 'a', timestamp: 200 } // fix — not a first attempt
		]);
		expect(state.firstAttempts[0]).toBe('miss');
		const retype = state.log[state.log.length - 1];
		expect(retype.firstAttempt).toBe(false);
	});

	it('shows corrected (yellow) for an ever-incorrect position fixed via backspace', () => {
		const state = run(createChunk('ab'), [
			{ type: 'char', char: 'x', timestamp: 0 },
			{ type: 'backspace', timestamp: 100 },
			{ type: 'char', char: 'a', timestamp: 200 }
		]);
		expect(state.display[0]).toBe('corrected');
	});

	it('never lets an ever-incorrect position display plain correct again', () => {
		const state = run(createChunk('ab'), [
			{ type: 'char', char: 'x', timestamp: 0 },
			{ type: 'backspace', timestamp: 100 },
			{ type: 'char', char: 'a', timestamp: 200 },
			{ type: 'backspace', timestamp: 300 },
			{ type: 'char', char: 'a', timestamp: 400 }
		]);
		expect(state.display[0]).toBe('corrected');
	});

	it('keeps a first-attempt-correct position correct after backspace and correct retype', () => {
		const state = run(createChunk('ab'), [
			{ type: 'char', char: 'a', timestamp: 0 },
			{ type: 'backspace', timestamp: 100 },
			{ type: 'char', char: 'a', timestamp: 200 }
		]);
		expect(state.display[0]).toBe('correct');
		expect(state.firstAttempts[0]).toBe('hit');
	});

	it('displays corrected for a first-attempt-hit position that later went incorrect, keeping the hit record', () => {
		const state = run(createChunk('ab'), [
			{ type: 'char', char: 'a', timestamp: 0 }, // hit, first attempt
			{ type: 'backspace', timestamp: 100 },
			{ type: 'char', char: 'x', timestamp: 200 }, // now incorrect (record untouched)
			{ type: 'backspace', timestamp: 300 },
			{ type: 'char', char: 'a', timestamp: 400 } // ever-incorrect → corrected
		]);
		expect(state.display[0]).toBe('corrected');
		expect(state.firstAttempts[0]).toBe('hit');
	});
});

describe('applyChunkEvent — completion', () => {
	it('completes the instant the cursor passes the end with every position correct/corrected', () => {
		const state = run(createChunk('ab'), [
			{ type: 'char', char: 'a', timestamp: 0 },
			{ type: 'char', char: 'x', timestamp: 100 },
			{ type: 'backspace', timestamp: 200 },
			{ type: 'char', char: 'b', timestamp: 300 }
		]);
		expect(state.display).toEqual(['correct', 'corrected']);
		expect(state.completed).toBe(true);
		expect(state.completedAt).toBe(300);
	});

	it('does not complete while any position is incorrect, even with the cursor at the end', () => {
		const state = run(createChunk('ab'), chars('xb'));
		expect(state.cursor).toBe(2);
		expect(state.completed).toBe(false);
		expect(state.completedAt).toBeNull();
	});

	it('ignores further char events at the end with errors remaining (backspace-only recovery)', () => {
		const atEnd = run(createChunk('ab'), chars('xb'));
		const state = applyChunkEvent(atEnd, { type: 'char', char: 'z', timestamp: 999 });
		expect(state).toEqual(atEnd);
	});

	it('recovers from end-with-errors by backspacing to the error and retyping', () => {
		const state = run(createChunk('ab'), [
			{ type: 'char', char: 'x', timestamp: 0 },
			{ type: 'char', char: 'b', timestamp: 100 },
			{ type: 'backspace', timestamp: 200 },
			{ type: 'backspace', timestamp: 300 },
			{ type: 'char', char: 'a', timestamp: 400 },
			{ type: 'char', char: 'b', timestamp: 500 }
		]);
		expect(state.display).toEqual(['corrected', 'correct']);
		expect(state.completed).toBe(true);
		expect(state.completedAt).toBe(500);
	});

	it('ignores every keystroke after completion', () => {
		const done = run(createChunk('a'), chars('a'));
		expect(done.completed).toBe(true);
		const afterChar = applyChunkEvent(done, { type: 'char', char: 'a', timestamp: 999 });
		const afterBackspace = applyChunkEvent(done, { type: 'backspace', timestamp: 999 });
		expect(afterChar).toEqual(done);
		expect(afterBackspace).toEqual(done);
	});
});

describe('applyChunkEvent — timer', () => {
	it('sets startedAt to the first keystroke timestamp and keeps it there', () => {
		const first = applyChunkEvent(createChunk('ab'), { type: 'char', char: 'a', timestamp: 500 });
		expect(first.startedAt).toBe(500);
		const second = applyChunkEvent(first, { type: 'char', char: 'b', timestamp: 900 });
		expect(second.startedAt).toBe(500);
	});

	it('sets completedAt to the completing keystroke timestamp', () => {
		const state = run(createChunk('ab'), [
			{ type: 'char', char: 'a', timestamp: 500 },
			{ type: 'char', char: 'b', timestamp: 1700 }
		]);
		expect(state.startedAt).toBe(500);
		expect(state.completedAt).toBe(1700);
	});
});

describe('applyChunkEvent — restart', () => {
	it('resets display, cursor, log, first-attempt records, and timer', () => {
		const typed = run(createChunk('abc'), chars('axc'));
		const state = applyChunkEvent(typed, { type: 'restart' });
		expect(state).toEqual(createChunk('abc'));
	});

	it('restarts even a completed chunk', () => {
		const done = run(createChunk('a'), chars('a'));
		const state = applyChunkEvent(done, { type: 'restart' });
		expect(state).toEqual(createChunk('a'));
	});
});
