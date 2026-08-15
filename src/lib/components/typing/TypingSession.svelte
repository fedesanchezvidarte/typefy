<script lang="ts">
	import { untrack } from 'svelte';
	import { SvelteSet, SvelteURLSearchParams } from 'svelte/reactivity';
	import type { Pathname } from '$app/types';
	import { beforeNavigate, pushState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { m } from '$lib/paraglide/messages';
	import { localizeHref } from '$lib/paraglide/runtime';
	import {
		applySessionEvent,
		createSession,
		loadedChunks,
		runningMetrics,
		sessionSummary
	} from '$lib/engine/session';
	import type { ChunkResult, SessionEvent, SessionState } from '$lib/engine/session';
	import { restoreChunk } from '$lib/engine/chunk';
	import type { ChunkEngineState } from '$lib/engine/types';
	import type { MetricsSnapshot } from '$lib/engine/metrics';
	import type {
		ChapterSummary,
		ChunkWindow,
		ChunkWindowResponse,
		Mode,
		TypeableTextSummary,
		WindowProgressResponse
	} from '$lib/types';
	import { seekWindow, shouldPrefetch, WINDOW_SIZE } from '$lib/reading/window';
	// Supabase-free by construction, and it must stay that way: it is imported STATICALLY
	// here, so a Supabase import inside it would land in the guest's entry bundle and break
	// the zero-bytes guarantee `loadProgressModules()` below exists to keep (spec #24 §12).
	import { modeCookie } from '$lib/mode/mode';
	// All three are Supabase-free and therefore STATICALLY importable — that is the whole
	// point of the split (spec #15 §2/§4). `buffer` + `storage` name no browser global but
	// `localStorage`; `drain-once` reaches `@supabase/*` and `drain.ts` only through its own
	// `await import()`. So a guest can enqueue, and a signed-in user can fire a drain, with
	// neither adding a byte of `@supabase/ssr` or `@supabase/supabase-js` to this bundle.
	// `loadProgressModules()` below remains the ONLY path from this component to either.
	import { ATTEMPT_BUFFER_KEY, enqueue, type BufferedChunkAttempt } from '$lib/progress/buffer';
	import { getAttemptStorage } from '$lib/progress/storage';
	import { drainOnce } from '$lib/progress/drain-once';
	// Also Supabase-free (spec #32 §8) — in-page restore never becomes a server write, so it
	// shares the buffer's "statically importable, never touches @supabase/*" guarantee.
	import {
		clearPageState,
		PAGE_STATE_KEY,
		readPageState,
		resolvedPrefixLength,
		savePageState
	} from '$lib/progress/page-state';
	import { activeChapter } from '$lib/library/chapter-progress';
	import { useTypingHeader } from './typing-header.svelte';
	import PageNavigator from './PageNavigator.svelte';
	import SessionSummaryView from './SessionSummary.svelte';
	import TypingSurface from './TypingSurface.svelte';

	interface Props {
		/**
		 * Metadata only. Since spec #18 the component is never handed a whole book — the text
		 * arrives one `ChunkWindow` at a time, and this carries what the chrome needs
		 * (`title`, `author`), what the write path needs (`bookId`) and what the window
		 * endpoint is addressed by (`id`, the slug).
		 */
		book: TypeableTextSummary;
		/**
		 * The FIRST window, server-rendered by the load and starting AT `startIndex`. Read once
		 * to seed the session; every later window arrives through the chunks endpoint into
		 * component state, never through this prop and never through a load invalidation.
		 */
		window: ChunkWindow;
		/** Index the session opens at (resume, or a valid `?passage` override). */
		startIndex: number;
		/** Persisted book-lifetime completion count. 0 for guests. */
		chunksCompleted: number;
		/** Chunk ids already completed at least once. Empty for guests. */
		completedChunkIds: readonly string[];
		/**
		 * The measurement axis this session opens in (spec #24), from the `typefy-mode` cookie as
		 * the route's load read it. **Required, not defaulted**: a future mount site that forgets
		 * it must fail to compile rather than silently render Normal and start measuring someone
		 * who asked not to be. The component is mounted in exactly one place today, so the rule
		 * costs nothing now and buys the guarantee later.
		 *
		 * Read ONCE, to seed the reducer. From mount on the axis lives in `session.mode` and the
		 * toggle owns it — this prop is the starting point, not a binding.
		 */
		mode: Mode;
		/**
		 * The book's chapters (spec #45), for the header's chapter name. Empty is legal and
		 * ordinary — a book with no derivable structure simply shows no chapter (ADR-0017).
		 * Read on every page change through `activeChapter`, so crossing a boundary re-names
		 * the header with no request.
		 */
		chapters?: readonly ChapterSummary[];
		/**
		 * null for a guest — the sole gate on the write path. No insert, no import, no request.
		 *
		 * **It can flip to null mid-session** (ADR-0012, Phase 2c amendment). The parent derives it from
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

	// `window` is renamed on the way in: a local binding called `window` would shadow the
	// browser global for this entire script, which is a trap waiting for the first person to
	// write `window.setTimeout` here. The rename is also honest about the prop's lifetime —
	// it is the seed, not a live view of what the session holds.
	let {
		book,
		window: initialWindow,
		startIndex,
		chunksCompleted,
		completedChunkIds,
		mode,
		chapters = [],
		userId
	}: Props = $props();

	// One session per mounted instance. The parent keys this component on the book id, so
	// `book` never changes here — no mount-time reset that could drop the first keystrokes.
	// `startIndex` is read once for the same reason: a later `?passage=N` navigation must not
	// yank a session that is already underway. `mode` is seeded the same way and for the same
	// reason — the reducer is where the axis lives from here on (spec #24 §11).
	let session = $state.raw<SessionState>(
		untrack(() => {
			const opened = createSession(
				loadedChunks(initialWindow.chunks, initialWindow.chunkCount),
				startIndex,
				mode
			);
			// In-page restore (spec #32 §8), mount-time only: a page left half-typed on a
			// PREVIOUS visit is remembered locally and restored here. It deliberately does
			// NOT apply to an in-session `seek` (see `navigateToIndex`) — the spec's promise
			// is "leaving a page half-typed and returning restores it," which for a live
			// session is exactly the opening chunk, not every chunk ever visited.
			const openingChunk = initialWindow.chunks.find((chunk) => chunk.index === startIndex);
			if (!openingChunk || !opened.activeChunk) {
				return opened;
			}
			const saved = readPageState(
				getAttemptStorage(PAGE_STATE_KEY),
				{
					bookId: book.bookId,
					chunkId: openingChunk.id,
					index: startIndex,
					textLength: openingChunk.content.length
				},
				Date.now()
			);
			if (!saved) {
				return opened;
			}
			return {
				...opened,
				activeChunk: restoreChunk(openingChunk.content, saved.prefixLength)
			};
		})
	);
	let liveMetrics = $state.raw<MetricsSnapshot | null>(null);
	let surface = $state<{ focusInput: () => void } | null>(null);

	/**
	 * The last chunk the session actually had loaded, with the absolute index it was typed
	 * at. This is what the sheet renders, and it is deliberately NOT `session.activeChunk`.
	 *
	 * `activeChunk` goes null the instant the session enters `awaiting`. Rendering from it
	 * directly would unmount `TypingSurface` at a passage boundary — and with it the hidden
	 * input that holds focus, which would die on `<body>` and strand a keyboard-only user
	 * exactly when the app is asking them to wait. Holding the completed passage on screen
	 * instead keeps the input mounted and focused across the boundary, so when the window
	 * lands the user simply carries on typing: no focus event, no re-entry, nothing to
	 * dismiss. That is the whole of the `awaiting` focus criterion (spec #8, phase 8).
	 *
	 * Updated in `dispatch`, which is the only place `session` is ever assigned, so it can
	 * never drift out of step with it.
	 */
	let heldView = $state.raw<{ index: number; chunk: ChunkEngineState } | null>(
		untrack(() =>
			session.activeChunk ? { index: session.activeIndex, chunk: session.activeChunk } : null
		)
	);

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

	/**
	 * Zen, read off the REDUCER rather than held here (spec #24 §11).
	 *
	 * It used to be `let zen = $state(false)` — a per-visit presentation toggle that hid figures
	 * the engine went on computing, forgot itself on every visit, and was invisible to
	 * `chunk_attempts`. Mode is now the engine's measurement axis: the reducer decides what is
	 * measured, so the component must not hold a second opinion about it. One source of truth,
	 * and it is `session.mode`.
	 *
	 * The engine still keeps the keystroke log in Zen; what stops is deriving, displaying and
	 * persisting WPM and accuracy (§2).
	 */
	const zen = $derived(session.mode === 'zen');

	// ── Windowed reading: how far the session is loaded, and how the rest arrives ──────────
	//
	// Everything below is a plain `fetch` to a first-party endpoint. Deliberately NOT a
	// Supabase client call: `@supabase/ssr` and `@supabase/supabase-js` are reached from this
	// component only through `loadProgressModules()`'s dynamic import, and putting a read on
	// the window path would make them a mount-time dependency of showing text — the exact
	// regression the guest bundle guarantee exists to prevent (spec #18 §9).
	//
	// And deliberately NOT `invalidateAll()` or any other load invalidation (spec §6,
	// restating #15 §11): on the typing screen that re-runs the book read and re-serialises
	// mid-passage. Windows arrive here, into component state, and reach the engine as a
	// `window-loaded` event.

	/**
	 * Absolute index one past the last loaded chunk — derived from the engine's own map, so
	 * "how far is loaded" has exactly one source of truth and it is the reducer's.
	 *
	 * Seeded at `activeIndex` rather than 0 so that a session which opened `awaiting` (an
	 * empty first window) asks for the window it is actually blocked on instead of the
	 * beginning of the book. Loaded chunks ACCUMULATE and are never evicted — `sessionSummary`
	 * looks each completed chunk's `charCount` up by absolute index, so dropping a window the
	 * user has left behind would silently drop it from the summary.
	 */
	const loadedEnd = $derived.by(() => {
		let end = session.activeIndex;
		for (const index of session.text.chunks.keys()) {
			if (index + 1 > end) {
				end = index + 1;
			}
		}
		return end;
	});

	/**
	 * The in-flight window fetch, one per component instance — the same single-flight shape
	 * `drainOnce` established: `??=`-assigned, cleared in `.finally()`, so the four triggers
	 * below (threshold, `awaiting`, completion, `online`) join one request instead of racing
	 * four copies of the same window into the reducer.
	 */
	let inFlightWindow: Promise<void> | null = null;

	/**
	 * True when the last window fetch did not deliver and none has succeeded since.
	 *
	 * It is NOT an error banner: nothing reads it while the user is still typing (spec §6 —
	 * a failure is never surfaced mid-passage). It only decides which of two things the
	 * `awaiting` panel says once the session has actually run out of text: "loading" or "this
	 * is as far as this device got". A success clears it, which is what makes the
	 * end-of-window state resolve by itself when connectivity returns (spec §8).
	 */
	let windowStalled = $state(false);

	function prefetchWindow(): Promise<void> {
		return (inFlightWindow ??= runWindowFetch().finally(() => {
			inFlightWindow = null;
		}));
	}

	/**
	 * One window fetch. **Never rejects and never throws** — it runs behind the typing path
	 * with nobody awaiting it, and typing must not be able to notice it happened.
	 */
	async function runWindowFetch(): Promise<void> {
		const from = loadedEnd;
		if (from >= session.text.chunkCount) {
			// Everything the book has is already loaded. Nothing outstanding, so nothing stalled.
			windowStalled = false;
			return;
		}

		try {
			// `from` and `limit` are always sent as base-10 digits with `limit >= 1`; the
			// endpoint 400s on anything else. A `limit` above the maximum is clamped rather
			// than rejected, so the response's own `from` + `chunks.length` is what the next
			// request is built from — never this request's numbers.
			const response = await fetch(
				`/api/books/${encodeURIComponent(book.id)}/chunks?from=${from}&limit=${WINDOW_SIZE}`
			);
			if (!response.ok) {
				windowStalled = true;
				return;
			}
			const body = (await response.json()) as ChunkWindowResponse;

			// The response's `chunkCount` is adopted wholesale by the reducer — that is how a
			// session holding a stale bound reconciles when a re-ingest grew or shrank the book
			// underneath it.
			dispatch({
				type: 'window-loaded',
				chunks: body.chunks,
				chunkCount: body.chunkCount,
				timestamp: Date.now()
			});

			// An empty window below the end of the book delivered nothing and resolved nothing:
			// treat it as a stall so the session says so rather than waiting forever on a
			// request that already came back.
			windowStalled = body.chunks.length === 0 && body.from < body.chunkCount;

			if (userId !== null && body.chunks.length > 0) {
				void mergeWindowProgress(body.from, body.chunks.length);
			}
		} catch {
			// Offline, a dropped connection, a body that would not parse. Swallowed on purpose:
			// the next completion or the next `online` event retries, and the user is told
			// nothing unless and until the session actually runs out of text.
			windowStalled = true;
		}
	}

	/**
	 * The window's completed ids, from the separate private endpoint (spec #18 §4). Called
	 * only when signed in — a guest issues no progress request at all.
	 *
	 * Merged with `add`, **never by replacing the set**: ids this session added optimistically
	 * at a completion instant are not in the server's answer yet, and replacing would drop
	 * them. A failure here is cosmetic by design — some completion markers are missing until
	 * the next load — and must never stall typing, which is why it is not awaited and never
	 * throws.
	 */
	async function mergeWindowProgress(from: number, limit: number) {
		try {
			const response = await fetch(
				`/api/books/${encodeURIComponent(book.id)}/progress?from=${from}&limit=${limit}`
			);
			if (!response.ok) {
				return;
			}
			const body = (await response.json()) as WindowProgressResponse;
			for (const id of body.completedChunkIds) {
				completed.add(id);
			}
		} catch {
			// Cosmetic. Nothing to report, nothing to retry — the next load re-seeds the set.
		}
	}

	/**
	 * The retry trigger, shared by "a passage was completed" and the browser's `online` event.
	 *
	 * Gated rather than unconditional: firing on every completion would walk the whole book
	 * down a window at a time, since each success advances `loadedEnd` and the next completion
	 * would ask for the window after it. So it only fires when there is something to recover
	 * (a stall), something to wait on (`awaiting`), or something the threshold already wants.
	 */
	function retryWindow() {
		if (
			windowStalled ||
			session.status === 'awaiting' ||
			shouldPrefetch(session.activeIndex, loadedEnd, session.text.chunkCount)
		) {
			void prefetchWindow();
		}
	}

	/**
	 * The threshold trigger. `shouldPrefetch` is true from three passages out AND stays true
	 * once `activeIndex` reaches `loadedEnd`, so this one effect covers both "fetch ahead" and
	 * "fetch what we are already blocked on" — the awaiting case needs no separate wiring,
	 * only the same predicate evaluated in the same place.
	 *
	 * Nothing here blocks input: the effect fires a promise nobody awaits, and the reducer
	 * keeps accepting keystrokes for the whole flight.
	 */
	$effect(() => {
		if (shouldPrefetch(session.activeIndex, loadedEnd, session.text.chunkCount)) {
			void prefetchWindow();
		}
	});

	/**
	 * What the window live region says, and what the awaiting panel shows. Empty whenever the
	 * session is not waiting — the region itself still renders (see its comment in the markup).
	 */
	const windowStatus = $derived(
		session.status !== 'awaiting' ? '' : windowStalled ? m.page_window_end() : m.page_loading()
	);

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
			// Nullable since spec #24: a traversal with ANY Zen time in it carries no figures at
			// all. The buffer's guard accepts `null` for exactly these two fields — if it did not,
			// every guest's Zen completion would read back as malformed and be silently dropped.
			grossWpm: result.grossWpm,
			accuracyRaw: result.accuracyRaw,
			elapsedMs: result.elapsedMs,
			startedAt,
			// Always written, even though the buffer tolerates their ABSENCE on read: that
			// tolerance is for pre-4a entries sitting in browsers today, not a licence for new
			// entries to omit them (spec #24 §9). A row that carries figures must carry the span
			// it measured alongside them.
			mode: result.mode,
			measuredMs: result.measuredMs,
			measuredChars: result.measuredChars,
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
			// Nullable metrics plus the span that produced them (spec #24 §5). The engine has
			// already applied the whole-clean-traversal rule: any Zen time in this passage and
			// `mode` is `'zen'` with both figures `null`, while `measuredMs`/`measuredChars` still
			// record what WAS measured. Nothing is recomputed or second-guessed here.
			grossWpm: result.grossWpm,
			accuracyRaw: result.accuracyRaw,
			elapsedMs: result.elapsedMs,
			startedAt,
			mode: result.mode,
			measuredMs: result.measuredMs,
			measuredChars: result.measuredChars
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

	// ── In-page restore: the write side (spec #32 §8) ──────────────────────────────────
	//
	// A page's typed-but-unresolved prefix is persisted locally so a return trip restores
	// it (the READ side lives in `session`'s initialiser above). Written debounced during
	// typing, flushed immediately on `visibilitychange -> hidden` and `beforeNavigate`
	// (NOT `beforeunload`, unreliable on mobile — the case this exists for), and cleared
	// on completion, since the `chunk_attempts` row supersedes it.

	let pageStateSaveTimer: ReturnType<typeof setTimeout> | undefined;

	/** The current page's remembered shape, or `null` if there is nothing worth saving. */
	function currentPageStateEntry() {
		const chunk = session.text.chunks.get(session.activeIndex);
		if (!chunk || !session.activeChunk) return null;
		return {
			bookId: book.bookId,
			chunkId: chunk.id,
			index: session.activeIndex,
			prefixLength: resolvedPrefixLength(session.activeChunk.display),
			savedTextLength: chunk.content.length,
			savedAt: Date.now()
		};
	}

	/** Immediate write. `savePageState` itself clears the slot when `prefixLength` is 0. */
	function persistPageStateNow() {
		if (session.status !== 'active') return;
		const entry = currentPageStateEntry();
		if (!entry) return;
		savePageState(getAttemptStorage(PAGE_STATE_KEY), entry, Date.now());
	}

	/** The debounced path, ~2s after the last keystroke (brief §8). */
	function schedulePageStateSave() {
		if (pageStateSaveTimer) clearTimeout(pageStateSaveTimer);
		pageStateSaveTimer = setTimeout(persistPageStateNow, 2000);
	}

	/**
	 * The completion instant, in the order brief §3.8 fixes: identify what completed →
	 * advance the optimistic set → gate guests → save.
	 */
	function handleCompletion(previous: SessionState, next: SessionState) {
		const index = previous.activeIndex;
		const result = next.results.get(index);
		// A `restart-*` event reaches the caller's branch too, and so does a stray event
		// arriving after the session finished. A completion is exactly "a result was frozen
		// at this index by THIS event" — nothing else writes. `results` is a sparse Map keyed
		// by ABSOLUTE index since spec #18, so this is `get`/`has`, never `[index]`, which
		// would silently be `undefined` for every index and drop every save.
		if (!result || previous.results.has(index)) {
			return;
		}

		const chunk = previous.text.chunks.get(index);
		if (!chunk) {
			// Unreachable: a chunk cannot complete without having been loaded. Stated rather
			// than asserted away, because the alternative is a crash on the completion instant.
			return;
		}
		completed.add(chunk.id); // optimistic and unconditional — the Set dedupes

		// The page-state row for the page that just finished is now stale: the attempt row
		// supersedes it. Cancel any pending debounced write first, or a write scheduled a
		// moment before completion could land after the clear and resurrect it.
		if (pageStateSaveTimer) {
			clearTimeout(pageStateSaveTimer);
			pageStateSaveTimer = undefined;
		}
		clearPageState(getAttemptStorage(PAGE_STATE_KEY), { bookId: book.bookId, index }, Date.now());

		// The attempt's first keystroke. `previous` is the state before the completing stroke,
		// so its active chunk still carries the whole traversal. The fallback covers the one
		// degenerate case where the very first stroke also completed the chunk.
		//
		// Hoisted above the guest gate (it used to sit below): a buffered guest entry carries
		// the genuine first-keystroke timestamp too, and it is what the database's unique
		// index dedupes on. Pure arithmetic over `previous`, so the move changes nothing else.
		const startedAt = previous.activeChunk?.startedAt ?? Date.now() - result.elapsedMs;

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
		// Read off `heldView`, not `session.activeChunk`, which is null while awaiting. The
		// held passage IS the last honest reading: awaiting one, its cursor sits at the end of
		// the passage just completed, so `index + partial` lands exactly on the index being
		// awaited. The figure holds instead of collapsing to a wrong number for the duration
		// of a fetch nobody asked for.
		const base = heldView ? heldView.index : session.activeIndex;
		const length = heldView ? heldView.chunk.display.length : 0;
		const partial = heldView && length > 0 ? heldView.chunk.cursor / length : 0;
		return Math.round((100 * (base + partial)) / total);
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

		// Kept in step with `session` on every event, before any early return below. Null
		// `activeChunk` (the session is awaiting) leaves the previous passage held.
		if (next.activeChunk !== null) {
			heldView = { index: next.activeIndex, chunk: next.activeChunk };
		}

		// In-page restore's write side (spec #32 §8): every real keystroke reschedules the
		// debounced save. A completion cancels it again in `handleCompletion`, so a save that
		// was already in flight cannot resurrect a page that just finished.
		if (event.type === 'char' || event.type === 'backspace') {
			schedulePageStateSave();
		}

		if (next.activeIndex !== previous.activeIndex || next.status === 'finished') {
			handleCompletion(previous, next);
			// A completed passage is also the retry point for a window fetch that failed
			// earlier (spec §6). Gated inside `retryWindow`, so an ordinary completion in the
			// middle of a loaded window costs nothing.
			retryWindow();
		}

		if (
			event.type === 'restart-chunk' ||
			event.type === 'restart-session' ||
			next.status === 'finished'
		) {
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
			// `?? []` covers the one case the reducer allows: a keystroke arriving while
			// awaiting is dropped and returns the identical state, whose `activeChunk` is null.
			const log = next.activeChunk?.log ?? [];
			const last = log[log.length - 1];
			// Gated on the mode as well as the boundary: in Zen nothing is derived at all
			// (spec #24 §2), so the refresh is simply not taken.
			//
			// `liveMetrics` is deliberately NOT nulled on a switch INTO Zen. The last figure is
			// still the last true reading of this session's measured spans, and the meta line
			// does not show it in Zen anyway — nulling would only make `—` flash on the return to
			// Normal, before the next word boundary produces a fresh one.
			if (next.mode === 'normal' && last?.kind === 'char' && last.expected === ' ') {
				liveMetrics = runningMetrics(next, Date.now()); // word boundary crossed
			}
		}
	}

	// ── Page navigator: the A' engine seek (spec #32 §10 D1) ───────────────────────────
	//
	// A jump never remounts `TypingSession` (see `+page.svelte`'s comment) — it is handled
	// entirely in-engine, via `session.ts`'s `seek` event, and the URL is updated with
	// SvelteKit's SHALLOW routing (`pushState`) so it reflects the new page without a load
	// re-run. That covers the in-window case for free: `applySessionEvent` already has the
	// target chunk loaded, so the jump is instant.
	//
	// When the target is OUTSIDE the loaded window, `applySeek` still moves the session
	// there — `status` becomes `awaiting` and `seekPending` is set — but there is no text to
	// render yet. `runSeekWindowFetch` is the real fetch/network half: it asks the chunks
	// endpoint for a FRESH window anchored at the target (`seekWindow`, not `loadedEnd` —
	// a jump is not a prefetch), and `window-loaded` REPLACES the loaded map rather than
	// merging onto it (`session.ts`'s `seekPending` branch), so a long session that seeks
	// around a book does not accumulate every window it ever visited.

	/** Absolute-index navigation (0-based), shared by "previous", "next" and the jump box. */
	function navigateToIndex(target: number) {
		const total = session.text.chunkCount;
		if (total <= 0) return;
		const clamped = Math.min(Math.max(target, 0), total - 1);
		if (clamped === session.activeIndex) return;

		// Flush whatever is typed on the page being LEFT — a debounced save still in flight
		// would otherwise race the seek and could write against the wrong index.
		persistPageStateNow();
		if (pageStateSaveTimer) {
			clearTimeout(pageStateSaveTimer);
			pageStateSaveTimer = undefined;
		}

		dispatch({ type: 'seek', index: clamped, timestamp: Date.now() });
		updateUrlForIndex(clamped);

		if (session.status === 'awaiting' && session.seekPending) {
			void runSeekWindowFetch(clamped);
		}
		surface?.focusInput(); // a navigator click must not strand a keyboard-only user
	}

	/**
	 * `?page=` becomes canonical the instant a jump happens (spec #32 §6): a stale
	 * `?passage=` in the address bar is replaced rather than left alongside it, so the URL
	 * a user might copy from here on always reads the current term.
	 *
	 * Built from `book.id` (the book's SLUG — see `TypeableTextSummary`, confusingly named
	 * `id`), not from `page.url.pathname`: this route's own pathname is already known from
	 * the prop the component was mounted with, so there is no reason to trust the ambient
	 * `page.url` for it — and `resolve()` throws on anything that isn't an absolute pathname,
	 * which `page.url.pathname` is not guaranteed to be outside a real, fully-hydrated
	 * navigation (a component-test harness in particular).
	 *
	 * The whole pathname+query string is built INSIDE the `resolve()` call, as one argument —
	 * not built up outside it and concatenated on, which `svelte/no-navigation-without-resolve`
	 * does not trace through, and would flag as an unvalidated `pushState()` target.
	 */
	function updateUrlForIndex(index: number) {
		const params = new SvelteURLSearchParams(page.url.search);
		params.delete('passage');
		params.set('page', String(index + 1));
		pushState(resolve(`${localizeHref(`/type/${book.id}`)}?${params}` as Pathname), {});
	}

	/**
	 * The seek's own window fetch — anchored at the TARGET (`seekWindow`), never at
	 * `loadedEnd` like `runWindowFetch`'s prefetch. Not routed through `prefetchWindow`'s
	 * single-flight promise: a user-triggered jump is rare enough that racing an ordinary
	 * prefetch is an acceptable trade against the complexity of a second single-flight
	 * lane, and `window-loaded`'s `seekPending` handling in `session.ts` is what keeps the
	 * REPLACE (rather than merge) correct regardless of arrival order.
	 */
	async function runSeekWindowFetch(index: number): Promise<void> {
		const bounds = seekWindow(index, session.text.chunkCount);
		if (bounds.limit <= 0) {
			windowStalled = true;
			return;
		}
		try {
			const response = await fetch(
				`/api/books/${encodeURIComponent(book.id)}/chunks?from=${bounds.from}&limit=${bounds.limit}`
			);
			if (!response.ok) {
				windowStalled = true;
				return;
			}
			const body = (await response.json()) as ChunkWindowResponse;
			dispatch({
				type: 'window-loaded',
				chunks: body.chunks,
				chunkCount: body.chunkCount,
				timestamp: Date.now()
			});
			windowStalled = body.chunks.length === 0 && body.from < body.chunkCount;
			if (userId !== null && body.chunks.length > 0) {
				void mergeWindowProgress(body.from, body.chunks.length);
			}
		} catch {
			windowStalled = true;
		}
	}

	// Flush on the two reliable "the user might be leaving" signals (brief §8) — NOT
	// `beforeunload`, unreliable on mobile, which is exactly the case in-page restore
	// exists for. Registered at component init, SvelteKit's own lifecycle-function shape.
	beforeNavigate(() => {
		persistPageStateNow();
	});

	/**
	 * The mode switch (spec #24 §11). Three things, in this order.
	 *
	 * 1. **Dispatch.** The reducer opens or closes the unmeasured span at this instant, so
	 *    measurement stops and resumes exactly where the user asked — mid-word, mid-passage or
	 *    between passages. It touches nothing else: not the active chunk, not the log, not the
	 *    status. `session.mode` is then the new value, which is what `zen` reads.
	 * 2. **Persist**, from `session.mode` rather than from the local expression, so the cookie
	 *    can only ever record what the reducer actually accepted.
	 * 3. **Focus.** Toggling chrome must not strand a keyboard-only user, exactly as before.
	 */
	function toggleZen() {
		dispatch({ type: 'set-mode', mode: zen ? 'normal' : 'zen', timestamp: Date.now() });
		document.cookie = modeCookie(session.mode);
		surface?.focusInput();
	}

	// ── The header's center slot (spec #45) ────────────────────────────────────────────
	//
	// The chrome that used to sit under the sheet lives in `AppHeader` now, and this is how it
	// gets there: a context store the root layout created above the header, written from here.
	// The load's `typingHeader` seed already rendered the same opening values on the server,
	// so the swap at hydration is invisible — see `AppHeader.svelte` for why both exist.

	const headerStore = useTypingHeader();

	/**
	 * The chapter the ACTIVE page falls in, re-derived on every page change — including a page
	 * navigator jump, which is why this is a `$derived` over the session rather than something
	 * the load computed once. `activeChapter` is the same fold the book detail screen's ranges
	 * come from (ADR-0017), so the header can never name a chapter that screen disagrees with.
	 */
	const chapterTitle = $derived(activeChapter(chapters, session.activeIndex)?.title ?? null);

	$effect(() => {
		if (!headerStore) return;
		headerStore.view = {
			title: book.title,
			author: book.author,
			chapter: chapterTitle,
			current: session.activeIndex + 1,
			total: session.text.chunkCount,
			pct,
			live: liveMetrics,
			zen,
			onToggleZen: toggleZen
		};
	});

	/*
	 * Cleared on unmount, and ONLY on unmount — an effect with no reactive reads, so it never
	 * re-runs and never fights the one above. Without it, navigating from a book to the library
	 * would leave the last page's figures stranded in the header.
	 */
	$effect(() => () => {
		if (headerStore) headerStore.view = null;
	});
</script>

<!--
	`online` is the second half of the offline story (spec §6, §8). The typing screen is the
	one place a window can be missing, so it is the one place that has to notice connectivity
	coming back. `<svelte:window>` rather than a manual `addEventListener` in an `$effect`:
	Svelte owns the teardown, and the local prop rename above means the global is not shadowed
	here either way.
-->
<svelte:window ononline={retryWindow} />
<!-- The third in-page-restore flush trigger (spec #32 §8): a tab switch or a phone's
     screen lock fires `visibilitychange -> hidden` without any navigation happening at
     all, which `beforeNavigate` cannot see. -->
<svelte:document
	onvisibilitychange={() => {
		if (document.visibilityState === 'hidden') persistPageStateNow();
	}}
/>

<!--
	Two layouts, one element (spec #45).

	While typing, the shell is PINNED: exactly the viewport minus the header, so the card fills
	the screen and the document never scrolls — the text scrolls inside the card instead. At the
	summary the pin is dropped and the old comfortable padding returns, because a fixed height
	there would clip the figures on a short viewport.
-->
<main
	class={[
		'mx-auto flex w-full max-w-[900px] flex-col items-center px-4 sm:px-6',
		session.status === 'finished' ? 'gap-5 pt-10 pb-24' : 'typing-shell'
	]}
>
	<!--
		THE WINDOW LIVE REGION. It renders UNCONDITIONALLY, in every state of the session,
		and only its TEXT changes.

		That is a structural requirement, not styling (spec #18 §8, and the trap spec #15
		phase 2c already hit on the summary's save notices): a live region inserted into the
		DOM in the same mutation as its content is not announced at all — the screen reader
		has nothing registered to watch when the content arrives. Guarding this node with
		`status === 'awaiting'` would rebuild the region together with its message and
		reproduce exactly the silence it exists to prevent. So the node is always here; empty,
		it renders nothing and occupies nothing.

		It is `sr-only` because the same words are already on screen in the awaiting panel
		below. The panel is NOT a live region and NOT `aria-hidden`: an insertion into a
		non-live subtree is silent, so nothing is announced twice, and the visible statement
		still exists in the accessibility tree for anyone browsing rather than listening.
	-->
	<p class="sr-only" role="status" aria-live="polite" data-testid="window-status">
		{windowStatus}
	</p>
	{#if session.status === 'finished'}
		<SessionSummaryView
			summary={sessionSummary(session)}
			{failedSaves}
			{pendingSaves}
			signedIn={!!page.data.user}
			next={page.url.pathname + page.url.search}
		/>
	{:else}
		<!--
			The page's h1. Visually hidden since spec #45: the title and author now read in the
			header's center slot, and repeating them above the card would spend a line of the
			card's height saying the same thing twice. Heading structure is unchanged for
			anyone using assistive technology, which is the only reason this node exists.
		-->
		<h1 class="sr-only" data-testid="book-line">{book.title} · {book.author}</h1>
		<!--
			The sheet renders from `heldView`, never from `session.activeChunk` — see its
			declaration. The surface therefore stays MOUNTED across a window boundary, which is
			what keeps the hidden input (and focus) alive while the session is awaiting. The
			passage just completed stays on screen, frozen: `cursor={-1}` puts the caret
			nowhere, so nothing blinks in a place typing would not go.

			The wrapper is the flex child that gives the pinned card its height (spec #45):
			`min-h-0` because a flex child's default `min-height: auto` would let a tall page
			push the card past the viewport and put the document back into scroll.
		-->
		<div class="relative flex min-h-0 w-full flex-1 justify-center">
			<TypingSurface
				bind:this={surface}
				text={heldView?.chunk.text ?? ''}
				display={heldView?.chunk.display ?? []}
				typed={heldView?.chunk.typed ?? []}
				cursor={session.status === 'active' ? (heldView?.chunk.cursor ?? -1) : -1}
				passageKey={heldView?.index ?? session.activeIndex}
				onChar={(char, timestamp) => dispatch({ type: 'char', char, timestamp })}
				onBackspace={(timestamp) => dispatch({ type: 'backspace', timestamp })}
			/>
			{#if session.status === 'awaiting'}
				<!--
					The awaiting panel: the session is between passages, waiting for its window.

					`data-state` is what separates the two readings a stopped session can have —
					`loading` (a window is on its way) and `stalled` (this device has typed to the
					end of what it holds, spec §8). Neither is the finished-book summary, which is a
					different component entirely, with a heading, four figures and its own focus.
					This is one quiet line in the same muted register as the rest of the chrome, and
					it takes no focus at all: the input above still has it, so the moment the window
					lands the user types on without touching anything.

					An OVERLAY on the card's bottom edge since spec #45, not a block below it: the
					card is pinned, and a panel that took its own height would resize the page under
					the typist at the one moment the layout should be still.
				-->
				<div
					data-testid="page-awaiting"
					data-state={windowStalled ? 'stalled' : 'loading'}
					class="awaiting"
				>
					<p class="text-sm text-fg">{windowStatus}</p>
					{#if windowStalled}
						<p class="text-[13px] text-muted" data-testid="page-awaiting-hint">
							{m.page_window_end_hint()}
						</p>
					{/if}
				</div>
			{/if}
		</div>
		<PageNavigator
			current={session.activeIndex + 1}
			total={session.text.chunkCount}
			onNavigate={navigateToIndex}
		/>
	{/if}
</main>

<style>
	/*
	 * The pinned shell (spec #45). `svh` rather than `vh`: on mobile `vh` is the LARGE viewport,
	 * which sits behind the browser's own chrome and would push the page navigator off the
	 * bottom of the screen.
	 */
	.typing-shell {
		height: calc(100svh - var(--header-h));
		gap: 10px;
		padding-top: 14px;
		padding-bottom: 14px;
	}

	/*
	 * The awaiting overlay (spec #45): pinned to the card's bottom edge, inside the card's
	 * own bounds, over a background that fades into the sheet so the text behind it does not
	 * read through the message.
	 */
	.awaiting {
		position: absolute;
		right: 0;
		bottom: 0;
		left: 0;
		display: flex;
		flex-direction: column;
		gap: 6px;
		border-radius: 0 0 12px 12px;
		padding: 14px 20px 18px;
		text-align: center;
		background: linear-gradient(to top, var(--sheet) 62%, transparent);
	}
</style>
