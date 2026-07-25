<script lang="ts">
	import { untrack } from 'svelte';
	import type { Pathname } from '$app/types';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { m } from '$lib/paraglide/messages';
	import { localizeHref } from '$lib/paraglide/runtime';
	import { applySessionEvent, createSession, sessionSummary } from '$lib/engine/session';
	import type { SessionEvent, SessionState } from '$lib/engine/session';
	import { computeMetrics } from '$lib/engine/metrics';
	import type { MetricsSnapshot } from '$lib/engine/metrics';
	import type { TypeableText } from '$lib/types';
	import PassageMeta from './PassageMeta.svelte';
	import SessionSummaryView from './SessionSummary.svelte';
	import TypingSurface from './TypingSurface.svelte';

	interface Props {
		book: TypeableText;
	}

	let { book }: Props = $props();

	// One session per mounted instance. The parent keys this component on the book id, so
	// `book` never changes here — no mount-time reset that could drop the first keystrokes.
	let session = $state.raw<SessionState>(untrack(() => createSession(book)));
	let liveMetrics = $state.raw<MetricsSnapshot | null>(null);
	let surface = $state<{ focusInput: () => void } | null>(null);

	// Zen mode (spec #9): a per-visit presentation toggle — the engine keeps
	// logging (the keystroke log is the single source of truth); only the meta
	// line's metric segments are subtracted.
	let zen = $state(false);

	/** Whole-book percent: completed passages plus the cursor's way through the active one. */
	const pct = $derived.by(() => {
		const length = session.activeChunk.display.length;
		const partial = length > 0 ? session.activeChunk.cursor / length : 0;
		return Math.round((100 * (session.activeIndex + partial)) / session.text.chunkCount);
	});

	/**
	 * Single dispatch point: applies the engine reducer, then refreshes live metrics
	 * ONLY at word boundaries (an expected-space position judged) or resets them when
	 * the active chunk changes — never per keystroke, never on a timer (spec #5).
	 */
	function dispatch(event: SessionEvent) {
		const previous = session;
		const next = applySessionEvent(previous, event);
		session = next;

		if (
			event.type === 'restart-chunk' ||
			event.type === 'restart-session' ||
			next.finished ||
			next.activeIndex !== previous.activeIndex
		) {
			liveMetrics = null; // fresh chunk (or summary): frozen figures take over
			return;
		}

		if (event.type === 'char') {
			const log = next.activeChunk.log;
			const last = log[log.length - 1];
			if (last?.kind === 'char' && last.expected === ' ') {
				liveMetrics = computeMetrics(log, Date.now()); // word boundary crossed
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
