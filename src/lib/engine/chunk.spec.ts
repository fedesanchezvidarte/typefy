import { describe, expect, it } from 'vitest';
import { createChunk, applyChunkEvent, restoreChunk } from './chunk.js';
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

/*
 * The newline as an ordinary character (spec #32, ADR-0004 amendment).
 *
 * The Feature Brief claims `applyChar` / `applyBackspace` need NO change for `\n`, because
 * they compare characters exactly and know nothing about what a character means. These tests
 * exist to prove that claim rather than assume it: they were written before anything in this
 * module was touched, and they are the evidence that the page model's newline needed no
 * state-machine work at all. If a later "optimisation" ever special-cases whitespace, this is
 * what fails.
 */
describe('applyChunkEvent — the newline is an ordinary character', () => {
	const page = 'ab\ncd';

	it('sizes a chunk so a newline occupies one position like any other character', () => {
		const state = createChunk(page);
		expect(state.display).toHaveLength(5);
		expect(state.firstAttempts).toHaveLength(5);
	});

	it('marks the newline correct when Enter delivers a `\\n` at that position', () => {
		const state = run(createChunk(page), chars('ab\n'));
		expect(state.display[2]).toBe('correct');
		expect(state.cursor).toBe(3);
	});

	it('marks the newline incorrect when any other character is typed there', () => {
		// The space is the interesting wrong answer: it is what a typist reaches for when the
		// line break is invisible, and it must NOT be accepted as one.
		const state = run(createChunk(page), chars('ab '));
		expect(state.display[2]).toBe('incorrect');
		expect(state.cursor).toBe(3);
	});

	it('returns a mistyped newline position to pending on backspace', () => {
		const state = run(createChunk(page), [...chars('ab '), { type: 'backspace', timestamp: 1400 }]);
		expect(state.display[2]).toBe('pending');
		expect(state.cursor).toBe(2);
	});

	it('returns a CORRECTLY typed newline to pending on backspace, like any other character', () => {
		const state = run(createChunk(page), [
			...chars('ab\n'),
			{ type: 'backspace', timestamp: 1400 }
		]);
		expect(state.display[2]).toBe('pending');
		expect(state.cursor).toBe(2);
	});

	it('marks a retyped newline corrected, so it counts as a miss in raw accuracy', () => {
		const state = run(createChunk(page), [
			...chars('ab '),
			{ type: 'backspace', timestamp: 1400 },
			{ type: 'char', char: '\n', timestamp: 1500 }
		]);
		expect(state.display[2]).toBe('corrected');
		expect(state.firstAttempts[2]).toBe('miss');
	});

	it('completes a page containing a newline, and the newline is one of its char strokes', () => {
		const state = run(createChunk(page), chars(page));
		expect(state.completed).toBe(true);
		// The WPM denominator and `measured_chars` are counted off these strokes, so this is
		// where "a `\n` counts toward measured_chars" actually comes from.
		expect(state.log.filter((k) => k.kind === 'char')).toHaveLength(5);
		expect(state.log.some((k) => k.kind === 'char' && k.char === '\n')).toBe(true);
	});

	it('does not complete a page whose newline is still incorrect', () => {
		const state = run(createChunk(page), chars('ab cd'));
		expect(state.completed).toBe(false);
		expect(state.cursor).toBe(5);
	});
});

describe('restoreChunk', () => {
	const page = 'first\nsecond';

	it('places the cursor after the restored prefix', () => {
		expect(restoreChunk(page, 5).cursor).toBe(5);
	});

	it('renders the restored prefix as correct and the rest as pending', () => {
		expect(restoreChunk(page, 3).display).toEqual([
			'correct',
			'correct',
			'correct',
			...Array.from({ length: page.length - 3 }, () => 'pending')
		]);
	});

	/*
	 * The load-bearing choice (spec #32 §8). The prefix is correct but UNJUDGED: it belongs to
	 * a sitting that is over. Null first-attempt records keep it out of both the accuracy
	 * numerator and its denominator, and an empty log keeps it out of `measured_chars` and
	 * `measured_ms` — which is what stops a restore fabricating a WPM for time the user was
	 * away, and what makes the 100-character best floor exclude trivial tails for free.
	 */
	it('leaves every first-attempt record null — the prefix is correct but UNJUDGED', () => {
		expect(restoreChunk(page, 5).firstAttempts).toEqual(
			Array.from({ length: page.length }, () => null)
		);
	});

	it('produces no keystrokes and no start time, so the restored span is measured by nothing', () => {
		const state = restoreChunk(page, 5);
		expect(state.log).toEqual([]);
		expect(state.startedAt).toBeNull();
		expect(state.completedAt).toBeNull();
		expect(state.completed).toBe(false);
	});

	it('is byte-identical to createChunk for a zero-length prefix', () => {
		expect(restoreChunk(page, 0)).toEqual(createChunk(page));
	});

	it('restores across a newline, since a `\\n` is an ordinary prefix character', () => {
		const state = restoreChunk(page, 6);
		expect(state.display[5]).toBe('correct');
		expect(state.cursor).toBe(6);
	});

	it('counts the prefix in code points, so an accented character is one position', () => {
		const state = restoreChunk('ñandú vive', 5);
		expect(state.cursor).toBe(5);
		expect(state.display.slice(0, 5).every((s) => s === 'correct')).toBe(true);
		expect(state.display[5]).toBe('pending');
	});

	it('clamps a prefix past the end of the text rather than producing an unfinishable chunk', () => {
		// A re-ingest that shortened the content under a stable chunk id, or a hand-edited
		// storage entry. It must degrade to "the whole page is restored", never to a cursor
		// pointing past the text where no keystroke can ever land.
		const state = restoreChunk('abc', 99);
		expect(state.cursor).toBe(3);
		expect(state.display).toEqual(['correct', 'correct', 'correct']);
	});

	it('clamps a negative or fractional prefix to a whole, non-negative position', () => {
		expect(restoreChunk('abc', -4).cursor).toBe(0);
		expect(restoreChunk('abc', 1.9).cursor).toBe(1);
		expect(restoreChunk('abc', Number.NaN).cursor).toBe(0);
	});

	/*
	 * A restored chunk is a NORMAL chunk: it does not complete on its own, and the strokes
	 * that finish it are the only ones anything measures.
	 */
	it('completes on the remaining characters alone, which are the whole of the measured span', () => {
		const state = run(restoreChunk('abcd', 2), chars('cd', 5000));
		expect(state.completed).toBe(true);
		expect(state.startedAt).toBe(5000);
		expect(state.log.filter((k) => k.kind === 'char')).toHaveLength(2);
	});
});

/*
 * `typed` — what the surface renders in a slot. Display-only: no metric reads it, which is
 * why these assertions never touch the log, the first-attempt records or the timer.
 */
describe('applyChunkEvent — the typed character per position', () => {
	it('starts null everywhere, one entry per code point', () => {
		expect(createChunk('ñá¿').typed).toEqual([null, null, null]);
	});

	it('records the WRONG character actually typed, so the surface can show the typo itself', () => {
		const state = run(createChunk('Normal'), chars('Np'));
		expect(state.typed.slice(0, 2)).toEqual(['N', 'p']);
		expect(state.display[1]).toBe('incorrect');
	});

	it('records correct characters too, so `typed` and `display` agree at every position', () => {
		const state = run(createChunk('abc'), chars('ab'));
		expect(state.typed).toEqual(['a', 'b', null]);
	});

	it('clears the position on backspace — a pending slot shows the expected character again', () => {
		const state = run(createChunk('Normal'), [
			...chars('Np'),
			{ type: 'backspace', timestamp: 1200 }
		]);
		expect(state.typed).toEqual(['N', null, null, null, null, null]);
		expect(state.display[1]).toBe('pending');
	});

	it('overwrites on a retype, keeping only the CURRENT attempt', () => {
		const state = run(createChunk('Normal'), [
			...chars('Np'),
			{ type: 'backspace', timestamp: 1200 },
			{ type: 'char', char: 'o', timestamp: 1300 }
		]);
		expect(state.typed[1]).toBe('o');
		expect(state.display[1]).toBe('corrected');
	});

	it('holds a composed character as one entry', () => {
		const state = run(createChunk('ñandú'), chars('ñ'));
		expect(state.typed[0]).toBe('ñ');
	});

	it('fills the restored prefix with the expected characters and leaves the rest null', () => {
		expect(restoreChunk('abcd', 2).typed).toEqual(['a', 'b', null, null]);
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
