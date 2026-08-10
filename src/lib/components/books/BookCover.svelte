<script lang="ts">
	import { m } from '$lib/paraglide/messages';
	import type { TypeableTextSummary } from '$lib/types';
	import GeneratedCover from '$lib/components/library/GeneratedCover.svelte';

	interface Props {
		/** `TypeableTextDetail` structurally satisfies this, so the detail screen passes its book. */
		book: TypeableTextSummary;
		/**
		 * Extra classes on the FRAME — how a caller sizes it, and the only thing a caller gets
		 * to decide. The 2/3 aspect ratio, the rounding, the border, the sheet background and
		 * the clip are fixed here: they are what makes art and generated covers read as the same
		 * object, and what makes the swap below invisible.
		 */
		class?: string;
		/**
		 * `lazy` for a card in a grid, `eager` for the one cover that IS the screen. Defaults to
		 * the grid's answer because that is where most covers render.
		 */
		loading?: 'lazy' | 'eager';
	}

	let { book, class: className = '', loading = 'lazy' }: Props = $props();

	/**
	 * A `cover_url` that 404s must degrade to the generated cover, never a broken-image box
	 * (spec #19 §3). Per-instance state on purpose: the same book rendered in both the
	 * continue-reading section and the grid gets two independent flags, and both fail and
	 * swap on their own. `onerror` cannot fire during SSR, so a dead URL server-renders an
	 * `<img>` and swaps on the client — the visible artefact is the empty `bg-sheet` frame
	 * for a frame, not a broken-image glyph, because the frame carries the background.
	 *
	 * The fallback is cosmetic, not corrective: the database still holds a dead URL, and
	 * that is an operator problem (re-ingest).
	 *
	 * **This is the only implementation of that guarantee.** It was extracted from
	 * `BookCard.svelte` when `/books/[slug]` needed the same one (spec #34): the card's G6 E2E
	 * test proves the swap, and a second copy on the detail screen would be a copy that can
	 * drift out from under that proof.
	 */
	let coverFailed = $state(false);
</script>

<div
	class={[
		'frame relative aspect-2/3 overflow-hidden rounded-[10px] border border-border bg-sheet',
		className
	]}
>
	{#if book.coverUrl && !coverFailed}
		<img
			src={book.coverUrl}
			alt={m.library_cover_alt({ title: book.title })}
			class="absolute inset-0 h-full w-full object-cover"
			{loading}
			onerror={() => (coverFailed = true)}
		/>
	{:else}
		<GeneratedCover {book} />
	{/if}
</div>
