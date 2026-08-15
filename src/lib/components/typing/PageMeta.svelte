<script lang="ts">
	import { m } from '$lib/paraglide/messages';
	import type { MetricsSnapshot } from '$lib/engine/metrics';

	interface Props {
		/** 1-based active page number. */
		current: number;
		total: number;
		/**
		 * Whole-book progress percent (spec #12 §4). For a signed-in user this is
		 * BOOK-LIFETIME completion — pages ever completed ÷ the book's chunk count,
		 * advanced optimistically in-session — so resuming at page 7 of 11 shows the
		 * persisted figure, not 0%. For a guest it stays session-relative: completed
		 * pages plus the cursor's way through the active one.
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

<!--
	One quiet line of chrome, in the header's center slot since spec #45. The visible line
	updates every keystroke (pct), so it is NOT a live region; the hidden region below
	announces only page changes.

	**Composed from separate spans rather than one message** (spec #45). The rendered text is
	byte-for-byte what the single `page_meta` string produced, but accuracy is now its own node,
	which is what lets the narrow-viewport rule drop it without a second message, a second test
	id, or a client-side breakpoint check that would flash on hydration.
-->
<p class="meta text-sm tracking-[0.01em] text-muted tabular-nums" data-testid="page-meta">
	<span>{m.page_meta_position({ current, total })}</span>
	<span aria-hidden="true"> · </span>
	<span>{m.page_meta_percent({ pct })}</span>
	{#if !zen}
		<span aria-hidden="true"> · </span>
		<span>{m.page_meta_wpm({ wpm })}</span>
		<span class="accuracy" aria-hidden="true"> · </span>
		<span class="accuracy">{m.page_meta_accuracy({ acc })}</span>
	{/if}
</p>
<p class="sr-only" aria-live="polite" data-testid="page-announcer">
	{m.page_meta_zen({ current, total, pct: Math.round((100 * (current - 1)) / total) })}
</p>

<style>
	.meta {
		white-space: nowrap;
	}

	/*
	 * Under 640px the slot keeps page, percent and WPM, and drops accuracy — the header has
	 * room for four figures on a phone only by lying about one of them (spec #45). Accuracy
	 * goes rather than WPM because WPM is the number a typist watches while typing.
	 */
	@media (max-width: 639px) {
		.accuracy {
			display: none;
		}
	}
</style>
