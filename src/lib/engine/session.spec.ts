import { describe, expect, it } from 'vitest';
import {
	createSession,
	applySessionEvent,
	loadedChunks,
	sessionSummary,
	runningLog,
	runningMetrics
} from './session.js';
import { createChunk, applyChunkEvent } from './chunk.js';
import { computeMetrics } from './metrics.js';
import type { SessionEvent, SessionState } from './session.js';
import type { ChunkEvent, Keystroke, LoadedChunks } from './types.js';
import type { Chunk } from '../types.js';

/** One chunk at an ABSOLUTE index — the only index the engine ever speaks. */
function chunkAt(index: number, content: string): Chunk {
	return {
		id: `chunk-${index}`,
		textId: 'text-1',
		index,
		content,
		charCount: Array.from(content).length
	};
}

/**
 * A text of `chunkCount` chunks with only `loaded` in hand, keyed by ABSOLUTE index.
 * This is the windowed shape: `chunkCount` is `books.chunk_count`, never how much is loaded.
 */
function makeText(loaded: Readonly<Record<number, string>>, chunkCount: number): LoadedChunks {
	return loadedChunks(
		Object.entries(loaded).map(([index, content]) => chunkAt(Number(index), content)),
		chunkCount
	);
}

/** A fully loaded text at indices 0..n-1 — the pre-windowing shape, still legal. */
function makeFullText(contents: readonly string[]): LoadedChunks {
	return loadedChunks(
		contents.map((content, index) => chunkAt(index, content)),
		contents.length
	);
}

function run(state: SessionState, events: readonly SessionEvent[]): SessionState {
	return events.reduce((s, e) => applySessionEvent(s, e), state);
}

/** The keystroke log a chunk produces on its own — an expected value built without session.ts. */
function chunkLog(content: string, events: readonly SessionEvent[]): readonly Keystroke[] {
	let state = createChunk(content);
	for (const event of events) {
		state = applyChunkEvent(state, event as ChunkEvent);
	}
	return state.log;
}

/** Shifts every timestamped event by `by` ms, leaving restart events alone. */
function shift(events: readonly SessionEvent[], by: number): SessionEvent[] {
	return events.map((event) =>
		'timestamp' in event ? { ...event, timestamp: event.timestamp + by } : event
	);
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

describe('loadedChunks', () => {
	it('keys chunks by their absolute index, not by array position', () => {
		const text = loadedChunks([chunkAt(9, 'abcd'), chunkAt(10, 'ef')], 11);
		expect(text.chunkCount).toBe(11);
		expect(text.chunks.get(9)?.content).toBe('abcd');
		expect(text.chunks.get(10)?.content).toBe('ef');
		expect(text.chunks.get(0)).toBeUndefined();
		expect(text.chunks.size).toBe(2);
	});

	it('carries books.chunk_count, never "how much is loaded"', () => {
		expect(loadedChunks([chunkAt(0, 'a')], 2000).chunkCount).toBe(2000);
	});
});

describe('createSession', () => {
	it('starts at chunk 0 with a fresh engine state, no results, and status active', () => {
		const state = createSession(makeFullText(['abcd', 'ef']));
		expect(state.activeIndex).toBe(0);
		expect(state.activeChunk).toEqual(createChunk('abcd'));
		expect(state.results.size).toBe(0);
		expect(state.status).toBe('active');
		expect(state.completedLog).toEqual([]);
		expect(state.openingIndex).toBe(0);
		expect(state.awaitingSince).toBeNull();
		expect(state.awaitingMs).toBe(0);
	});

	it('opens at the given startIndex without fabricating results for earlier chunks', () => {
		const state = createSession(makeFullText(['abcd', 'ef', 'gh', 'ij']), 2);
		expect(state.activeIndex).toBe(2);
		expect(state.activeChunk).toEqual(createChunk('gh'));
		expect(state.results.size).toBe(0);
		expect(state.completedLog).toEqual([]);
		expect(state.status).toBe('active');
	});

	it('records the opening index — what restart-session returns to', () => {
		expect(createSession(makeFullText(['a', 'b', 'c']), 2).openingIndex).toBe(2);
	});

	it('opens a resumed session mid-book on the window it was handed', () => {
		// Passage 900 of a 2,000-chunk book: the window starts AT the resume index.
		const state = createSession(makeText({ 899: 'abcd', 900: 'ef' }, 2000), 899);
		expect(state.status).toBe('active');
		expect(state.activeIndex).toBe(899);
		expect(state.activeChunk).toEqual(createChunk('abcd'));
		expect(state.openingIndex).toBe(899);
	});

	it('clamps a startIndex beyond the last chunk to the last chunk', () => {
		const state = createSession(makeFullText(['abcd', 'ef']), 99);
		expect(state.activeIndex).toBe(1);
		expect(state.activeChunk).toEqual(createChunk('ef'));
	});

	it('clamps a negative startIndex to 0', () => {
		const state = createSession(makeFullText(['abcd', 'ef']), -3);
		expect(state.activeIndex).toBe(0);
		expect(state.activeChunk).toEqual(createChunk('abcd'));
	});

	it('floors a fractional startIndex and falls back to 0 for NaN', () => {
		expect(createSession(makeFullText(['abcd', 'ef', 'gh']), 1.9).activeIndex).toBe(1);
		expect(createSession(makeFullText(['abcd', 'ef', 'gh']), Number.NaN).activeIndex).toBe(0);
		expect(createSession(makeFullText(['abcd', 'ef', 'gh']), undefined).activeIndex).toBe(0);
	});

	it('opens awaiting, not broken, when the opening chunk is not in hand', () => {
		// Defensive: the loader always supplies the window starting at startIndex, but a
		// mismatch must degrade to "waiting for text", never to a null dereference.
		const state = createSession(makeText({ 5: 'abcd' }, 10), 3);
		expect(state.status).toBe('awaiting');
		expect(state.activeChunk).toBeNull();
		expect(state.activeIndex).toBe(3);
		// No clock is available in createSession, so no dead time can be attributed.
		expect(state.awaitingSince).toBeNull();
		expect(state.awaitingMs).toBe(0);
	});

	it('opens awaiting for an empty text rather than throwing', () => {
		const state = createSession(loadedChunks([], 0));
		expect(state.status).toBe('awaiting');
		expect(state.activeChunk).toBeNull();
		expect(state.activeIndex).toBe(0);
	});
});

describe('applySessionEvent — forwarding and auto-advance', () => {
	it('forwards char and backspace events to the active chunk', () => {
		const state = applySessionEvent(createSession(makeFullText(['abcd', 'ef'])), {
			type: 'char',
			char: 'a',
			timestamp: 0
		});
		expect(state.activeChunk?.cursor).toBe(1);
		expect(state.activeChunk?.display[0]).toBe('correct');
	});

	it('freezes the chunk result and auto-advances when the active chunk completes', () => {
		const state = run(createSession(makeFullText(['abcd', 'ef'])), CHUNK_ONE_EVENTS);
		expect(state.activeIndex).toBe(1);
		expect(state.activeChunk).toEqual(createChunk('ef'));
		expect(state.status).toBe('active');
		expect(state.results.get(0)).toEqual({
			grossWpm: 10,
			accuracyRaw: 0.75,
			elapsedMs: 6000,
			// A fully-Normal traversal (spec #24): the span covers the whole wall clock and
			// every stroke, and the row is clean. These three fields are the ONLY change to
			// this pre-4a expectation — the figures themselves are byte-identical.
			measuredMs: 6000,
			measuredChars: 5,
			mode: 'normal'
		});
	});

	it('keeps frozen results untouched by later chunk activity', () => {
		const advanced = run(createSession(makeFullText(['abcd', 'ef'])), CHUNK_ONE_EVENTS);
		const frozen = advanced.results.get(0);
		const later = run(advanced, [{ type: 'char', char: 'x', timestamp: 100_000 }]);
		expect(later.results.get(0)).toEqual(frozen);
	});

	it('marks the session finished after the last chunk completes', () => {
		const state = run(createSession(makeFullText(['abcd', 'ef'])), [
			...CHUNK_ONE_EVENTS,
			...CHUNK_TWO_EVENTS
		]);
		expect(state.status).toBe('finished');
		expect(state.results.get(1)).toEqual({
			grossWpm: 8,
			accuracyRaw: 1,
			elapsedMs: 3000,
			measuredMs: 3000,
			measuredChars: 2,
			mode: 'normal'
		});
	});

	it('ignores typing events once the session is finished', () => {
		const finished = run(createSession(makeFullText(['abcd', 'ef'])), [
			...CHUNK_ONE_EVENTS,
			...CHUNK_TWO_EVENTS
		]);
		const after = applySessionEvent(finished, { type: 'char', char: 'z', timestamp: 200_000 });
		expect(after).toBe(finished);
	});
});

describe('applySessionEvent — awaiting (spec #18)', () => {
	/** Chunk 0 in hand, chunk 1 exists but has not arrived. */
	const windowOne = makeText({ 0: 'abcd' }, 2);

	it('enters awaiting when advancing into an index that is not loaded', () => {
		const state = run(createSession(windowOne), CHUNK_ONE_EVENTS);
		expect(state.status).toBe('awaiting');
		expect(state.activeIndex).toBe(1);
		expect(state.activeChunk).toBeNull();
		// The completed chunk was left behind exactly as a normal advance leaves it.
		expect(state.completedLog).toEqual(chunkLog('abcd', CHUNK_ONE_EVENTS));
		expect(state.results.get(0)?.grossWpm).toBe(10);
	});

	it('stamps awaitingSince with the completion event timestamp, never a clock', () => {
		const state = run(createSession(windowOne), CHUNK_ONE_EVENTS);
		expect(state.awaitingSince).toBe(6000);
		expect(state.awaitingMs).toBe(0);
	});

	it('resolves to active when the awaited chunk arrives', () => {
		const awaiting = run(createSession(windowOne), CHUNK_ONE_EVENTS);
		const state = applySessionEvent(awaiting, {
			type: 'window-loaded',
			chunks: [chunkAt(1, 'ef')],
			chunkCount: 2,
			timestamp: 96_000
		});
		expect(state.status).toBe('active');
		expect(state.activeIndex).toBe(1);
		expect(state.activeChunk).toEqual(createChunk('ef'));
		expect(state.awaitingSince).toBeNull();
		expect(state.awaitingMs).toBe(90_000);
	});

	it('accumulates awaitingMs across several waits', () => {
		let state = run(createSession(makeText({ 0: 'ab' }, 3)), [
			{ type: 'char', char: 'a', timestamp: 0 },
			{ type: 'char', char: 'b', timestamp: 1000 }
		]);
		expect(state.status).toBe('awaiting');
		state = applySessionEvent(state, {
			type: 'window-loaded',
			chunks: [chunkAt(1, 'cd')],
			chunkCount: 3,
			timestamp: 6000
		});
		state = run(state, [
			{ type: 'char', char: 'c', timestamp: 7000 },
			{ type: 'char', char: 'd', timestamp: 8000 }
		]);
		expect(state.status).toBe('awaiting');
		state = applySessionEvent(state, {
			type: 'window-loaded',
			chunks: [chunkAt(2, 'ef')],
			chunkCount: 3,
			timestamp: 20_000
		});
		expect(state.awaitingMs).toBe(5000 + 12_000);
		expect(state.status).toBe('active');
	});

	it('ignores keystrokes while awaiting, changing no metric and buffering nothing', () => {
		const awaiting = run(createSession(windowOne), CHUNK_ONE_EVENTS);
		const after = run(awaiting, [
			{ type: 'char', char: 'e', timestamp: 10_000 },
			{ type: 'backspace', timestamp: 11_000 },
			{ type: 'char', char: 'f', timestamp: 12_000 }
		]);
		expect(after).toBe(awaiting);
		expect(runningLog(after)).toEqual(runningLog(awaiting));
		expect(runningMetrics(after)).toEqual(runningMetrics(awaiting));

		// And nothing leaked into the chunk that eventually arrives.
		const resumed = applySessionEvent(after, {
			type: 'window-loaded',
			chunks: [chunkAt(1, 'ef')],
			chunkCount: 2,
			timestamp: 13_000
		});
		expect(resumed.activeChunk).toEqual(createChunk('ef'));
	});

	it('merges a prefetched window with zero cost while still active', () => {
		const active = run(createSession(makeText({ 0: 'abcd' }, 3)), [
			{ type: 'char', char: 'a', timestamp: 0 }
		]);
		const merged = applySessionEvent(active, {
			type: 'window-loaded',
			chunks: [chunkAt(1, 'ef'), chunkAt(2, 'gh')],
			chunkCount: 3,
			timestamp: 5000
		});
		expect(merged.status).toBe('active');
		expect(merged.activeIndex).toBe(0);
		expect(merged.activeChunk).toBe(active.activeChunk); // untouched, not recreated
		expect(merged.awaitingMs).toBe(0);
		expect(merged.text.chunks.get(2)?.content).toBe('gh');
	});

	it('merges without mutating the state it was given — the reducer stays pure', () => {
		const active = createSession(makeText({ 0: 'abcd' }, 3));
		applySessionEvent(active, {
			type: 'window-loaded',
			chunks: [chunkAt(1, 'ef')],
			chunkCount: 3,
			timestamp: 5000
		});
		expect(active.text.chunks.size).toBe(1);
		expect(active.text.chunks.has(1)).toBe(false);
	});

	it('adopts the authoritative chunkCount when a re-ingest grew the book', () => {
		const state = applySessionEvent(createSession(makeText({ 0: 'abcd' }, 2)), {
			type: 'window-loaded',
			chunks: [chunkAt(1, 'ef')],
			chunkCount: 40,
			timestamp: 1000
		});
		expect(state.text.chunkCount).toBe(40);
	});

	it('finishes rather than hanging when the adopted chunkCount no longer covers the wait', () => {
		// A shrinking re-ingest, or a stale books.chunk_count: the awaited chunk will never
		// exist, so the session ends with a summary instead of waiting forever.
		const awaiting = run(createSession(makeText({ 0: 'abcd' }, 2)), CHUNK_ONE_EVENTS);
		expect(awaiting.status).toBe('awaiting');
		const state = applySessionEvent(awaiting, {
			type: 'window-loaded',
			chunks: [],
			chunkCount: 1,
			timestamp: 20_000
		});
		expect(state.status).toBe('finished');
		expect(state.activeChunk).toBeNull();
		expect(state.awaitingSince).toBeNull();
		expect(state.awaitingMs).toBe(14_000);
		expect(sessionSummary(state).chunksCompleted).toBe(1);
	});

	it('keeps awaiting when the arriving window does not contain the awaited index', () => {
		const awaiting = run(createSession(makeText({ 0: 'abcd' }, 5)), CHUNK_ONE_EVENTS);
		const state = applySessionEvent(awaiting, {
			type: 'window-loaded',
			chunks: [chunkAt(3, 'gh'), chunkAt(4, 'ij')],
			chunkCount: 5,
			timestamp: 20_000
		});
		expect(state.status).toBe('awaiting');
		expect(state.awaitingSince).toBe(6000); // the wait is still open, not restarted
		expect(state.awaitingMs).toBe(0);
		expect(state.text.chunks.get(3)?.content).toBe('gh');
	});

	it('never enters awaiting on the last chunk — chunkCount is checked first', () => {
		// Only chunk 1 is in hand and the map holds nothing beyond it, but the book is 2
		// chunks long, so completing chunk 1 finishes rather than awaiting chunk 2.
		const state = run(createSession(makeText({ 0: 'abcd', 1: 'ef' }, 2)), [
			...CHUNK_ONE_EVENTS,
			...CHUNK_TWO_EVENTS
		]);
		expect(state.status).toBe('finished');
		expect(state.awaitingSince).toBeNull();
		expect(state.awaitingMs).toBe(0);
	});

	it('never enters awaiting for a book shorter than one window', () => {
		// The 3-chunk fixture: one window covers it, so no completion can miss the map.
		let state = createSession(makeFullText(['ab', 'cd', 'ef']));
		const pairs = [
			['a', 'b'],
			['c', 'd'],
			['e', 'f']
		];
		let t = 0;
		for (const [first, second] of pairs) {
			state = run(state, [
				{ type: 'char', char: first, timestamp: (t += 1000) },
				{ type: 'char', char: second, timestamp: (t += 1000) }
			]);
			expect(state.status).not.toBe('awaiting');
		}
		expect(state.status).toBe('finished');
		expect(state.awaitingMs).toBe(0);
	});

	it('ignores a window-loaded event once the session is finished', () => {
		const finished = run(createSession(makeFullText(['abcd', 'ef'])), [
			...CHUNK_ONE_EVENTS,
			...CHUNK_TWO_EVENTS
		]);
		const after = applySessionEvent(finished, {
			type: 'window-loaded',
			chunks: [chunkAt(2, 'gh')],
			chunkCount: 3,
			timestamp: 200_000
		});
		expect(after.status).toBe('finished');
		expect(after.activeIndex).toBe(1);
	});
});

describe('awaiting time is excluded from elapsed and WPM (spec #18)', () => {
	/**
	 * The invariant that justified NOT re-creating the session per window: a session typing
	 * chunks 9 and 10 across two windows must report the same averageWpm as one with both
	 * chunks preloaded. Only the wait differs between the two timelines.
	 */
	const CHUNK_TWO_RELATIVE: readonly SessionEvent[] = [
		{ type: 'char', char: 'e', timestamp: 10_000 },
		{ type: 'char', char: 'f', timestamp: 13_000 }
	];
	const WAIT_MS = 90_000;

	function preloaded(): SessionState {
		const text = makeText({ 9: 'abcd', 10: 'ef' }, 11);
		return run(createSession(text, 9), [...CHUNK_ONE_EVENTS, ...CHUNK_TWO_RELATIVE]);
	}

	function windowed(): SessionState {
		const text = makeText({ 9: 'abcd' }, 11);
		const awaiting = run(createSession(text, 9), CHUNK_ONE_EVENTS);
		const resumed = applySessionEvent(awaiting, {
			type: 'window-loaded',
			chunks: [chunkAt(10, 'ef')],
			chunkCount: 11,
			timestamp: 6000 + WAIT_MS
		});
		return run(resumed, shift(CHUNK_TWO_RELATIVE, WAIT_MS));
	}

	it('produces the identical keystroke log either way', () => {
		expect(windowed().completedLog).toEqual(preloaded().completedLog);
		expect(runningLog(windowed())).toHaveLength(runningLog(preloaded()).length);
	});

	it('accounts exactly the wait and nothing else', () => {
		expect(windowed().awaitingMs).toBe(WAIT_MS);
		expect(preloaded().awaitingMs).toBe(0);
	});

	it('reports the same elapsedMs across a window boundary as with both chunks preloaded', () => {
		expect(runningMetrics(windowed()).elapsedMs).toBe(runningMetrics(preloaded()).elapsedMs);
		expect(runningMetrics(windowed()).elapsedMs).toBe(13_000);
	});

	it('reports the same averageWpm across a window boundary as with both chunks preloaded', () => {
		// Both sessions are fully Normal, so `averageWpm` is non-null on both sides — the
		// assertion is unchanged, only narrowed for the nullable type (spec #24).
		const expected = sessionSummary(preloaded()).averageWpm;
		expect(expected).not.toBeNull();
		expect(sessionSummary(windowed()).averageWpm).toBeCloseTo(expected!, 10);
		expect(sessionSummary(windowed()).averageWpm).toBeCloseTo(7 / 5 / (13_000 / 60_000), 5);
	});

	it('reports the same accuracy and total active time — neither has a time gap in it', () => {
		expect(sessionSummary(windowed())).toEqual(sessionSummary(preloaded()));
	});

	it('leaves per-attempt ChunkResults bit-identical — awaiting is strictly BETWEEN chunks', () => {
		// chunk_attempts payloads (ADR-0010, ADR-0012) must not move because of this feature.
		expect(windowed().results.get(9)).toEqual(preloaded().results.get(9));
		expect(windowed().results.get(10)).toEqual(preloaded().results.get(10));
		expect(windowed().results.get(9)).toEqual({
			grossWpm: 10,
			accuracyRaw: 0.75,
			elapsedMs: 6000,
			// The wait falls strictly BETWEEN traversals, so it reaches neither span field.
			measuredMs: 6000,
			measuredChars: 5,
			mode: 'normal'
		});
	});

	it('does not let live metrics tick while the session is still awaiting', () => {
		const awaiting = run(createSession(makeText({ 9: 'abcd' }, 11), 9), CHUNK_ONE_EVENTS);
		// The open wait is discounted too, so a UI polling live metrics during a slow
		// window fetch does not watch WPM decay for a reason that is not the typist's.
		expect(runningMetrics(awaiting, 6000).elapsedMs).toBe(6000);
		expect(runningMetrics(awaiting, 66_000).elapsedMs).toBe(6000);
		expect(runningMetrics(awaiting, 66_000).grossWpm).toBe(runningMetrics(awaiting, 6000).grossWpm);
	});
});

describe('absolute indices survive windowing (spec #18)', () => {
	it('reports the correct passage number and chunk id for a completion in the second window', () => {
		const awaiting = run(createSession(makeText({ 9: 'abcd' }, 11), 9), CHUNK_ONE_EVENTS);
		const resumed = applySessionEvent(awaiting, {
			type: 'window-loaded',
			chunks: [chunkAt(10, 'ef')],
			chunkCount: 11,
			timestamp: 50_000
		});
		const state = run(resumed, shift(CHUNK_TWO_EVENTS, 0));

		// The meta line reads activeIndex + 1 — passage 11 of 11, not passage 2 of 2.
		expect(state.activeIndex).toBe(10);
		expect(state.activeIndex + 1).toBe(11);
		// The chunk_attempts write reads the id out of the engine's own map.
		expect(state.text.chunks.get(state.activeIndex)?.id).toBe('chunk-10');
		expect(state.results.has(10)).toBe(true);
		expect(state.results.has(0)).toBe(false);
		expect(state.results.has(1)).toBe(false);
	});

	it('freezes results at absolute indices, so a completion is never attributed to chunk 0', () => {
		const state = run(createSession(makeText({ 899: 'abcd', 900: 'ef' }, 2000), 899), [
			...CHUNK_ONE_EVENTS
		]);
		expect([...state.results.keys()]).toEqual([899]);
		expect(state.activeIndex).toBe(900);
		expect(state.status).toBe('active');
	});
});

describe('applySessionEvent — restart semantics', () => {
	it('restart-chunk discards the active chunk log, records, and timer', () => {
		const midway = run(createSession(makeFullText(['abcd', 'ef'])), [
			{ type: 'char', char: 'a', timestamp: 0 },
			{ type: 'char', char: 'x', timestamp: 1000 }
		]);
		const state = applySessionEvent(midway, { type: 'restart-chunk' });
		expect(state.activeChunk).toEqual(createChunk('abcd'));
		expect(state.activeIndex).toBe(0);
	});

	it('restarts the chunk timer on the next keystroke after restart-chunk', () => {
		const state = run(createSession(makeFullText(['abcd', 'ef'])), [
			{ type: 'char', char: 'a', timestamp: 0 },
			{ type: 'restart-chunk' },
			{ type: 'char', char: 'a', timestamp: 50_000 }
		]);
		expect(state.activeChunk?.startedAt).toBe(50_000);
	});

	it('restart-session returns to the opening index, not to chunk 0', () => {
		// With windows, restarting at 0 would drop a session resumed at passage 900 into
		// awaiting for a window nothing is going to request.
		const text = makeText({ 899: 'abcd', 900: 'ef' }, 2000);
		const midSecondChunk = run(createSession(text, 899), [
			...CHUNK_ONE_EVENTS,
			{ type: 'char', char: 'e', timestamp: 100_000 }
		]);
		const state = applySessionEvent(midSecondChunk, { type: 'restart-session' });
		expect(state.activeIndex).toBe(899);
		expect(state.status).toBe('active');
		expect(state.results.size).toBe(0);
		expect(state.completedLog).toEqual([]);
		expect(state.awaitingMs).toBe(0);
		expect(state.openingIndex).toBe(899);
	});

	it('restart-session keeps every chunk loaded so far, so the restart never awaits', () => {
		const awaiting = run(createSession(makeText({ 0: 'abcd' }, 2)), CHUNK_ONE_EVENTS);
		const resumed = applySessionEvent(awaiting, {
			type: 'window-loaded',
			chunks: [chunkAt(1, 'ef')],
			chunkCount: 2,
			timestamp: 10_000
		});
		const state = applySessionEvent(resumed, { type: 'restart-session' });
		expect(state.status).toBe('active');
		expect(state.text.chunks.size).toBe(2);
	});

	/**
	 * The completed set is the ONE thing a restart carries, for the reason `mode` is the other:
	 * both are facts about the user rather than accumulators of this session's activity, and
	 * nothing un-completes a page (spec #50 §6). Every other field resets.
	 */
	it('restart-session from a session opened at 0 is a fresh session that remembers what was completed', () => {
		const text = makeFullText(['abcd', 'ef']);
		const midSecondChunk = run(createSession(text), [
			...CHUNK_ONE_EVENTS,
			{ type: 'char', char: 'e', timestamp: 100_000 }
		]);
		expect(applySessionEvent(midSecondChunk, { type: 'restart-session' })).toEqual(
			createSession(text, 0, 'normal', new Set([text.chunks.get(0)!.id]))
		);
	});

	it('restart-chunk after the session finished clears finished and yields a typeable chunk', () => {
		const finished = run(createSession(makeFullText(['ab'])), [
			{ type: 'char', char: 'a', timestamp: 0 },
			{ type: 'char', char: 'b', timestamp: 1000 }
		]);
		expect(finished.status).toBe('finished');

		const restarted = applySessionEvent(finished, { type: 'restart-chunk' });
		expect(restarted.status).toBe('active');
		expect(restarted.activeChunk).toEqual(createChunk('ab'));

		// A keystroke is no longer ignored — the reset chunk accepts input again.
		const typed = applySessionEvent(restarted, { type: 'char', char: 'a', timestamp: 5000 });
		expect(typed.activeChunk?.cursor).toBe(1);
	});

	it('restart-chunk while awaiting is a no-op — there is no chunk to restart', () => {
		const awaiting = run(createSession(makeText({ 0: 'abcd' }, 2)), CHUNK_ONE_EVENTS);
		expect(applySessionEvent(awaiting, { type: 'restart-chunk' })).toBe(awaiting);
	});
});

describe('runningLog / runningMetrics — cumulative across passages', () => {
	const LOG_ONE = chunkLog('abcd', CHUNK_ONE_EVENTS);
	const LOG_TWO = chunkLog('ef', CHUNK_TWO_EVENTS);

	it('is empty for a fresh session', () => {
		const state = createSession(makeFullText(['abcd', 'ef']));
		expect(runningLog(state)).toEqual([]);
		expect(runningMetrics(state)).toEqual(computeMetrics([]));
	});

	it('is the completed log alone while awaiting — there is no active chunk to add', () => {
		const awaiting = run(createSession(makeText({ 0: 'abcd' }, 2)), CHUNK_ONE_EVENTS);
		expect(runningLog(awaiting)).toEqual(LOG_ONE);
	});

	it('concatenates the completed chunks and the active chunk in completion order', () => {
		const state = run(createSession(makeFullText(['abcd', 'ef'])), [
			...CHUNK_ONE_EVENTS,
			{ type: 'char', char: 'e', timestamp: 100_000 }
		]);
		expect(state.completedLog).toEqual(LOG_ONE);
		expect(runningLog(state)).toEqual([...LOG_ONE, ...(state.activeChunk?.log ?? [])]);
	});

	it('matches computeMetrics over the concatenated log across two passages', () => {
		const state = run(createSession(makeFullText(['abcd', 'ef'])), [
			...CHUNK_ONE_EVENTS,
			...CHUNK_TWO_EVENTS
		]);
		const expected = computeMetrics([...LOG_ONE, ...LOG_TWO]);
		expect(runningLog(state)).toEqual([...LOG_ONE, ...LOG_TWO]);
		expect(runningMetrics(state)).toEqual(expected);
		// The idle gap between passages is inside the span, by design (elapsed = 103s, not 9s).
		// A typist's own pause is not dead time; only awaiting is.
		expect(expected.elapsedMs).toBe(103_000);
		expect(expected.typedChars).toBe(7);
		expect(expected.accuracyRaw).toBeCloseTo(5 / 6, 5);
	});

	it('does not double-count the final passage once the session is finished', () => {
		const state = run(createSession(makeFullText(['abcd', 'ef'])), [
			...CHUNK_ONE_EVENTS,
			...CHUNK_TWO_EVENTS
		]);
		expect(state.status).toBe('finished');
		expect(runningLog(state)).toHaveLength(LOG_ONE.length + LOG_TWO.length);
		expect(runningMetrics(state).typedChars).toBe(7);
	});

	it('honours endTime for live metrics, exactly as computeMetrics does', () => {
		const state = run(createSession(makeFullText(['abcd', 'ef'])), [
			...CHUNK_ONE_EVENTS,
			{ type: 'char', char: 'e', timestamp: 100_000 }
		]);
		expect(runningMetrics(state, 130_000)).toEqual(computeMetrics(runningLog(state), 130_000));
		expect(runningMetrics(state, 130_000).elapsedMs).toBe(130_000);
	});

	it('restart-chunk drops the active passage strokes but keeps the completed ones', () => {
		const midSecond = run(createSession(makeFullText(['abcd', 'ef'])), [
			...CHUNK_ONE_EVENTS,
			{ type: 'char', char: 'e', timestamp: 100_000 }
		]);
		const state = applySessionEvent(midSecond, { type: 'restart-chunk' });
		expect(state.completedLog).toEqual(LOG_ONE);
		expect(runningLog(state)).toEqual(LOG_ONE);
	});

	it('restart-session clears the running log entirely', () => {
		const state = applySessionEvent(
			run(createSession(makeFullText(['abcd', 'ef'])), [
				...CHUNK_ONE_EVENTS,
				{ type: 'char', char: 'e', timestamp: 100_000 }
			]),
			{ type: 'restart-session' }
		);
		expect(state.completedLog).toEqual([]);
		expect(runningLog(state)).toEqual([]);
		expect(runningMetrics(state)).toEqual(computeMetrics([]));
	});
});

describe('sessionSummary', () => {
	it('returns zeroed aggregates before any chunk completes', () => {
		const state = createSession(makeFullText(['abcd', 'ef']));
		expect(sessionSummary(state)).toEqual({
			averageWpm: 0,
			overallAccuracy: 0,
			chunksCompleted: 0,
			totalActiveMs: 0
		});
	});

	it('reports cumulative WPM, overall accuracy, chunks completed, and total active time', () => {
		const state = run(createSession(makeFullText(['abcd', 'ef'])), [
			...CHUNK_ONE_EVENTS,
			...CHUNK_TWO_EVENTS
		]);
		const summary = sessionSummary(state);
		// Cumulative over the whole session log — no longer the mean of 10 and 8.
		expect(summary.averageWpm).toBe(runningMetrics(state).grossWpm);
		expect(summary.averageWpm).toBeCloseTo(7 / 5 / (103_000 / 60_000), 5);
		// Aggregate first-attempt hits ÷ entries: (3 + 2) ÷ (4 + 2) — weighted, not a mean of ratios.
		expect(summary.overallAccuracy).toBeCloseTo(5 / 6, 5);
		expect(summary.chunksCompleted).toBe(2);
		expect(summary.totalActiveMs).toBe(9000); // 6000 + 3000 — idle gap between chunks excluded
	});

	it('aggregates only the chunks completed so far mid-session', () => {
		const state = run(createSession(makeFullText(['abcd', 'ef'])), [
			...CHUNK_ONE_EVENTS,
			{ type: 'char', char: 'e', timestamp: 100_000 }
		]);
		const summary = sessionSummary(state);
		expect(summary.chunksCompleted).toBe(1);
		// Cumulative: the in-progress passage's stroke is inside the running log too.
		expect(summary.averageWpm).toBe(runningMetrics(state).grossWpm);
		expect(summary.averageWpm).toBeCloseTo(6 / 5 / (100_000 / 60_000), 5);
		expect(summary.totalActiveMs).toBe(6000); // unchanged: sum of per-chunk spans
	});

	it('weights accuracy by charCount over a SPARSE results map, not by array position', () => {
		// Chunks 9 and 10 of an 11-chunk book: the summary must find their charCounts by
		// absolute index, and must not treat the eight absent indices as anything at all.
		const awaiting = run(createSession(makeText({ 9: 'abcd' }, 11), 9), CHUNK_ONE_EVENTS);
		const resumed = applySessionEvent(awaiting, {
			type: 'window-loaded',
			chunks: [chunkAt(10, 'ef')],
			chunkCount: 11,
			timestamp: 50_000
		});
		const state = run(resumed, CHUNK_TWO_EVENTS);
		const summary = sessionSummary(state);
		expect(summary.chunksCompleted).toBe(2);
		expect(summary.overallAccuracy).toBeCloseTo(5 / 6, 5); // (3 + 2) ÷ (4 + 2)
		expect(summary.totalActiveMs).toBe(9000);
	});
});

// ---------------------------------------------------------------------------------------
// Mode: the measurement axis (spec #24)
// ---------------------------------------------------------------------------------------

/** 'abcd' typed cleanly at 0/1000/2000/3000 — 4 chars, 3000 ms, no correction. */
const CLEAN_FOUR: readonly SessionEvent[] = [
	{ type: 'char', char: 'a', timestamp: 0 },
	{ type: 'char', char: 'b', timestamp: 1000 },
	{ type: 'char', char: 'c', timestamp: 2000 },
	{ type: 'char', char: 'd', timestamp: 3000 }
];

/*
 * The A' engine seek (spec #32 §10 D1, option A). A page navigator jumps the reader anywhere
 * in the book — page 12 to page 400 is a real case, not an edge case — and two things must be
 * true when it does: the window that arrives REPLACES what was loaded rather than accumulating
 * onto it forever (a book of thousands of pages cannot hold every window a reader ever visited),
 * and the jump CLOSES the current measured span rather than folding the dead navigation time
 * into the next stretch of typing's WPM. The session itself survives — `results` and
 * `completedLog` are untouched, exactly the "keeps the session alive" ruling.
 */
describe('applySessionEvent — seek (spec #32)', () => {
	it('is a no-op when seeking to the index the session is already at', () => {
		const state = run(createSession(makeText({ 0: 'abcd' }, 5)), [
			{ type: 'char', char: 'a', timestamp: 0 }
		]);
		const seeked = applySessionEvent(state, { type: 'seek', index: 0, timestamp: 9000 });
		expect(seeked).toBe(state);
	});

	describe('seeking to an already-loaded chunk', () => {
		function seek(): SessionState {
			const state = run(createSession(makeText({ 0: 'abcd', 3: 'wxyz' }, 5)), [
				{ type: 'char', char: 'a', timestamp: 0 },
				{ type: 'char', char: 'b', timestamp: 1000 }
			]);
			return applySessionEvent(state, { type: 'seek', index: 3, timestamp: 5000 });
		}

		it('moves to the target index with a fresh, untyped chunk', () => {
			const state = seek();
			expect(state.activeIndex).toBe(3);
			expect(state.status).toBe('active');
			expect(state.activeChunk).toEqual(createChunk('wxyz'));
		});

		it('keeps the honestly-typed keystrokes of the abandoned page in the running log', () => {
			const state = seek();
			expect(state.completedLog).toEqual([
				{
					kind: 'char',
					char: 'a',
					expected: 'a',
					position: 0,
					judgment: 'hit',
					firstAttempt: true,
					timestamp: 0,
					measured: true
				},
				{
					kind: 'char',
					char: 'b',
					expected: 'b',
					position: 1,
					judgment: 'hit',
					firstAttempt: true,
					timestamp: 1000,
					measured: true
				}
			]);
		});

		it('records NO result for the abandoned page — it was left incomplete, not finished', () => {
			expect(seek().results.has(0)).toBe(false);
		});

		it('keeps every already-completed result — the session stays alive, not restarted', () => {
			const state = run(createSession(makeText({ 0: 'ab', 1: 'cd', 4: 'zz' }, 5)), [
				{ type: 'char', char: 'a', timestamp: 0 },
				{ type: 'char', char: 'b', timestamp: 1000 } // completes chunk 0, advances to 1
			]);
			expect(state.results.has(0)).toBe(true);
			const seeked = applySessionEvent(state, { type: 'seek', index: 4, timestamp: 5000 });
			expect(seeked.results.get(0)).toEqual(state.results.get(0));
			expect(seeked.activeIndex).toBe(4);
		});
	});

	describe('seeking to a chunk that has not been loaded yet', () => {
		function seek(): SessionState {
			const state = run(createSession(makeText({ 0: 'abcd' }, 500)), [
				{ type: 'char', char: 'a', timestamp: 0 }
			]);
			return applySessionEvent(state, { type: 'seek', index: 400, timestamp: 5000 });
		}

		it('enters awaiting rather than throwing or ignoring the jump', () => {
			const state = seek();
			expect(state.status).toBe('awaiting');
			expect(state.activeIndex).toBe(400);
			expect(state.activeChunk).toBeNull();
			expect(state.awaitingSince).toBe(5000);
		});

		it('REPLACES the loaded window on arrival — chunk 0 is gone, not retained', () => {
			const state = applySessionEvent(seek(), {
				type: 'window-loaded',
				chunks: [chunkAt(400, 'far away')],
				chunkCount: 500,
				timestamp: 5200
			});
			expect(state.status).toBe('active');
			expect(state.text.chunks.has(0)).toBe(false);
			expect(state.text.chunks.get(400)?.content).toBe('far away');
			expect(state.text.chunks.size).toBe(1);
		});

		/*
		 * Regression guard: an ORDINARY awaiting — running out of loaded chunks by typing
		 * forward, never a seek — must keep MERGING exactly as before. Replacing is a seek-only
		 * behaviour, or windowed reading would forget everything already typed through.
		 */
		it('still MERGES for an ordinary (non-seek) awaiting — ruling out an accidental global replace', () => {
			const windowOne = makeText({ 0: 'abcd' }, 2);
			const awaiting = run(createSession(windowOne), CHUNK_ONE_EVENTS);
			expect(awaiting.status).toBe('awaiting');
			const state = applySessionEvent(awaiting, {
				type: 'window-loaded',
				chunks: [chunkAt(1, 'ef')],
				chunkCount: 2,
				timestamp: 96_000
			});
			expect(state.text.chunks.get(0)?.content).toBe('abcd');
			expect(state.text.chunks.get(1)?.content).toBe('ef');
		});
	});

	describe('the measured span closes at the seek and reopens at the next real keystroke', () => {
		it('excludes the gap between a seek and the next keystroke from cumulative elapsed time', () => {
			// A single chunk, still open (never completed), so the only dead time in this span
			// is the seek gap itself — nothing from an intervening `awaiting` to account for.
			const state = run(createSession(makeText({ 0: 'ab', 7: 'cd' }, 10)), [
				{ type: 'char', char: 'a', timestamp: 0 }
			]);
			const seeked = applySessionEvent(state, { type: 'seek', index: 7, timestamp: 5000 });
			expect(seeked.status).toBe('active');

			const typed = applySessionEvent(seeked, { type: 'char', char: 'c', timestamp: 20_000 });
			expect(typed.seekSince).toBeNull();
			expect(typed.seekMs).toBe(20_000 - 5000);
			// Span 0 -> 20_000 (20_000ms) minus the seek gap (15_000ms) leaves the 5_000ms the
			// user was actually idle-but-active on chunk 0 before seeking — NOT discounted,
			// matching the existing precedent that idle time on an active page is real elapsed
			// session time (CHUNK_TWO_EVENTS's "starts after a long idle gap" case, unchanged).
			expect(runningMetrics(typed, 20_000).elapsedMs).toBe(5000);
		});

		it('opens seekSince at the seek instant, before any keystroke resumes it', () => {
			const state = run(createSession(makeText({ 0: 'ab', 1: 'cd' }, 2)), [
				{ type: 'char', char: 'a', timestamp: 0 }
			]);
			const seeked = applySessionEvent(state, { type: 'seek', index: 1, timestamp: 5000 });
			expect(seeked.seekSince).toBe(5000);
			expect(seeked.seekMs).toBe(0);
		});

		it('opens seekSince only once the awaited window actually lands, not at the seek instant', () => {
			// The network wait is already discounted by awaitingMs; double-opening seekSince at
			// the seek instant would discount the SAME milliseconds twice.
			const state = run(createSession(makeText({ 0: 'abcd' }, 500)), [
				{ type: 'char', char: 'a', timestamp: 0 }
			]);
			const seeked = applySessionEvent(state, { type: 'seek', index: 400, timestamp: 5000 });
			expect(seeked.seekSince).toBeNull();

			const landed = applySessionEvent(seeked, {
				type: 'window-loaded',
				chunks: [chunkAt(400, 'far away')],
				chunkCount: 500,
				timestamp: 9000
			});
			expect(landed.awaitingMs).toBe(4000);
			expect(landed.seekSince).toBe(9000);
			expect(landed.seekMs).toBe(0);

			const typed = applySessionEvent(landed, { type: 'char', char: 'f', timestamp: 11_000 });
			expect(typed.seekMs).toBe(2000); // 11_000 - 9000, not double-counting the network wait
			expect(typed.awaitingMs).toBe(4000);
		});

		it('never double-discounts: the network wait and the seek gap are two DISTINCT stretches', () => {
			const state = run(createSession(makeText({ 0: 'abcd' }, 500)), [
				{ type: 'char', char: 'a', timestamp: 0 }
			]);
			// 0 -> 5000: idle but active on chunk 0 (not discounted, see the test above).
			const seeked = applySessionEvent(state, { type: 'seek', index: 400, timestamp: 5000 });
			// 5000 -> 9000: the network wait for the seek's window (awaitingMs, discounted once).
			const landed = applySessionEvent(seeked, {
				type: 'window-loaded',
				chunks: [chunkAt(400, 'far away')],
				chunkCount: 500,
				timestamp: 9000
			});
			// 9000 -> 11_000: the post-arrival, pre-keystroke gap (seekMs, discounted once).
			const typed = applySessionEvent(landed, { type: 'char', char: 'f', timestamp: 11_000 });

			expect(typed.awaitingMs).toBe(4000);
			expect(typed.seekMs).toBe(2000);
			// A double discount would subtract some millisecond of the 5000 -> 9000 wait twice,
			// driving elapsedMs below the honest remainder (the 5000ms idle-but-active stretch).
			expect(runningMetrics(typed, 11_000).elapsedMs).toBe(5000);
		});
	});
});

describe('set-mode — the reducer rule', () => {
	it('returns the IDENTICAL state when the mode is unchanged', () => {
		// Idempotent: a UI that re-asserts its cookie value must never fabricate a
		// zero-length span boundary, and must never invalidate a memo downstream.
		const state = run(createSession(makeFullText(['abcd', 'ef'])), CLEAN_FOUR.slice(0, 2));
		expect(applySessionEvent(state, { type: 'set-mode', mode: 'normal', timestamp: 9000 })).toBe(
			state
		);
		const zen = applySessionEvent(state, { type: 'set-mode', mode: 'zen', timestamp: 9000 });
		expect(applySessionEvent(zen, { type: 'set-mode', mode: 'zen', timestamp: 12_000 })).toBe(zen);
	});

	it('touches nothing but the span accounting — not the chunk, the log, or the status', () => {
		const state = run(createSession(makeFullText(['abcd', 'ef'])), CLEAN_FOUR.slice(0, 2));
		const zen = applySessionEvent(state, { type: 'set-mode', mode: 'zen', timestamp: 5000 });
		expect(zen.activeChunk).toBe(state.activeChunk); // same object, not recreated
		expect(zen.status).toBe(state.status);
		expect(zen.activeIndex).toBe(state.activeIndex);
		expect(zen.results).toBe(state.results);
		expect(runningLog(zen)).toEqual(runningLog(state));
	});

	it('opens a Zen span on normal → zen and closes it on zen → normal', () => {
		let state = run(createSession(makeFullText(['abcd', 'ef'])), CLEAN_FOUR.slice(0, 2));
		state = applySessionEvent(state, { type: 'set-mode', mode: 'zen', timestamp: 2000 });
		expect(state.mode).toBe('zen');
		expect(state.unmeasuredSince).toBe(2000);
		expect(state.unmeasuredMs).toBe(0);
		expect(state.everUnmeasured).toBe(true);
		expect(state.chunkFullyMeasured).toBe(false);

		state = applySessionEvent(state, { type: 'set-mode', mode: 'normal', timestamp: 7000 });
		expect(state.mode).toBe('normal');
		expect(state.unmeasuredSince).toBeNull();
		expect(state.unmeasuredMs).toBe(5000);
		expect(state.chunkUnmeasuredMs).toBe(5000);
		// A return to Normal resumes measurement but NEVER re-cleans the traversal.
		expect(state.chunkFullyMeasured).toBe(false);
		expect(state.everUnmeasured).toBe(true);
	});

	it('is accepted while awaiting and while finished', () => {
		const awaiting = run(createSession(makeText({ 0: 'abcd' }, 2)), CHUNK_ONE_EVENTS);
		expect(awaiting.status).toBe('awaiting');
		const zen = applySessionEvent(awaiting, { type: 'set-mode', mode: 'zen', timestamp: 7000 });
		expect(zen.mode).toBe('zen');
		expect(zen.status).toBe('awaiting');

		const finished = run(createSession(makeFullText(['abcd', 'ef'])), [
			...CHUNK_ONE_EVENTS,
			...CHUNK_TWO_EVENTS
		]);
		const zenFinished = applySessionEvent(finished, {
			type: 'set-mode',
			mode: 'zen',
			timestamp: 200_000
		});
		expect(zenFinished.mode).toBe('zen');
		expect(zenFinished.status).toBe('finished');
	});
});

describe('createSession — the mode parameter', () => {
	it('defaults to normal with a clean traversal and no unmeasured time', () => {
		const state = createSession(makeFullText(['abcd', 'ef']));
		expect(state.mode).toBe('normal');
		expect(state.unmeasuredSince).toBeNull();
		expect(state.unmeasuredMs).toBe(0);
		expect(state.chunkUnmeasuredMs).toBe(0);
		expect(state.chunkFullyMeasured).toBe(true);
		expect(state.everUnmeasured).toBe(false);
	});

	it('opens in zen when asked, and the traversal is dirty from the first instant', () => {
		const state = createSession(makeFullText(['abcd', 'ef']), 0, 'zen');
		expect(state.mode).toBe('zen');
		expect(state.chunkFullyMeasured).toBe(false);
		expect(state.everUnmeasured).toBe(true);
		// No clock is available in createSession, so the span opens on the first stroke
		// rather than at a fabricated instant — the `awaitingSince` precedent.
		expect(state.unmeasuredSince).toBeNull();
	});
});

describe('Zen keeps the log and drops the metrics (spec #24 §2)', () => {
	it('grows the keystroke log exactly as Normal does', () => {
		const zen = run(createSession(makeFullText(['abcd', 'ef']), 0, 'zen'), CHUNK_ONE_EVENTS);
		const normal = run(createSession(makeFullText(['abcd', 'ef'])), CHUNK_ONE_EVENTS);
		expect(zen.completedLog).toHaveLength(normal.completedLog.length);
		expect(zen.completedLog.map((k) => k.char)).toEqual(normal.completedLog.map((k) => k.char));
		// Same strokes, different provenance — that is the ONLY difference in the log.
		expect(zen.completedLog.every((k) => k.measured === false)).toBe(true);
		expect(normal.completedLog.every((k) => k.measured === true)).toBe(true);
	});

	it('exposes no WPM and no accuracy on the frozen result or in the summary', () => {
		const zen = run(createSession(makeFullText(['abcd', 'ef']), 0, 'zen'), CHUNK_ONE_EVENTS);
		expect(zen.results.get(0)?.grossWpm).toBeNull();
		expect(zen.results.get(0)?.accuracyRaw).toBeNull();
		const summary = sessionSummary(zen);
		expect(summary.averageWpm).toBeNull();
		expect(summary.overallAccuracy).toBeNull();
		// The counters survive: Zen progress is progress, and Time is neither WPM nor accuracy.
		expect(summary.chunksCompleted).toBe(1);
		expect(summary.totalActiveMs).toBe(6000);
	});
});

describe('the whole clean traversal rule (spec #24 §4)', () => {
	it('wholly Normal: metrics present, measuredMs equals elapsedMs, mode normal', () => {
		const state = run(createSession(makeFullText(['abcd', 'ef'])), CHUNK_ONE_EVENTS);
		expect(state.results.get(0)).toEqual({
			grossWpm: 10,
			accuracyRaw: 0.75,
			elapsedMs: 6000,
			measuredMs: 6000,
			measuredChars: 5,
			mode: 'normal'
		});
	});

	it('wholly Zen: metrics NULL, zero span, mode zen', () => {
		const state = run(createSession(makeFullText(['abcd', 'ef']), 0, 'zen'), CHUNK_ONE_EVENTS);
		expect(state.results.get(0)).toEqual({
			grossWpm: null,
			accuracyRaw: null,
			elapsedMs: 6000, // wall clock is unchanged in meaning
			measuredMs: 0,
			measuredChars: 0,
			mode: 'zen'
		});
	});

	it('mid-way switch: metrics NULL, but a non-zero span is still recorded', () => {
		const state = run(createSession(makeFullText(['abcd', 'ef'])), [
			{ type: 'char', char: 'a', timestamp: 0 },
			{ type: 'char', char: 'x', timestamp: 1000 },
			{ type: 'backspace', timestamp: 2000 },
			{ type: 'set-mode', mode: 'zen', timestamp: 2500 },
			{ type: 'char', char: 'b', timestamp: 3000 },
			{ type: 'char', char: 'c', timestamp: 4000 },
			{ type: 'set-mode', mode: 'normal', timestamp: 5000 },
			{ type: 'char', char: 'd', timestamp: 6000 }
		]);
		expect(state.results.get(0)).toEqual({
			grossWpm: null,
			accuracyRaw: null,
			elapsedMs: 6000,
			measuredMs: 3500, // 6000 wall clock − 2500 of Zen
			measuredChars: 3, // a, x, d — b and c were typed in Zen
			mode: 'zen'
		});
	});

	it('a zero-millisecond Zen excursion still dirties the traversal', () => {
		// The rule is a BOOLEAN, not `chunkUnmeasuredMs === 0`: an instantaneous toggle
		// accrues no time and still means the passage was not wholly measured.
		const state = run(createSession(makeFullText(['abcd', 'ef'])), [
			{ type: 'char', char: 'a', timestamp: 0 },
			{ type: 'set-mode', mode: 'zen', timestamp: 1000 },
			{ type: 'set-mode', mode: 'normal', timestamp: 1000 },
			{ type: 'char', char: 'b', timestamp: 2000 },
			{ type: 'char', char: 'c', timestamp: 3000 },
			{ type: 'char', char: 'd', timestamp: 4000 }
		]);
		expect(state.chunkUnmeasuredMs).toBe(0);
		expect(state.results.get(0)?.mode).toBe('zen');
		expect(state.results.get(0)?.grossWpm).toBeNull();
		expect(state.results.get(0)?.measuredChars).toBe(4);
	});

	it('starts each traversal clean again — a dirty passage does not poison the next', () => {
		// Back in Normal BEFORE the boundary, so passage 2 is traversed wholly in Normal.
		const state = run(createSession(makeFullText(['abcd', 'ef'])), [
			{ type: 'set-mode', mode: 'zen', timestamp: 0 },
			...CHUNK_ONE_EVENTS.slice(0, 5), // a, x, backspace, b, c — all in Zen
			{ type: 'set-mode', mode: 'normal', timestamp: 5000 },
			{ type: 'char', char: 'd', timestamp: 6000 }, // completes chunk 0
			...CHUNK_TWO_EVENTS
		]);
		expect(state.results.get(0)?.mode).toBe('zen');
		expect(state.results.get(1)).toEqual({
			grossWpm: 8,
			accuracyRaw: 1,
			elapsedMs: 3000,
			measuredMs: 3000,
			measuredChars: 2,
			mode: 'normal'
		});
	});

	it('dirties a traversal that BEGINS in Zen, even if Normal resumes a moment later', () => {
		// The boundary at 6000 opens passage 2 in Zen; the switch at 7000 leaves 1000 ms of
		// that traversal unmeasured, so the row must say so. `chunkFullyMeasured` is set from
		// the mode AT the boundary and is never restored within the traversal.
		const state = run(createSession(makeFullText(['abcd', 'ef'])), [
			{ type: 'set-mode', mode: 'zen', timestamp: 0 },
			...CHUNK_ONE_EVENTS,
			{ type: 'set-mode', mode: 'normal', timestamp: 7000 },
			...CHUNK_TWO_EVENTS
		]);
		expect(state.results.get(1)?.mode).toBe('zen');
		expect(state.results.get(1)?.grossWpm).toBeNull();
		expect(state.results.get(1)?.elapsedMs).toBe(3000);
		expect(state.results.get(1)?.measuredChars).toBe(2); // both strokes WERE measured
		expect(state.results.get(1)?.measuredMs).toBe(2000); // 3000 wall clock − the 1000 of Zen
		// And the span the previous traversal already accounted for is NOT charged again:
		// 6000 ms of Zen in passage 1 plus 1000 ms at the head of passage 2.
		expect(state.unmeasuredMs).toBe(7000);
	});

	it('holds measuredMs <= elapsedMs for every switch timing', () => {
		for (const enter of [0, 500, 1000, 2500, 4000, 6000]) {
			for (const leave of [enter, enter + 1, 3000, 5500, 6000, 9999]) {
				const state = run(createSession(makeFullText(['abcd', 'ef'])), [
					{ type: 'char', char: 'a', timestamp: 0 },
					{ type: 'set-mode', mode: 'zen', timestamp: enter },
					{ type: 'char', char: 'b', timestamp: 2000 },
					{ type: 'set-mode', mode: 'normal', timestamp: leave },
					{ type: 'char', char: 'c', timestamp: 4000 },
					{ type: 'char', char: 'd', timestamp: 6000 }
				]);
				const result = state.results.get(0);
				expect(result).toBeDefined();
				expect(result!.measuredMs).toBeGreaterThanOrEqual(0);
				expect(result!.measuredMs).toBeLessThanOrEqual(result!.elapsedMs);
			}
		}
	});
});

describe('Zen time is discounted from cumulative figures (spec #24 §3)', () => {
	it('discounts an OPEN Zen span live — the figure must not decay while in Zen', () => {
		const state = run(createSession(makeFullText(['abcdefgh'])), [
			{ type: 'char', char: 'a', timestamp: 0 },
			{ type: 'char', char: 'b', timestamp: 1000 },
			{ type: 'set-mode', mode: 'zen', timestamp: 2000 }
		]);
		expect(runningMetrics(state, 2000).elapsedMs).toBe(2000);
		expect(runningMetrics(state, 62_000).elapsedMs).toBe(2000);
		expect(runningMetrics(state, 62_000).grossWpm).toBe(runningMetrics(state, 2000).grossWpm);
	});

	it('accounts a closed Zen span exactly once, and nothing else', () => {
		const state = run(createSession(makeFullText(['abcdefgh'])), [
			{ type: 'char', char: 'a', timestamp: 0 },
			{ type: 'set-mode', mode: 'zen', timestamp: 1000 },
			{ type: 'set-mode', mode: 'normal', timestamp: 31_000 },
			{ type: 'char', char: 'b', timestamp: 32_000 }
		]);
		expect(state.unmeasuredMs).toBe(30_000);
		expect(runningMetrics(state).elapsedMs).toBe(2000); // 32_000 span − 30_000 Zen
	});

	it('reports a cumulative figure over the Normal stretches only', () => {
		const state = run(createSession(makeFullText(['abcd', 'efgh'])), [
			{ type: 'char', char: 'a', timestamp: 0 },
			{ type: 'char', char: 'b', timestamp: 1000 },
			{ type: 'char', char: 'c', timestamp: 2000 },
			{ type: 'char', char: 'd', timestamp: 3000 },
			{ type: 'set-mode', mode: 'zen', timestamp: 4000 },
			{ type: 'char', char: 'e', timestamp: 5000 },
			{ type: 'char', char: 'f', timestamp: 6000 },
			{ type: 'set-mode', mode: 'normal', timestamp: 7000 },
			{ type: 'char', char: 'g', timestamp: 8000 },
			{ type: 'char', char: 'h', timestamp: 9000 }
		]);
		const metrics = runningMetrics(state);
		expect(metrics.typedChars).toBe(6); // e and f are excluded
		expect(metrics.elapsedMs).toBe(6000); // 9000 span − 3000 of Zen
		expect(metrics.grossWpm).toBeCloseTo(6 / 5 / (6000 / 60_000), 5);
		expect(metrics.accuracyRaw).toBe(1);
	});
});

describe('Zen and awaiting must never double-discount (spec #24 §3.5)', () => {
	/**
	 * Both feed `excludeMs`. If a Zen span were left open across a wait, the same
	 * milliseconds would be subtracted twice — floored at 0, so it never crashes and never
	 * goes negative, which is exactly what would make it invisible.
	 */
	function acrossTheBoundary(): SessionState {
		const state = run(createSession(makeText({ 0: 'abcd' }, 2)), [
			{ type: 'char', char: 'a', timestamp: 0 },
			{ type: 'char', char: 'x', timestamp: 1000 },
			{ type: 'backspace', timestamp: 2000 },
			{ type: 'char', char: 'b', timestamp: 3000 },
			{ type: 'char', char: 'c', timestamp: 4000 },
			{ type: 'set-mode', mode: 'zen', timestamp: 5000 },
			{ type: 'char', char: 'd', timestamp: 6000 } // completes; enters awaiting
		]);
		expect(state.status).toBe('awaiting');
		return state;
	}

	it('closes the open Zen span when the session enters awaiting', () => {
		const state = acrossTheBoundary();
		expect(state.unmeasuredSince).toBeNull();
		expect(state.unmeasuredMs).toBe(1000);
		expect(state.awaitingSince).toBe(6000);
	});

	it('reopens the Zen span when the window lands and typing resumes', () => {
		const state = applySessionEvent(acrossTheBoundary(), {
			type: 'window-loaded',
			chunks: [chunkAt(1, 'ef')],
			chunkCount: 2,
			timestamp: 16_000
		});
		expect(state.status).toBe('active');
		expect(state.awaitingMs).toBe(10_000);
		expect(state.unmeasuredMs).toBe(1000); // the wait was NOT counted as Zen too
		expect(state.unmeasuredSince).toBe(16_000);
	});

	it('subtracts the wait once, not once per reason', () => {
		const state = applySessionEvent(acrossTheBoundary(), {
			type: 'window-loaded',
			chunks: [chunkAt(1, 'ef')],
			chunkCount: 2,
			timestamp: 16_000
		});
		// Span 0→16_000, minus 10_000 of awaiting and 1000 of Zen = 5000. A double discount
		// would leave 0 here and silently inflate every WPM downstream.
		expect(runningMetrics(state, 16_000).elapsedMs).toBe(5000);
		expect(runningMetrics(state, 26_000).elapsedMs).toBe(5000); // the reopened span holds
	});

	it('does not open a Zen span while awaiting — awaitingSince already owns that time', () => {
		const awaiting = run(createSession(makeText({ 0: 'abcd' }, 2)), CHUNK_ONE_EVENTS);
		const zen = applySessionEvent(awaiting, { type: 'set-mode', mode: 'zen', timestamp: 8000 });
		expect(zen.unmeasuredSince).toBeNull();
		expect(zen.everUnmeasured).toBe(true);
		const resumed = applySessionEvent(zen, {
			type: 'window-loaded',
			chunks: [chunkAt(1, 'ef')],
			chunkCount: 2,
			timestamp: 20_000
		});
		expect(resumed.awaitingMs).toBe(14_000);
		expect(resumed.unmeasuredMs).toBe(0);
		expect(resumed.unmeasuredSince).toBe(20_000); // reopened on the return to active
	});
});

describe('completion is unchanged in both modes (ADR-0004)', () => {
	it('still requires every character to be correct or corrected in Zen', () => {
		const partial = run(createSession(makeFullText(['abcd', 'ef']), 0, 'zen'), [
			{ type: 'char', char: 'a', timestamp: 0 },
			{ type: 'char', char: 'b', timestamp: 1000 },
			{ type: 'char', char: 'c', timestamp: 2000 },
			{ type: 'char', char: 'x', timestamp: 3000 } // wrong last character
		]);
		expect(partial.activeChunk?.completed).toBe(false);
		expect(partial.results.size).toBe(0);

		const fixed = run(partial, [
			{ type: 'backspace', timestamp: 4000 },
			{ type: 'char', char: 'd', timestamp: 5000 }
		]);
		expect(fixed.results.size).toBe(1);
		expect(fixed.activeIndex).toBe(1);
	});

	it('produces the identical display and character states in both modes', () => {
		const events = CHUNK_ONE_EVENTS.slice(0, 4);
		const normal = run(createSession(makeFullText(['abcd', 'ef'])), events);
		const zen = run(createSession(makeFullText(['abcd', 'ef']), 0, 'zen'), events);
		expect(zen.activeChunk?.display).toEqual(normal.activeChunk?.display);
		expect(zen.activeChunk?.firstAttempts).toEqual(normal.activeChunk?.firstAttempts);
		expect(zen.activeChunk?.cursor).toBe(normal.activeChunk?.cursor);
	});
});

describe('restart semantics under mode', () => {
	it('restart-session carries the CURRENT mode over and resets every accumulator', () => {
		const state = run(createSession(makeFullText(['abcd', 'ef'])), [
			{ type: 'char', char: 'a', timestamp: 0 },
			{ type: 'set-mode', mode: 'zen', timestamp: 1000 },
			{ type: 'char', char: 'b', timestamp: 2000 }
		]);
		const restarted = applySessionEvent(state, { type: 'restart-session' });
		expect(restarted.mode).toBe('zen'); // it is a cookie-backed preference, not session state
		expect(restarted.unmeasuredMs).toBe(0);
		expect(restarted.chunkUnmeasuredMs).toBe(0);
		expect(restarted.unmeasuredSince).toBeNull();
		expect(restarted.chunkFullyMeasured).toBe(false); // opened in zen
		expect(restarted.everUnmeasured).toBe(true);
	});

	it('restart-session out of Zen gives a genuinely unmeasured-free session again', () => {
		// Risk 11: `everUnmeasured` is session-scoped. A restarted session that never enters
		// Zen really did contain no Zen, so a full summary is correct, not a bug.
		const dirty = run(createSession(makeFullText(['abcd', 'ef'])), [
			{ type: 'char', char: 'a', timestamp: 0 },
			{ type: 'set-mode', mode: 'zen', timestamp: 1000 },
			{ type: 'set-mode', mode: 'normal', timestamp: 2000 }
		]);
		const restarted = applySessionEvent(dirty, { type: 'restart-session' });
		expect(restarted.everUnmeasured).toBe(false);
		expect(restarted.chunkFullyMeasured).toBe(true);
		const typed = run(restarted, CHUNK_ONE_EVENTS);
		expect(sessionSummary(typed).averageWpm).not.toBeNull();
		expect(typed.results.get(0)?.mode).toBe('normal');
	});

	it('restart-chunk resets the per-traversal accounting and re-cleans the traversal', () => {
		const dirty = run(createSession(makeFullText(['abcd', 'ef'])), [
			{ type: 'char', char: 'a', timestamp: 0 },
			{ type: 'set-mode', mode: 'zen', timestamp: 1000 },
			{ type: 'set-mode', mode: 'normal', timestamp: 6000 }
		]);
		expect(dirty.chunkUnmeasuredMs).toBe(5000);
		expect(dirty.chunkFullyMeasured).toBe(false);

		const restarted = applySessionEvent(dirty, { type: 'restart-chunk' });
		expect(restarted.chunkUnmeasuredMs).toBe(0);
		expect(restarted.chunkFullyMeasured).toBe(true); // a fresh traversal, cleanly measured
		expect(restarted.unmeasuredMs).toBe(5000); // SESSION scope is untouched
		expect(restarted.everUnmeasured).toBe(true); // and so is the session-scope flag

		const typed = run(restarted, shift(CHUNK_ONE_EVENTS, 10_000));
		expect(typed.results.get(0)?.mode).toBe('normal');
		expect(typed.results.get(0)?.grossWpm).toBe(10);
	});

	it('restart-chunk in Zen leaves the traversal dirty', () => {
		const state = applySessionEvent(createSession(makeFullText(['abcd', 'ef']), 0, 'zen'), {
			type: 'restart-chunk'
		});
		expect(state.chunkFullyMeasured).toBe(false);
	});
});

describe('sessionSummary is all-or-nothing on Zen (spec #24 §11)', () => {
	it('nulls both metric fields after ANY Zen time, keeping the counters', () => {
		const state = run(createSession(makeFullText(['abcd', 'ef'])), [
			...CHUNK_ONE_EVENTS, // wholly Normal, clean
			{ type: 'set-mode', mode: 'zen', timestamp: 6500 },
			{ type: 'set-mode', mode: 'normal', timestamp: 6500 },
			...CHUNK_TWO_EVENTS
		]);
		const summary = sessionSummary(state);
		expect(summary.averageWpm).toBeNull();
		expect(summary.overallAccuracy).toBeNull();
		expect(summary.chunksCompleted).toBe(2);
		expect(summary.totalActiveMs).toBe(9000); // Time is neither WPM nor accuracy
	});

	it('nulls them before any chunk completes, too', () => {
		const state = createSession(makeFullText(['abcd', 'ef']), 0, 'zen');
		expect(sessionSummary(state)).toEqual({
			averageWpm: null,
			overallAccuracy: null,
			chunksCompleted: 0,
			totalActiveMs: 0
		});
	});

	it('leaves a fully-Normal session identical to pre-4a', () => {
		const state = run(createSession(makeFullText(['abcd', 'ef'])), [
			...CHUNK_ONE_EVENTS,
			...CHUNK_TWO_EVENTS
		]);
		const summary = sessionSummary(state);
		expect(summary.averageWpm).toBeCloseTo(7 / 5 / (103_000 / 60_000), 5);
		expect(summary.overallAccuracy).toBeCloseTo(5 / 6, 5);
		expect(summary.chunksCompleted).toBe(2);
		expect(summary.totalActiveMs).toBe(9000);
	});
});

/**
 * Settled pages (spec #50 §6).
 *
 * The rule under test is "a completed page settles on EVERY arrival", and the reason it needs
 * this many tests is that there are four arrival paths — mount, a seek into a loaded chunk, a
 * window landing for a seek that had to fetch, and the auto-advance at a completion instant —
 * plus a fifth, retroactive one when the progress response lands after the window it describes.
 * A rule enforced at three of the five is a rule that behaves differently depending on how far
 * the user jumped, which is worse than not having it.
 */
describe('settled pages', () => {
	const TEXT = makeFullText(['abcd', 'ef', 'ghij']);
	const idAt = (index: number) => TEXT.chunks.get(index)!.id;

	/** Every character reads as typed, the caret sits past the end, and nothing was judged. */
	function expectSettled(state: SessionState, content: string) {
		const chunk = state.activeChunk!;
		expect(chunk.display).toEqual(Array.from(content).map(() => 'correct'));
		expect(chunk.cursor).toBe(Array.from(content).length);
		expect(chunk.log).toEqual([]);
		// The whole point: it looks typed and scores nothing.
		expect(chunk.firstAttempts.every((record) => record === null)).toBe(true);
		expect(chunk.startedAt).toBeNull();
	}

	function expectFresh(state: SessionState, content: string) {
		const chunk = state.activeChunk!;
		expect(chunk.display).toEqual(Array.from(content).map(() => 'pending'));
		expect(chunk.cursor).toBe(0);
	}

	it('settles the opening page on mount', () => {
		expectSettled(createSession(TEXT, 0, 'normal', new Set([idAt(0)])), 'abcd');
	});

	it('leaves an uncompleted opening page fresh', () => {
		expectFresh(createSession(TEXT, 0, 'normal', new Set([idAt(2)])), 'abcd');
	});

	it('settles on a seek into a loaded chunk', () => {
		const session = createSession(TEXT, 0, 'normal', new Set([idAt(2)]));
		expectSettled(applySessionEvent(session, { type: 'seek', index: 2, timestamp: 5000 }), 'ghij');
	});

	/**
	 * The far-jump path. The chunk does not exist at the seek instant, so the decision cannot be
	 * taken there — it has to be taken again when the window lands.
	 */
	it('settles when the window for a pending seek arrives', () => {
		const windowed = makeText({ 0: 'abcd' }, 3);
		const session = createSession(windowed, 0, 'normal', new Set([idAt(2)]));
		const seeked = applySessionEvent(session, { type: 'seek', index: 2, timestamp: 5000 });
		expect(seeked.status).toBe('awaiting');
		expect(seeked.seekPending).toBe(true);
		const landed = applySessionEvent(seeked, {
			type: 'window-loaded',
			chunks: [chunkAt(2, 'ghij')],
			chunkCount: 3,
			timestamp: 6000
		});
		expect(landed.status).toBe('active');
		expectSettled(landed, 'ghij');
	});

	it('settles on auto-advance into a page completed on an earlier visit', () => {
		const session = createSession(makeFullText(['ab', 'cd']), 0, 'normal', new Set(['chunk-1']));
		const advanced = run(session, [
			{ type: 'char', char: 'a', timestamp: 0 },
			{ type: 'char', char: 'b', timestamp: 1000 }
		]);
		expect(advanced.activeIndex).toBe(1);
		expectSettled(advanced, 'cd');
	});

	it('records a page it completes, so seeking back to it settles', () => {
		const session = run(createSession(makeFullText(['ab', 'cd'])), [
			{ type: 'char', char: 'a', timestamp: 0 },
			{ type: 'char', char: 'b', timestamp: 1000 }
		]);
		expect(session.completedIds.has('chunk-0')).toBe(true);
		expectSettled(applySessionEvent(session, { type: 'seek', index: 0, timestamp: 2000 }), 'ab');
	});

	it('ignores char and backspace on a settled page', () => {
		const settled = createSession(TEXT, 0, 'normal', new Set([idAt(0)]));
		// Backspace is the one that matters: `applyChar` is already inert past the end, but
		// without the settled guard a backspace would walk back through untyped text.
		expect(applySessionEvent(settled, { type: 'backspace', timestamp: 1000 })).toBe(settled);
		expect(applySessionEvent(settled, { type: 'char', char: 'a', timestamp: 1000 })).toBe(settled);
	});

	it('reopens a settled page with restart-chunk, without un-completing it', () => {
		const settled = createSession(TEXT, 0, 'normal', new Set([idAt(0)]));
		const reopened = applySessionEvent(settled, { type: 'restart-chunk' });
		expectFresh(reopened, 'abcd');
		// `Type again` is per-visit: the historical fact survives, which is what makes a reload
		// settle the page again.
		expect(reopened.completedIds.has(idAt(0))).toBe(true);
	});

	it('a reopened page can be typed and completed again', () => {
		const reopened = applySessionEvent(
			createSession(makeFullText(['ab', 'cd']), 0, 'normal', new Set(['chunk-0'])),
			{ type: 'restart-chunk' }
		);
		const done = run(reopened, [
			{ type: 'char', char: 'a', timestamp: 0 },
			{ type: 'char', char: 'b', timestamp: 1000 }
		]);
		expect(done.results.get(0)).toBeDefined();
		expect(done.activeIndex).toBe(1);
	});

	it('a settled page contributes no characters and no time to cumulative metrics', () => {
		const settled = createSession(TEXT, 0, 'normal', new Set([idAt(0)]));
		const metrics = runningMetrics(settled, 60_000);
		expect(metrics.grossWpm).toBe(0);
		expect(runningLog(settled)).toEqual([]);
	});

	describe('progress-loaded', () => {
		it('settles the page on screen when its completion arrives late', () => {
			const session = createSession(TEXT, 0);
			expectFresh(session, 'abcd');
			const merged = applySessionEvent(session, {
				type: 'progress-loaded',
				chunkIds: [idAt(0)]
			});
			expectSettled(merged, 'abcd');
		});

		it('does not disturb a page the user has already started typing', () => {
			const typing = applySessionEvent(createSession(TEXT, 0), {
				type: 'char',
				char: 'a',
				timestamp: 0
			});
			const merged = applySessionEvent(typing, { type: 'progress-loaded', chunkIds: [idAt(0)] });
			expect(merged.activeChunk).toBe(typing.activeChunk);
			expect(merged.completedIds.has(idAt(0))).toBe(true);
		});

		it('merges rather than replaces, keeping ids added optimistically this session', () => {
			const session = run(createSession(makeFullText(['ab', 'cd'])), [
				{ type: 'char', char: 'a', timestamp: 0 },
				{ type: 'char', char: 'b', timestamp: 1000 }
			]);
			const merged = applySessionEvent(session, { type: 'progress-loaded', chunkIds: ['chunk-9'] });
			expect([...merged.completedIds].sort()).toEqual(['chunk-0', 'chunk-9']);
		});

		it('is the identity when every id is already known', () => {
			const session = createSession(TEXT, 0, 'normal', new Set([idAt(0)]));
			expect(applySessionEvent(session, { type: 'progress-loaded', chunkIds: [idAt(0)] })).toBe(
				session
			);
		});
	});
});
