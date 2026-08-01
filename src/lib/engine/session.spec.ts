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
			elapsedMs: 6000
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
		expect(state.results.get(1)).toEqual({ grossWpm: 8, accuracyRaw: 1, elapsedMs: 3000 });
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
		expect(sessionSummary(windowed()).averageWpm).toBeCloseTo(
			sessionSummary(preloaded()).averageWpm,
			10
		);
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
			elapsedMs: 6000
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

	it('restart-session from a session opened at 0 is identical to a fresh session', () => {
		const text = makeFullText(['abcd', 'ef']);
		const midSecondChunk = run(createSession(text), [
			...CHUNK_ONE_EVENTS,
			{ type: 'char', char: 'e', timestamp: 100_000 }
		]);
		expect(applySessionEvent(midSecondChunk, { type: 'restart-session' })).toEqual(
			createSession(text)
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
