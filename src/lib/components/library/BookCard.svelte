<script lang="ts">
	import type { Pathname } from '$app/types';
	import { resolve } from '$app/paths';
	import { localizeHref } from '$lib/paraglide/runtime';
	import type { TypeableTextSummary } from '$lib/types';
	import BookCover from '$lib/components/books/BookCover.svelte';

	interface Props {
		book: TypeableTextSummary;
		/**
		 * Per-book progress percent (0–100): book-lifetime completion, i.e.
		 * `round(100 × chunks_completed ÷ chunkCount)` (spec #12), not how far into
		 * the current session the user is. Callers pass 0 for guests and for books
		 * the signed-in user has no completed passages in.
		 */
		progress: number;
	}

	let { book, progress }: Props = $props();
</script>

<!-- The card links to the book's DETAIL screen, not straight into typing (spec #34):
     `/books/[slug]` is the canonical page, and `/type/[slug]` is what it leads into. This one
     href covers all three entry points — the browse grid, the search results (the same grid,
     narrowed server-side) and continue-reading all render this component, and no per-surface
     link logic exists to update. Do not add one.

     Coherence comes from the frame, not the contents (brief §3): art and
     generated covers share the same 2/3 frame and card treatment. The hover
     3D tilt is the one place tactile playfulness is welcome.

     Cover / title+author / progress are three direct grid children so the card can
     subgrid into the parent's row tracks (spec #30): every card in the same visual
     row aligns its cover top, its progress bar, and everything between, regardless
     of whether this card's title+author runs one line or three. -->
<a
	data-testid="text-picker-option-{book.id}"
	href={resolve(localizeHref(`/books/${book.id}`) as Pathname)}
	class="card block rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
>
	<!-- The frame, the art/generated swap and the dead-`cover_url` fallback all live in
	     `BookCover` since spec #34, because `/books/[slug]` needs the identical guarantee and a
	     second copy of it would be a copy that can drift out from under the G6 E2E test. -->
	<BookCover {book} />
	<div class="self-start">
		<span class="block text-sm leading-[1.25] font-semibold text-fg">{book.title}</span>
		<span class="mt-px block text-[13px] text-muted">{book.author}</span>
	</div>
	<span class="flex items-center gap-2 self-end">
		<span class="h-[3px] flex-1 overflow-hidden rounded-sm bg-border" aria-hidden="true">
			<span class="block h-full bg-accent" style:width="{progress}%"></span>
		</span>
		<span class="text-[11px] text-muted tabular-nums">{progress}%</span>
	</span>
</a>

<style>
	.card {
		display: grid;
		grid-row: span 3;
		grid-template-rows: subgrid;
		/* Overrides the parent's row-gap (26px, meant for the gap BETWEEN cards) for the
		   gaps WITHIN this card's own three subgridded rows only — the boundary gap between
		   this card's last row and the next card row still uses the parent's value. Visual-
		   taste value (brief §4), picked to read close to the previous mt-[11px]/mt-[9px]
		   spacing it replaces. */
		row-gap: 10px;
		perspective: 900px;
	}

	/* The tilt is the CARD's behaviour, not the cover's, so it stays here even though `.frame`
	   now belongs to `BookCover`. Every selector is anchored on `.card` — which IS scoped to
	   this component — so `:global(.frame)` reaches only this card's own cover and the rule
	   cannot escape onto the detail screen's frame, which must not tilt. */
	.card :global(.frame) {
		transform-style: preserve-3d;
		transition:
			transform 0.3s ease,
			box-shadow 0.3s ease;
	}

	.card:hover :global(.frame),
	.card:focus-visible :global(.frame) {
		transform: translateY(-6px) rotateX(5deg) rotateY(-4deg);
		box-shadow: 0 22px 44px -20px rgb(0 0 0 / 0.5);
	}

	@media (prefers-reduced-motion: reduce) {
		.card :global(.frame),
		.card:hover :global(.frame),
		.card:focus-visible :global(.frame) {
			transition: none;
			transform: none;
			box-shadow: none;
		}
	}
</style>
