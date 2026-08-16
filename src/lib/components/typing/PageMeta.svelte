<script lang="ts">
	import { m } from '$lib/paraglide/messages';
	import type { MetricsSnapshot } from '$lib/engine/metrics';

	interface Props {
		/** 1-based active page number. Announced only — the navigator renders it visibly. */
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

	/**
	 * The 180ms opacity fade the figures enter and leave on when the mode axis flips
	 * (spec #50 §3). Opacity only — nothing translates, nothing resizes.
	 *
	 * A hand-rolled transition rather than `svelte/transition`'s `fade` for one reason: the
	 * duration has to collapse to 0 under `prefers-reduced-motion: reduce`, and a JS-driven
	 * transition writes inline styles that a CSS `transition: none` rule cannot reach. The
	 * media query is read per call, matching `RibbonPanel`'s `unfold`.
	 */
	function figureFade(_node: Element, { duration = 180 }: { duration?: number } = {}) {
		const reduced =
			typeof window !== 'undefined' &&
			window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		return {
			duration: reduced ? 0 : duration,
			css: (t: number) => `opacity: ${t};`
		};
	}
</script>

<!--
	The figures, in the bottom row's right column since spec #50. The visible line updates every
	keystroke (pct), so it is NOT a live region; the hidden region below announces only page changes.

	**Percent is LAST, and that is structural rather than a preference.** The column is right-aligned,
	so the trailing node is the one anchored to the card's edge — and percent is the one figure that
	survives a switch into Zen. Ordering it last means WPM and accuracy fade out to its left and the
	space closes behind them, leaving the anchored figure exactly where it was. Ordered first (as it
	read before), it would jump ~185px sideways the instant the fade ended.

	Page position is deliberately absent: the page navigator, two columns to the left, renders it.
-->
<p class="meta text-sm tracking-[0.01em] text-muted tabular-nums" data-testid="page-meta">
	{#if !zen}
		<!--
			Svelte transitions do not run on initial render, which is what keeps spec #24 §10's
			"no metrics, not even for one frame" true for a session opened in Zen from the cookie.
			**Do not add `intro`** — it would paint the figures for the length of one fade on a
			screen that is meant to have none.
		-->
		<span transition:figureFade>{m.page_meta_wpm({ wpm })}</span>
		<span class="accuracy" transition:figureFade>
			<span aria-hidden="true"> · </span>{m.page_meta_accuracy({ acc })}
		</span>
		<span aria-hidden="true" transition:figureFade> · </span>
	{/if}
	<span>{m.page_meta_percent({ pct })}</span>
</p>
<p class="sr-only" aria-live="polite" data-testid="page-announcer">
	{m.page_meta_zen({ current, total, pct: Math.round((100 * (current - 1)) / total) })}
</p>

<style>
	.meta {
		white-space: nowrap;
	}

	/*
	 * Under 640px the row keeps WPM and percent, and drops accuracy — the bottom row has space
	 * for the toggle, the navigator and two figures on a phone, not three (spec #50 §5).
	 * Accuracy goes rather than WPM because WPM is the number a typist watches while typing.
	 */
	@media (max-width: 639px) {
		.accuracy {
			display: none;
		}
	}
</style>
