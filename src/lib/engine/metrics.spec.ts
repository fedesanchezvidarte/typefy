import { describe, expect, it } from 'vitest';
import { computeMetrics, wordSlices } from './metrics.js';
import { createChunk, applyChunkEvent } from './chunk.js';
import type { ChunkEngineState, ChunkEvent, Keystroke } from './types.js';

function run(state: ChunkEngineState, events: readonly ChunkEvent[]): ChunkEngineState {
	return events.reduce((s, e) => applyChunkEvent(s, e), state);
}

/** Types `input` against a fresh chunk of `text`, one stroke every `step` ms from `start`. */
function typeLog(text: string, input: string, start = 0, step = 100): readonly Keystroke[] {
	return run(createChunk(text), [
		...Array.from(input).map((char, i): ChunkEvent => ({
			type: 'char',
			char,
			timestamp: start + i * step
		}))
	]).log;
}

describe('computeMetrics — gross WPM with a fake clock', () => {
	it('computes (typed chars ÷ 5) ÷ elapsed minutes', () => {
		// 10 correct chars, first stroke at 0, last at 30_000 → 2 words / 0.5 min = 4 WPM
		const text = 'abcdefghij';
		const log = typeLog(text, text, 0, 30_000 / 9);
		expect(computeMetrics(log).grossWpm).toBeCloseTo(4, 5);
	});

	it('excludes backspaces from typed chars but keeps them in the time span', () => {
		const state = run(createChunk('ab'), [
			{ type: 'char', char: 'a', timestamp: 0 },
			{ type: 'char', char: 'x', timestamp: 1000 },
			{ type: 'backspace', timestamp: 2000 },
			{ type: 'char', char: 'b', timestamp: 3000 }
		]);
		const metrics = computeMetrics(state.log);
		expect(metrics.typedChars).toBe(3); // a, x, b — backspace not a typed char
		expect(metrics.elapsedMs).toBe(3000);
		expect(metrics.grossWpm).toBeCloseTo(3 / 5 / (3000 / 60_000), 5);
	});

	it('supports live metrics via endTime (elapsed = endTime − first stroke)', () => {
		const log = typeLog('abc', 'ab', 1000, 500); // strokes at 1000, 1500
		const metrics = computeMetrics(log, 7000);
		expect(metrics.elapsedMs).toBe(6000);
		expect(metrics.grossWpm).toBeCloseTo(2 / 5 / (6000 / 60_000), 5);
	});

	it('returns a zeroed snapshot for an empty slice', () => {
		expect(computeMetrics([])).toEqual({
			grossWpm: 0,
			accuracyRaw: 0,
			typedChars: 0,
			elapsedMs: 0
		});
	});

	it('returns zero WPM for a zero-elapsed slice instead of dividing by zero', () => {
		const log = typeLog('a', 'a', 500);
		const metrics = computeMetrics(log);
		expect(metrics.elapsedMs).toBe(0);
		expect(metrics.grossWpm).toBe(0);
		expect(metrics.typedChars).toBe(1);
	});
});

describe('computeMetrics — Accuracy (raw)', () => {
	it('computes first-attempt hits ÷ first-attempt entries', () => {
		const log = typeLog('abcd', 'axcd'); // 3 first-attempt hits, 1 miss
		expect(computeMetrics(log).accuracyRaw).toBeCloseTo(0.75, 5);
	});

	it('counts corrected as a miss through the mistype→fix→retype sequence', () => {
		const state = run(createChunk('ab'), [
			{ type: 'char', char: 'x', timestamp: 0 }, // first attempt: miss
			{ type: 'backspace', timestamp: 100 },
			{ type: 'char', char: 'a', timestamp: 200 }, // fixed → corrected, still a miss
			{ type: 'char', char: 'b', timestamp: 300 } // first attempt: hit
		]);
		expect(state.display).toEqual(['corrected', 'correct']);
		expect(computeMetrics(state.log).accuracyRaw).toBeCloseTo(0.5, 5);
	});

	it('for a completed chunk, the denominator equals the total characters', () => {
		const state = run(createChunk('abc'), [
			{ type: 'char', char: 'a', timestamp: 0 },
			{ type: 'char', char: 'x', timestamp: 100 },
			{ type: 'backspace', timestamp: 200 },
			{ type: 'char', char: 'b', timestamp: 300 },
			{ type: 'char', char: 'c', timestamp: 400 }
		]);
		expect(state.completed).toBe(true);
		const firstAttemptEntries = state.log.filter((k) => k.firstAttempt);
		expect(firstAttemptEntries).toHaveLength(3);
		expect(computeMetrics(state.log).accuracyRaw).toBeCloseTo(2 / 3, 5);
	});
});

describe('wordSlices', () => {
	it('splits a chunk log at judged expected-space positions', () => {
		const log = typeLog('ab cd', 'ab cd');
		const slices = wordSlices(log);
		expect(slices).toHaveLength(2);
		expect(slices[0].map((k) => k.char)).toEqual(['a', 'b', ' ']);
		expect(slices[1].map((k) => k.char)).toEqual(['c', 'd']);
	});

	it('keeps mistype/backspace/fix activity inside the word it happened in', () => {
		const state = run(createChunk('ab cd'), [
			{ type: 'char', char: 'a', timestamp: 0 },
			{ type: 'char', char: 'x', timestamp: 100 },
			{ type: 'backspace', timestamp: 200 },
			{ type: 'char', char: 'b', timestamp: 300 },
			{ type: 'char', char: ' ', timestamp: 400 },
			{ type: 'char', char: 'c', timestamp: 500 },
			{ type: 'char', char: 'd', timestamp: 600 }
		]);
		const slices = wordSlices(state.log);
		expect(slices).toHaveLength(2);
		expect(slices[0]).toHaveLength(5); // a, x, backspace, b, space
		expect(slices[1]).toHaveLength(2);
	});

	it('returns no empty trailing slice when the log ends exactly at a word boundary', () => {
		const log = typeLog('ab cd', 'ab ');
		const slices = wordSlices(log);
		expect(slices).toHaveLength(1);
	});

	it('returns an empty list for an empty log', () => {
		expect(wordSlices([])).toEqual([]);
	});
});

describe('computeMetrics — same function over word, chunk, and session slices', () => {
	it('evaluates a single word slice', () => {
		const log = typeLog('ab cd', 'ab cd', 0, 100);
		const firstWord = wordSlices(log)[0];
		const metrics = computeMetrics(firstWord);
		expect(metrics.typedChars).toBe(3);
		expect(metrics.accuracyRaw).toBe(1);
		expect(metrics.elapsedMs).toBe(200);
	});

	it('evaluates a whole chunk slice', () => {
		const log = typeLog('ab cd', 'ab cd', 0, 100);
		const metrics = computeMetrics(log);
		expect(metrics.typedChars).toBe(5);
		expect(metrics.elapsedMs).toBe(400);
	});

	it('evaluates a session aggregate as the concatenation of chunk logs', () => {
		const chunkA = typeLog('ab', 'ab', 0, 100); // 2 hits
		const chunkB = typeLog('cd', 'xd', 10_000, 100); // 1 miss, 1 hit
		const metrics = computeMetrics([...chunkA, ...chunkB]);
		expect(metrics.typedChars).toBe(4);
		expect(metrics.accuracyRaw).toBeCloseTo(0.75, 5);
	});
});
