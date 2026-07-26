<script lang="ts">
	import { untrack } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import type { Pathname } from '$app/types';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { m } from '$lib/paraglide/messages';
	import { localizeHref } from '$lib/paraglide/runtime';
	import {
		applySessionEvent,
		createSession,
		runningMetrics,
		sessionSummary
	} from '$lib/engine/session';
	import type { ChunkResult, SessionEvent, SessionState } from '$lib/engine/session';
	import type { MetricsSnapshot } from '$lib/engine/metrics';
	import type { TypeableText } from '$lib/types';
	import PassageMeta from './PassageMeta.svelte';
	import SessionSummaryView from './SessionSummary.svelte';
	import TypingSurface from './TypingSurface.svelte';

	interface Props {
		book: TypeableText;
		/** Index the session opens at (resume, or a valid `?passage` override). */
		startIndex: number;
		/** Persisted book-lifetime completion count. 0 for guests. */
		chunksCompleted: number;
		/** Chunk ids already completed at least once. Empty for guests. */
		completedChunkIds: readonly string[];
		/** null for a guest — the sole gate on the write path. No insert, no import, no request. */
		userId: string | null;
	}

	let { book, startIndex, chunksCompleted, completedChunkIds, userId }: Props = $props();

	// One session per mounted instance. The parent keys this component on the book id, so
	// `book` never changes here — no mount-time reset that could drop the first keystrokes.
	// `startIndex` is read once for the same reason: a later `?passage=N` navigation must not
	// yank a session that is already underway.
	let session = $state.raw<SessionState>(untrack(() => createSession(book, startIndex)));
	let liveMetrics = $state.raw<MetricsSnapshot | null>(null);
	let surface = $state<{ focusInput: () => void } | null>(null);

	/**
	 * The optimistically-advanced set of chunk ids completed at least once (spec #12 §4).
	 * Seeded from the load's persisted ids; a completion adds to it immediately, without
	 * waiting for the insert. Adding an id that is already present is a no-op — that IS the
	 * "re-completing a passage does not advance the figure" rule. Never rolled back on a
	 * save failure (spec §6): it self-corrects on the next load.
	 *
	 * `SvelteSet` is reactive on its own, so no `$state` wrapper. Seeded once via `untrack`
	 * for the same reason as `session` above: the seed is a starting point, not a binding.
	 */
	const completed = untrack(() => new SvelteSet(completedChunkIds));

	/** Count of inserts that came back `{ saved: false }`. Stated once, on the summary. */
	let failedSaves = $state(0);

	// Zen mode (spec #9): a per-visit presentation toggle — the engine keeps
	// logging (the keystroke log is the single source of truth); only the meta
	// line's metric segments are subtracted.
	let zen = $state(false);

	/**
	 * The lazily-loaded write path. `$lib/supabase/browser` and `$lib/progress/client` are
	 * reached ONLY through this dynamic import, so `@supabase/ssr` + `@supabase/supabase-js`
	 * are emitted as a separate chunk that is never in the entry graph and a guest never
	 * fetches (brief §1.6). No static import of either module may exist in any component,
	 * and no `modulepreload` hint may be added for the chunk.
	 */
	let progressModules: Promise<
		[typeof import('$lib/supabase/browser'), typeof import('$lib/progress/client')]
	> | null = null;

	/**
	 * Starts the import if it has not started, and returns the one shared promise. Called
	 * without awaiting on the session's first `char` event when signed in, so the completion
	 * instant is not paying for a cold network fetch; awaited at the completion instant
	 * itself. `??=` makes it idempotent. Guests never reach this line.
	 */
	function loadProgressModules() {
		progressModules ??= Promise.all([
			import('$lib/supabase/browser'),
			import('$lib/progress/client')
		]);
		return progressModules;
	}

	/**
	 * One insert attempt for one completed passage. No retry, no backoff, no queue (spec §1),
	 * and never awaited by the render path — the next passage must appear regardless.
	 * `recordChunkAttempt` never throws; a failure is counted, shown nowhere until the summary.
	 */
	async function saveAttempt(
		signedInUserId: string,
		chunkId: string,
		result: ChunkResult,
		startedAt: number
	) {
		// Awaits the warm-up promise, starting it here if the session had no prior keystroke.
		const [{ getBrowserSupabase }, { recordChunkAttempt }] = await loadProgressModules();

		const outcome = await recordChunkAttempt(getBrowserSupabase(), {
			userId: signedInUserId,
			chunkId,
			bookId: book.bookId,
			completed: true,
			grossWpm: result.grossWpm,
			accuracyRaw: result.accuracyRaw,
			elapsedMs: result.elapsedMs,
			startedAt
		});
		if (!outcome.saved) {
			failedSaves += 1;
		}
	}

	/**
	 * The completion instant, in the order brief §3.8 fixes: identify what completed →
	 * advance the optimistic set → gate guests → save.
	 */
	function handleCompletion(previous: SessionState, next: SessionState) {
		const index = previous.activeIndex;
		const result = next.results[index];
		// A `restart-*` event reaches the caller's branch too, and so does a stray event
		// arriving after the session finished. A completion is exactly "a result was frozen
		// at this index by THIS event" — nothing else writes.
		if (!result || previous.results[index]) {
			return;
		}

		const chunk = previous.text.chunks[index];
		completed.add(chunk.id); // optimistic and unconditional — the Set dedupes

		// The guest gate. It sits ABOVE the dynamic import on purpose: a guest must issue no
		// request at all, not a request that fails, and must never fetch the lazy chunk.
		if (userId === null) {
			return;
		}

		// The attempt's first keystroke. `previous` is the state before the completing stroke,
		// so its active chunk still carries the whole traversal. The fallback covers the one
		// degenerate case where the very first stroke also completed the chunk.
		const startedAt = previous.activeChunk.startedAt ?? Date.now() - result.elapsedMs;
		void saveAttempt(userId, chunk.id, result, startedAt);
	}

	/**
	 * Whole-book percent.
	 *
	 * Signed in: book-lifetime completion (spec #12 §4) — the persisted count, advanced
	 * optimistically in-session and clamped so re-reading a book can never exceed 100%.
	 * Guest: today's session-relative figure, completed passages plus the cursor's way
	 * through the active one, unchanged.
	 */
	const pct = $derived.by(() => {
		const total = session.text.chunkCount;
		if (total === 0) {
			return 0; // a book seeded with no chunks would otherwise render NaN%
		}
		if (userId !== null) {
			// `chunksCompleted` (from `book_progress`) and `completed` (from `chunk_progress`)
			// are the same number for consistent data; the max keeps the bar from going
			// backwards if they ever disagree, and the min is the ≤ 100% clamp.
			const count = Math.max(completed.size, chunksCompleted);
			return Math.round((100 * Math.min(count, total)) / total);
		}
		const length = session.activeChunk.display.length;
		const partial = length > 0 ? session.activeChunk.cursor / length : 0;
		return Math.round((100 * (session.activeIndex + partial)) / total);
	});

	/**
	 * Single dispatch point: applies the engine reducer, then refreshes live metrics
	 * ONLY at word boundaries (an expected-space position judged) — never per keystroke,
	 * never on a timer (spec #5).
	 *
	 * Metrics are CUMULATIVE over the session's whole running log (spec #12 §5), so they are
	 * deliberately NOT reset when the active passage changes: the `—` disappears after the
	 * first word of the session and never comes back on a passage boundary, and the last
	 * figure the meta line shows is the same one `sessionSummary.averageWpm` reports. They
	 * are still cleared on a restart or at the summary, where frozen figures take over.
	 */
	function dispatch(event: SessionEvent) {
		const previous = session;
		const next = applySessionEvent(previous, event);
		session = next;

		if (next.activeIndex !== previous.activeIndex || next.finished) {
			handleCompletion(previous, next);
		}

		if (event.type === 'restart-chunk' || event.type === 'restart-session' || next.finished) {
			liveMetrics = null;
			return;
		}

		if (event.type === 'char') {
			if (userId !== null) {
				void loadProgressModules(); // first `char` of the session; idempotent thereafter
			}
			const log = next.activeChunk.log;
			const last = log[log.length - 1];
			if (last?.kind === 'char' && last.expected === ' ') {
				liveMetrics = runningMetrics(next, Date.now()); // word boundary crossed
			}
		}
	}

	function restartChunk() {
		dispatch({ type: 'restart-chunk' });
		surface?.focusInput(); // button-triggered restarts must not strand focus
	}

	function restartSession() {
		dispatch({ type: 'restart-session' });
		// From the summary the surface remounts and focuses itself on mount.
		surface?.focusInput();
	}

	function toggleZen() {
		zen = !zen;
		surface?.focusInput(); // toggling chrome must not strand focus either
	}

	function pickAnother() {
		goto(resolve(localizeHref('/type') as Pathname));
	}

	const buttonClasses =
		'rounded-lg border border-border bg-transparent px-3.5 py-[7px] text-[13px] text-muted transition-colors hover:border-accent hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';
</script>

<main class="mx-auto flex w-full max-w-[860px] flex-col items-center gap-5 px-6 pt-10 pb-24">
	{#if session.finished}
		<SessionSummaryView
			summary={sessionSummary(session)}
			onRestartSession={restartSession}
			onPickAnother={pickAnother}
			{failedSaves}
			signedIn={!!page.data.user}
			next={page.url.pathname + page.url.search}
		/>
	{:else}
		<!-- Exactly two elements of chrome frame the sheet (brief §2): the book
		     line above, the meta line (and its quiet buttons) below. -->
		<!-- The page's h1, styled as quiet chrome: screen readers get structure,
		     sighted users get the brief's minimal book line. -->
		<h1
			class="text-center text-sm font-normal tracking-[0.01em] text-muted"
			data-testid="book-line"
		>
			{book.title} · {book.author}
		</h1>
		<div class="flex w-full justify-center">
			<TypingSurface
				bind:this={surface}
				text={session.activeChunk.text}
				display={session.activeChunk.display}
				cursor={session.activeChunk.cursor}
				passageKey={session.activeIndex}
				onChar={(char, timestamp) => dispatch({ type: 'char', char, timestamp })}
				onBackspace={(timestamp) => dispatch({ type: 'backspace', timestamp })}
				onRestartChunk={restartChunk}
			/>
		</div>
		<PassageMeta
			current={session.activeIndex + 1}
			total={session.text.chunkCount}
			{pct}
			live={liveMetrics}
			{zen}
		/>
		<div class="mt-1 flex flex-wrap justify-center gap-2">
			<button
				type="button"
				data-testid="zen-toggle"
				class={buttonClasses}
				aria-pressed={zen}
				onclick={toggleZen}
			>
				{zen ? m.zen_exit() : m.zen_enter()}
			</button>
			<button
				type="button"
				data-testid="restart-chunk"
				class={buttonClasses}
				onclick={restartChunk}
			>
				{m.passage_restart()}
			</button>
			<button type="button" data-testid="pick-another" class={buttonClasses} onclick={pickAnother}>
				{m.typing_pick_another()}
			</button>
		</div>
	{/if}
</main>
