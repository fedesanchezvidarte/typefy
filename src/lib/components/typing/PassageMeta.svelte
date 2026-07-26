<script lang="ts">
	import { m } from '$lib/paraglide/messages';
	import type { MetricsSnapshot } from '$lib/engine/metrics';

	interface Props {
		/** 1-based active passage number. */
		current: number;
		total: number;
		/**
		 * Whole-book progress percent (spec #12 §4). For a signed-in user this is
		 * BOOK-LIFETIME completion — passages ever completed ÷ the book's chunk count,
		 * advanced optimistically in-session — so resuming at passage 7 of 11 shows the
		 * persisted figure, not 0%. For a guest it stays session-relative: completed
		 * passages plus the cursor's way through the active one.
		 */
		pct: number;
		/** Live values, refreshed at word boundaries only; null until the first boundary. */
		live: MetricsSnapshot | null;
		/** Zen subtracts the metrics from this same line — never a different layout. */
		zen: boolean;
	}

	let { current, total, pct, live, zen }: Props = $props();

	const wpm = $derived(live ? String(Math.round(live.grossWpm)) : '—');
	// Floored, not rounded: a session with an error must never display as 100%.
	const acc = $derived(live ? String(Math.floor(live.accuracyRaw * 100)) : '—');
</script>

<!-- One quiet line of chrome below the sheet (brief §2). The visible line
     updates every keystroke (pct), so it is NOT a live region; the hidden
     region announces only passage changes. -->
<p class="text-sm tracking-[0.01em] text-muted tabular-nums" data-testid="passage-meta">
	{#if zen}
		{m.passage_meta_zen({ current, total, pct })}
	{:else}
		{m.passage_meta({ current, total, pct, wpm, acc })}
	{/if}
</p>
<p class="sr-only" aria-live="polite" data-testid="passage-announcer">
	{m.passage_meta_zen({ current, total, pct: Math.round((100 * (current - 1)) / total) })}
</p>
