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
	// All three are Supabase-free and therefore STATICALLY importable — that is the whole
	// point of the split (spec #15 §2/§4). `buffer` + `storage` name no browser global but
	// `localStorage`; `drain-once` reaches `@supabase/*` and `drain.ts` only through its own
	// `await import()`. So a guest can enqueue, and a signed-in user can fire a drain, with
	// neither adding a byte of `@supabase/ssr` or `@supabase/supabase-js` to this bundle.
	// `loadProgressModules()` below remains the ONLY path from this component to either.
	import { ATTEMPT_BUFFER_KEY, enqueue, type BufferedChunkAttempt } from '$lib/progress/buffer';
	import { getAttemptStorage } from '$lib/progress/storage';
	import { drainOnce } from '$lib/progress/drain-once';
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
		/**
		 * null for a guest — the sole gate on the write path. No insert, no import, no request.
		 *
		 * **It can flip to null mid-session** (spec #15 §10 R3b). The parent derives it from
		 * `page.data.user`, so a post-drain `invalidateAll()` that finds the session expired
		 * re-renders this prop as `null`, and every later completion is enqueued as
		 * *guest-authored* rather than owned. Accepted deliberately rather than defended
		 * against: a guest-authored entry is not lost, it is attributable to whoever signs in
		 * next on this browser (§1), which for an expired-then-renewed session is the same
		 * person — so the passages still backfill. Freezing `userId` at mount would instead
		 * keep stamping a user id whose token is gone, buffering entries that only ever drain
		 * under that one id. The looser attribution is the recoverable failure of the two.
		 */
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
	 *
	 * **The consequence, now that a drain can call `invalidateAll()` (spec #15 §4): this set
	 * is seeded, not live.** A backfill that persists ids while this session is mounted
	 * re-runs the load, but `untrack` means the fresh `completedChunkIds` is never folded in
	 * here — only the reactive `chunksCompleted` below updates. `pct` survives that because
	 * it takes `Math.max(completed.size, chunksCompleted)`, so the NUMBER self-corrects while
	 * the SET does not. Left as is on purpose: refreshing the set would need it to be
	 * `$derived`, which would also let a mid-session reload discard ids added optimistically
	 * since. Nothing else reads the set today — **any future consumer must not assume the set
	 * and the count agree after a drain.**
	 */
	const completed = untrack(() => new SvelteSet(completedChunkIds));

	/**
	 * Count of inserts that came back `{ saved: false }`, for ANY reason — its spec #12
	 * meaning, unchanged. Stated once, on the summary.
	 */
	let failedSaves = $state(0);

	/**
	 * The subset of `failedSaves` that failed **transiently** and was therefore buffered
	 * (spec #15 §3). Tracked separately because the summary now tells two different truths:
	 * `pendingSaves` passages are pending, not lost, and `failedSaves - pendingSaves` are
	 * genuinely lost. Collapsing the two would report a passage waiting on the network as
	 * discarded.
	 */
	let pendingSaves = $state(0);

	// Zen mode (spec #9): a per-visit presentation toggle — the engine keeps
	// logging (the keystroke log is the single source of truth); only the meta
	// line's metric segments are subtracted.
	let zen = $state(false);

	type ProgressModules = [
		typeof import('$lib/supabase/browser'),
		typeof import('$lib/progress/client')
	];

	/**
	 * The lazily-loaded write path. `$lib/supabase/browser` and `$lib/progress/client` are
	 * reached ONLY through this dynamic import, so `@supabase/ssr` + `@supabase/supabase-js`
	 * are emitted as a separate chunk that is never in the entry graph and a guest never
	 * fetches (brief §1.6). No static import of either module may exist in any component,
	 * and no `modulepreload` hint may be added for the chunk.
	 *
	 * Holds an in-flight or fulfilled load only. A **rejected** load is never left here — see
	 * `loadProgressModules` for why that distinction is the whole bug this memo once had.
	 */
	let progressModules: Promise<ProgressModules> | null = null;

	/**
	 * Starts the import if it has not started, and returns the one shared promise. Called
	 * without awaiting on the session's first `char` event when signed in, so the completion
	 * instant is not paying for a cold network fetch; awaited at the completion instant
	 * itself. Idempotent while a load is in flight or already done. Guests never reach here.
	 *
	 * **A failed fetch of the lazy chunk is TRANSIENT**, exactly like a failed write: the same
	 * import succeeds the moment connectivity is back. So the memo must not keep the rejection.
	 * It used to (`progressModules ??= …`), which turned one offline moment into every later
	 * passage of that session being dropped the same silent way. The memo is cleared only if it
	 * still holds THIS attempt, so a retry another completion already started is never
	 * discarded by a late rejection from the attempt it replaced.
	 *
	 * Attaching the handler here is also what makes the bare `void loadProgressModules()`
	 * warm-up call site safe: the promise is handled from birth, so a warm-up that fails can
	 * never surface as an unhandled rejection, and it counts nothing — the completion instant
	 * is the only place a passage is accounted for. Callers that `await` still see the failure:
	 * `.catch()` returns a NEW promise and leaves this one rejected.
	 */
	function loadProgressModules(): Promise<ProgressModules> {
		if (progressModules === null) {
			const attempt: Promise<ProgressModules> = Promise.all([
				import('$lib/supabase/browser'),
				import('$lib/progress/client')
			]);
			attempt.catch(() => {
				if (progressModules === attempt) {
					progressModules = null;
				}
			});
			progressModules = attempt;
		}
		return progressModules;
	}

	/**
	 * Buffers one completed passage that could not be persisted (spec #15 §3) — a guest's
	 * (`entryUserId === null`, attributable to whoever signs in next on this browser) or a
	 * signed-in user's transient failure (their own id, drainable only under it).
	 *
	 * Synchronous and total: `enqueue` swallows an absent binding, a parse failure and a
	 * quota error alike, so this call can sit on the completion instant without a `try` and
	 * without an `await`. A permanent failure never reaches here — retrying a refused row
	 * cannot succeed, so buffering it would only strand the entries behind it.
	 *
	 * The storage port is constructed per call rather than once at component init on purpose:
	 * this script also runs during SSR, where `getAttemptStorage` resolves to `null`, and a
	 * captured `null` would silently disable buffering for the hydrated instance.
	 */
	function enqueueAttempt(
		entryUserId: string | null,
		chunkId: string,
		result: ChunkResult,
		startedAt: number
	) {
		const now = Date.now();
		const entry: BufferedChunkAttempt = {
			userId: entryUserId,
			chunkId,
			bookId: book.bookId,
			completed: true,
			grossWpm: result.grossWpm,
			accuracyRaw: result.accuracyRaw,
			elapsedMs: result.elapsedMs,
			startedAt,
			bufferedAt: now
		};
		enqueue(getAttemptStorage(ATTEMPT_BUFFER_KEY), entry, now);
	}

	/**
	 * One insert attempt for one completed passage. No retry, no backoff (spec #12 §1) — the
	 * attempt buffer is the only retry mechanism in the system, and it works by replaying the
	 * entry later, never by re-issuing this call. Never awaited by the render path: the next
	 * passage must appear regardless.
	 *
	 * `recordChunkAttempt` never throws; a failure is counted, shown nowhere until the summary.
	 * Loading the module that provides it CAN fail, and that failure is handled the same way.
	 */
	async function saveAttempt(
		signedInUserId: string,
		chunkId: string,
		result: ChunkResult,
		startedAt: number
	) {
		let modules: ProgressModules;
		try {
			// Awaits the warm-up promise, starting it here if the session had no prior keystroke.
			modules = await loadProgressModules();
		} catch {
			// The write path could not even be loaded: the user went offline before their first
			// keystroke of the session, or their first keystroke was also the completing one on a
			// short passage, so the warm-up never got a chance to fetch the chunk while online.
			// This is a transient failure — the chunk is still on the server — so it takes the
			// same path as a transient write failure: counted, buffered, replayed by the drain.
			// It used to take no path at all, and the passage was dropped silently: not saved,
			// not counted, not buffered, visible only as an unhandled rejection in the console.
			failedSaves += 1;
			pendingSaves += 1;
			enqueueAttempt(signedInUserId, chunkId, result, startedAt);
			return;
		}
		const [{ getBrowserSupabase }, { recordChunkAttempt }] = modules;

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
			// Transient (offline, 5xx, a token mid-refresh): a later attempt can succeed, so
			// buffer it and say so on the summary. Permanent (an RLS refusal, a dead
			// `chunk_id`, a malformed row) is NOT buffered — it can never succeed, and it is
			// the one thing the summary still reports as lost.
			if (outcome.reason === 'transient') {
				pendingSaves += 1;
				enqueueAttempt(signedInUserId, chunkId, result, startedAt);
			}
			return;
		}

		// A successful write proves there is connectivity AND a valid token right now, which
		// is the cheapest signal we will ever get that a backlog can be flushed (spec #15 §4).
		// `drainOnce` is single-flight and re-checks the buffer synchronously before importing
		// anything, so on the overwhelmingly common empty-buffer path this costs one
		// `localStorage` read. Not awaited — nothing here may hold up the next passage.
		//
		// Deliberately NO `invalidateAll()` (spec §11): on the typing screen that re-runs
		// `safeGetSession()` and re-serialises the whole book text mid-passage, to refresh
		// figures `completed` has already advanced optimistically. The mount and `online`
		// triggers in `+layout.svelte` own that call.
		void drainOnce(signedInUserId);
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

		// The attempt's first keystroke. `previous` is the state before the completing stroke,
		// so its active chunk still carries the whole traversal. The fallback covers the one
		// degenerate case where the very first stroke also completed the chunk.
		//
		// Hoisted above the guest gate (it used to sit below): a buffered guest entry carries
		// the genuine first-keystroke timestamp too, and it is what the database's unique
		// index dedupes on. Pure arithmetic over `previous`, so the move changes nothing else.
		const startedAt = previous.activeChunk.startedAt ?? Date.now() - result.elapsedMs;

		// The guest gate. It still sits ABOVE the dynamic import: a guest must issue no request
		// at all, not a request that fails, and must never fetch the lazy Supabase chunk.
		// Enqueuing does not weaken that — `enqueue` is a synchronous `localStorage` write from
		// a statically-imported, Supabase-free module. What changes is only that the completion
		// is now kept instead of dropped, ready for the sign-in the summary is about to offer.
		if (userId === null) {
			enqueueAttempt(null, chunk.id, result, startedAt);
			return;
		}

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
				// First `char` of the session; idempotent thereafter. Safe to fire and forget:
				// `loadProgressModules` handles its own rejection (and clears the memo, so the
				// next keystroke or the completion retries the fetch), and counts nothing here.
				void loadProgressModules();
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
			{pendingSaves}
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
