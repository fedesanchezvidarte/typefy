<script lang="ts">
	import { m } from '$lib/paraglide/messages';
	import type { TypingHeaderView } from './typing-header.svelte';
	import PageMeta from './PageMeta.svelte';

	interface Props {
		view: TypingHeaderView;
	}

	let { view }: Props = $props();
</script>

<!--
	The typing screen's chrome, in the header's center slot (spec #45). It is here rather than
	under the sheet for one concrete reason: the ~130px it used to occupy below the card is the
	height the pinned page card now has, which is the difference between showing 10 lines of a
	page and showing most of one.

	Order matters — title, then chapter, then the figures, then Zen. Zen sits at the RIGHT END,
	immediately beside the WPM and accuracy it removes, so cause and effect are adjacent.
-->
<div class="slot" data-testid="typing-header-slot">
	<span class="book" data-testid="header-book">{view.title}</span>
	{#if view.chapter}
		<span class="sep" aria-hidden="true">·</span>
		<span class="chapter" data-testid="header-chapter">{view.chapter}</span>
	{/if}
	<span class="sep" aria-hidden="true">·</span>
	<PageMeta
		current={view.current}
		total={view.total}
		pct={view.pct}
		live={view.live}
		zen={view.zen}
	/>
	<button
		type="button"
		data-testid="zen-toggle"
		class="zen"
		aria-pressed={view.zen}
		onclick={() => view.onToggleZen?.()}
	>
		{view.zen ? m.zen_exit() : m.zen_enter()}
	</button>
</div>

<style>
	.slot {
		display: flex;
		min-width: 0;
		align-items: center;
		gap: 8px;
		color: var(--muted);
	}

	.book,
	.chapter {
		overflow: hidden;
		font-size: 14px;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* The book takes the squeeze first: it is also the document title and the page's own h1. */
	.book {
		max-width: 22ch;
	}

	.chapter {
		max-width: 18ch;
	}

	.sep {
		color: var(--dim);
	}

	.zen {
		border: 1px solid transparent;
		border-radius: 8px;
		padding: 4px 9px;
		font-size: 13px;
		color: var(--muted);
		white-space: nowrap;
		cursor: pointer;
		transition:
			color 0.15s ease,
			border-color 0.15s ease;
	}

	.zen:hover {
		border-color: var(--accent);
		color: var(--fg);
	}

	.zen[aria-pressed='true'] {
		border-color: var(--border);
		color: var(--fg);
	}

	.zen:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	/*
	 * Under 640px the slot trims to the figures and the toggle (spec #45): the title and the
	 * chapter would otherwise squeeze the numbers off a 375px screen. The title is still
	 * reachable — it is the page's visually-hidden h1 and the document title.
	 */
	@media (max-width: 639px) {
		.book,
		.chapter,
		.sep {
			display: none;
		}
	}
</style>
