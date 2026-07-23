import { describe, expect, it } from 'vitest';
import { createSession, applySessionEvent, sessionSummary } from './session.js';
import { createChunk } from './chunk.js';
import type { SessionEvent, SessionState } from './session.js';
import type { TypeableText } from '../types.js';

function makeText(contents: readonly string[]): TypeableText {
	return {
		id: 'text-1',
		title: 'Test text',
		author: 'Test author',
		language: 'en',
		chunkCount: contents.length,
		chunks: contents.map((content, index) => ({
			id: `chunk-${index}`,
			textId: 'text-1',
			index,
			content,
			charCount: Array.from(content).length
		}))
	};
}

function run(state: SessionState, events: readonly SessionEvent[]): SessionState {
	return events.reduce((s, e) => applySessionEvent(s, e), state);
}

/** Chunk 1 'abcd': one mistype fixed (accuracy 3/4), 5 typed chars over 6s → 10 WPM. */
const CHUNK_ONE_EVENTS: readonly SessionEvent[] = [
	{ type: 'char', char: 'a', timestamp: 0 },
	{ type: 'char', char: 'x', timestamp: 1000 },
	{ type: 'backspace', timestamp: 2000 },
	{ type: 'char', char: 'b', timestamp: 3000 },
	{ type: 'char', char: 'c', timestamp: 4000 },
	{ type: 'char', char: 'd', timestamp: 6000 }
];

/** Chunk 2 'ef': perfect, 2 typed chars over 3s → 8 WPM. Starts after a long idle gap. */
const CHUNK_TWO_EVENTS: readonly SessionEvent[] = [
	{ type: 'char', char: 'e', timestamp: 100_000 },
	{ type: 'char', char: 'f', timestamp: 103_000 }
];

describe('createSession', () => {
	it('starts at chunk 0 with a fresh engine state and no results', () => {
		const state = createSession(makeText(['abcd', 'ef']));
		expect(state.activeIndex).toBe(0);
		expect(state.activeChunk).toEqual(createChunk('abcd'));
		expect(state.results).toEqual([null, null]);
		expect(state.finished).toBe(false);
	});
});

describe('applySessionEvent — forwarding and auto-advance', () => {
	it('forwards char and backspace events to the active chunk', () => {
		const state = applySessionEvent(createSession(makeText(['abcd', 'ef'])), {
			type: 'char',
			char: 'a',
			timestamp: 0
		});
		expect(state.activeChunk.cursor).toBe(1);
		expect(state.activeChunk.display[0]).toBe('correct');
	});

	it('freezes the chunk result and auto-advances when the active chunk completes', () => {
		const state = run(createSession(makeText(['abcd', 'ef'])), CHUNK_ONE_EVENTS);
		expect(state.activeIndex).toBe(1);
		expect(state.activeChunk).toEqual(createChunk('ef'));
		expect(state.finished).toBe(false);
		expect(state.results[0]).toEqual({
			grossWpm: 10,
			accuracyRaw: 0.75,
			elapsedMs: 6000
		});
	});

	it('keeps frozen results untouched by later chunk activity', () => {
		const advanced = run(createSession(makeText(['abcd', 'ef'])), CHUNK_ONE_EVENTS);
		const frozen = advanced.results[0];
		const later = run(advanced, [{ type: 'char', char: 'x', timestamp: 100_000 }]);
		expect(later.results[0]).toEqual(frozen);
	});

	it('marks the session finished after the last chunk completes', () => {
		const state = run(createSession(makeText(['abcd', 'ef'])), [
			...CHUNK_ONE_EVENTS,
			...CHUNK_TWO_EVENTS
		]);
		expect(state.finished).toBe(true);
		expect(state.results[1]).toEqual({ grossWpm: 8, accuracyRaw: 1, elapsedMs: 3000 });
	});

	it('ignores typing events once the session is finished', () => {
		const finished = run(createSession(makeText(['abcd', 'ef'])), [
			...CHUNK_ONE_EVENTS,
			...CHUNK_TWO_EVENTS
		]);
		const after = applySessionEvent(finished, { type: 'char', char: 'z', timestamp: 200_000 });
		expect(after).toEqual(finished);
	});
});

describe('applySessionEvent — restart semantics', () => {
	it('restart-chunk discards the active chunk log, records, and timer', () => {
		const midway = run(createSession(makeText(['abcd', 'ef'])), [
			{ type: 'char', char: 'a', timestamp: 0 },
			{ type: 'char', char: 'x', timestamp: 1000 }
		]);
		const state = applySessionEvent(midway, { type: 'restart-chunk' });
		expect(state.activeChunk).toEqual(createChunk('abcd'));
		expect(state.activeIndex).toBe(0);
	});

	it('restarts the chunk timer on the next keystroke after restart-chunk', () => {
		const state = run(createSession(makeText(['abcd', 'ef'])), [
			{ type: 'char', char: 'a', timestamp: 0 },
			{ type: 'restart-chunk' },
			{ type: 'char', char: 'a', timestamp: 50_000 }
		]);
		expect(state.activeChunk.startedAt).toBe(50_000);
	});

	it('restart-session resets every chunk and returns to chunk 0', () => {
		const text = makeText(['abcd', 'ef']);
		const midSecondChunk = run(createSession(text), [
			...CHUNK_ONE_EVENTS,
			{ type: 'char', char: 'e', timestamp: 100_000 }
		]);
		const state = applySessionEvent(midSecondChunk, { type: 'restart-session' });
		expect(state).toEqual(createSession(text));
	});

	it('restart-chunk after the session finished clears finished and yields a typeable chunk', () => {
		const finished = run(createSession(makeText(['ab'])), [
			{ type: 'char', char: 'a', timestamp: 0 },
			{ type: 'char', char: 'b', timestamp: 1000 }
		]);
		expect(finished.finished).toBe(true);

		const restarted = applySessionEvent(finished, { type: 'restart-chunk' });
		expect(restarted.finished).toBe(false);
		expect(restarted.activeChunk).toEqual(createChunk('ab'));

		// A keystroke is no longer ignored — the reset chunk accepts input again.
		const typed = applySessionEvent(restarted, { type: 'char', char: 'a', timestamp: 5000 });
		expect(typed.activeChunk.cursor).toBe(1);
	});
});

describe('sessionSummary', () => {
	it('returns zeroed aggregates before any chunk completes', () => {
		const state = createSession(makeText(['abcd', 'ef']));
		expect(sessionSummary(state)).toEqual({
			averageWpm: 0,
			overallAccuracy: 0,
			chunksCompleted: 0,
			totalActiveMs: 0
		});
	});

	it('aggregates average WPM, overall accuracy, chunks completed, and total active time', () => {
		const state = run(createSession(makeText(['abcd', 'ef'])), [
			...CHUNK_ONE_EVENTS,
			...CHUNK_TWO_EVENTS
		]);
		const summary = sessionSummary(state);
		expect(summary.averageWpm).toBeCloseTo(9, 5); // mean of 10 and 8
		// Aggregate first-attempt hits ÷ entries: (3 + 2) ÷ (4 + 2) — weighted, not a mean of ratios.
		expect(summary.overallAccuracy).toBeCloseTo(5 / 6, 5);
		expect(summary.chunksCompleted).toBe(2);
		expect(summary.totalActiveMs).toBe(9000); // 6000 + 3000 — idle gap between chunks excluded
	});

	it('aggregates only the chunks completed so far mid-session', () => {
		const state = run(createSession(makeText(['abcd', 'ef'])), [
			...CHUNK_ONE_EVENTS,
			{ type: 'char', char: 'e', timestamp: 100_000 }
		]);
		const summary = sessionSummary(state);
		expect(summary.chunksCompleted).toBe(1);
		expect(summary.averageWpm).toBeCloseTo(10, 5);
		expect(summary.totalActiveMs).toBe(6000);
	});
});
