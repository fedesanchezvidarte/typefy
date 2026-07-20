<script lang="ts">
	import { m } from '$lib/paraglide/messages';
	import type { MetricsSnapshot } from '$lib/engine/metrics';
	import type { ChunkResult } from '$lib/engine/session';

	interface Props {
		/** Live values, refreshed at word boundaries only; null until the first boundary. */
		live: MetricsSnapshot | null;
		/** Frozen figures of the just-completed chunk (from session results). */
		lastResult: ChunkResult | null;
		/** 1-based active chunk number. */
		current: number;
		total: number;
		onRestartChunk: () => void;
		onRestartSession: () => void;
	}

	let { live, lastResult, current, total, onRestartChunk, onRestartSession }: Props = $props();

	function formatWpm(wpm: number): string {
		return String(Math.round(wpm));
	}

	function formatAccuracy(accuracy: number): string {
		return `${(accuracy * 100).toFixed(1)}%`;
	}

	const buttonClasses =
		'rounded-md border border-zinc-300 px-3 py-1.5 text-sm transition-colors hover:border-zinc-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900';
</script>

<div
	data-testid="metrics-bar"
	class="flex w-full max-w-3xl flex-wrap items-center gap-x-6 gap-y-2 text-sm text-zinc-700"
>
	<p>
		<span class="font-semibold">{m.metrics_wpm_label()}</span>
		<span data-testid="metrics-wpm" class="tabular-nums">
			{live ? formatWpm(live.grossWpm) : '—'}
		</span>
	</p>
	<p>
		<span class="font-semibold">{m.metrics_accuracy_label()}</span>
		<span data-testid="metrics-accuracy" class="tabular-nums">
			{live ? formatAccuracy(live.accuracyRaw) : '—'}
		</span>
	</p>
	<p data-testid="chunk-progress" aria-live="polite" class="tabular-nums">
		{m.metrics_chunk_progress({ current, total })}
	</p>
	{#if lastResult}
		<p data-testid="metrics-last-chunk" class="text-zinc-500 tabular-nums">
			{m.metrics_last_chunk_label()}: {formatWpm(lastResult.grossWpm)}
			{m.metrics_wpm_label()} · {formatAccuracy(lastResult.accuracyRaw)}
		</p>
	{/if}
	<div class="ml-auto flex gap-2">
		<button
			type="button"
			data-testid="restart-chunk"
			class={buttonClasses}
			onclick={onRestartChunk}
		>
			{m.typing_restart_chunk()}
		</button>
		<button
			type="button"
			data-testid="restart-session"
			class={buttonClasses}
			onclick={onRestartSession}
		>
			{m.typing_restart_session()}
		</button>
	</div>
</div>
