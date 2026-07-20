<script lang="ts">
	import type { PageData } from './$types';
	import { m } from '$lib/paraglide/messages';
	import { applySessionEvent, createSession, sessionSummary } from '$lib/engine/session';
	import type { SessionEvent, SessionState } from '$lib/engine/session';
	import { computeMetrics } from '$lib/engine/metrics';
	import type { MetricsSnapshot } from '$lib/engine/metrics';
	import type { TypeableText } from '$lib/types';
	import MetricsBar from '$lib/components/typing/MetricsBar.svelte';
	import SessionSummaryView from '$lib/components/typing/SessionSummary.svelte';
	import TextPicker from '$lib/components/typing/TextPicker.svelte';
	import TypingSurface from '$lib/components/typing/TypingSurface.svelte';

	let { data }: { data: PageData } = $props();

	// Engine states are immutable and always reassigned — $state.raw, no proxying.
	let session = $state.raw<SessionState | null>(null);
	let liveMetrics = $state.raw<MetricsSnapshot | null>(null);
	let surface = $state<{ focusInput: () => void } | null>(null);

	/** Frozen figures of the just-completed chunk (null on the first chunk). */
	const lastResult = $derived(
		session && session.activeIndex > 0 ? session.results[session.activeIndex - 1] : null
	);

	function startSession(text: TypeableText) {
		session = createSession(text);
		liveMetrics = null;
	}

	/**
	 * Single dispatch point: applies the engine reducer, then refreshes live metrics
	 * ONLY at word boundaries (an expected-space position judged) or resets them when
	 * the active chunk changes — never per keystroke, never on a timer (spec #5).
	 */
	function dispatch(event: SessionEvent) {
		if (!session) {
			return;
		}
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
		// From the metrics bar the surface stays mounted — refocus it. From the
		// summary it remounts and focuses itself on mount.
		surface?.focusInput();
	}
</script>

<svelte:head>
	<title>{m.typing_page_title()} · {m.app_name()}</title>
</svelte:head>

<main class="flex min-h-svh flex-col items-center gap-8 p-8">
	{#if session === null}
		<TextPicker texts={data.texts} onSelect={startSession} />
	{:else if session.finished}
		<SessionSummaryView
			summary={sessionSummary(session)}
			onRestartSession={restartSession}
			onPickAnother={() => (session = null)}
		/>
	{:else}
		<MetricsBar
			live={liveMetrics}
			{lastResult}
			current={session.activeIndex + 1}
			total={session.text.chunkCount}
			onRestartChunk={restartChunk}
			onRestartSession={restartSession}
		/>
		<TypingSurface
			bind:this={surface}
			text={session.activeChunk.text}
			display={session.activeChunk.display}
			cursor={session.activeChunk.cursor}
			onChar={(char, timestamp) => dispatch({ type: 'char', char, timestamp })}
			onBackspace={(timestamp) => dispatch({ type: 'backspace', timestamp })}
			onRestartChunk={restartChunk}
		/>
	{/if}
</main>
