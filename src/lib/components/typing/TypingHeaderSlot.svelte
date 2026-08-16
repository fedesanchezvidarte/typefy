<script lang="ts">
	import type { Pathname } from '$app/types';
	import { resolve } from '$app/paths';
	import { m } from '$lib/paraglide/messages';
	import { localizeHref } from '$lib/paraglide/runtime';
	import type { TypingHeaderView } from './typing-header.svelte';

	interface Props {
		view: TypingHeaderView;
	}

	let { view }: Props = $props();

	const href = $derived(resolve(localizeHref(`/books/${view.slug}`) as Pathname));
</script>

<!--
	The typing screen's header slot (spec #45, narrowed by spec #50).

	It used to carry six things — title, chapter, page N of M, percent, WPM, accuracy and the Zen
	toggle — which cost the title all but 22 characters and hid the whole block on a phone. The
	figures and the toggle live under the page card now. What is left is **identity**: which book,
	which chapter.

	The title is a **link back to the book detail screen**. `beforeNavigate` in `TypingSession`
	already flushes in-page restore, so leaving mid-page loses nothing.
-->
<div class="slot" data-testid="typing-header-slot">
	<a class="book" data-testid="header-book" {href} title={m.header_book_details()}>{view.title}</a>
	{#if view.chapter}
		<span class="sep" aria-hidden="true">·</span>
		<span class="chapter" data-testid="header-chapter">{view.chapter}</span>
	{/if}
</div>

<style>
	.slot {
		display: flex;
		min-width: 0;
		align-items: center;
		gap: 8px;
		color: var(--muted);
		font-size: 14px;
	}

	/*
	 * The title renders WHOLE (spec #50 §1). No character cap: it takes the space the row has and
	 * ellipsis is an overflow backstop, not a design. The catalog's longest title is 43 characters
	 * and must read in full at ≥640px, and a `44ch` cap would be a magic number that the next book
	 * breaks silently.
	 *
	 * `flex-shrink: 0` up to its content, with the CHAPTER yielding first — see below. `min-width`
	 * is what lets the ellipsis engage at all when the row genuinely runs out of room.
	 */
	.book {
		overflow: hidden;
		min-width: 0;
		text-overflow: ellipsis;
		white-space: nowrap;
		border-radius: 3px;
		transition: color 0.15s ease;
	}

	.book:hover {
		color: var(--fg);
	}

	.book:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 3px;
	}

	/*
	 * The chapter takes the squeeze first, and takes it all the way: `flex-shrink` an order of
	 * magnitude above the title's default means the row consumes this element's slack before it
	 * touches a single character of the book's name.
	 */
	.chapter {
		flex-shrink: 100;
		overflow: hidden;
		min-width: 3ch;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.sep {
		flex-shrink: 0;
		color: var(--dim);
	}

	/*
	 * Under 640px the slot is empty: at 375px there is no room for a title beside the wordmark and
	 * the account controls. The book is still reachable — it is the page's visually-hidden h1 and
	 * the document title.
	 */
	@media (max-width: 639px) {
		.slot {
			display: none;
		}
	}
</style>
