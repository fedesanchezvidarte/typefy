<script lang="ts">
	import type { Pathname } from '$app/types';
	import { resolve } from '$app/paths';
	import { m } from '$lib/paraglide/messages';
	import { localizeHref } from '$lib/paraglide/runtime';
	import type { TypeableTextSummary } from '$lib/types';
	import GeneratedCover from './GeneratedCover.svelte';

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
	 */
	let coverFailed = $state(false);
</script>

<!-- Coherence comes from the frame, not the contents (brief §3): art and
     generated covers share the same 2/3 frame and card treatment. The hover
     3D tilt is the one place tactile playfulness is welcome. -->
<a
	data-testid="text-picker-option-{book.id}"
	href={resolve(localizeHref(`/type/${book.id}`) as Pathname)}
	class="card block rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
>
	<div
		class="frame relative aspect-2/3 overflow-hidden rounded-[10px] border border-border bg-sheet"
	>
		{#if book.coverUrl && !coverFailed}
			<img
				src={book.coverUrl}
				alt={m.library_cover_alt({ title: book.title })}
				class="absolute inset-0 h-full w-full object-cover"
				loading="lazy"
				onerror={() => (coverFailed = true)}
			/>
		{:else}
			<GeneratedCover {book} />
		{/if}
	</div>
	<div class="mt-[11px]">
		<span class="block text-sm leading-[1.25] font-semibold text-fg">{book.title}</span>
		<span class="mt-px block text-[13px] text-muted">{book.author}</span>
		<span class="mt-1 block text-xs text-muted">{m.passage_count({ count: book.chunkCount })}</span>
		<span class="mt-[9px] flex items-center gap-2">
			<span class="h-[3px] flex-1 overflow-hidden rounded-sm bg-border" aria-hidden="true">
				<span class="block h-full bg-accent" style:width="{progress}%"></span>
			</span>
			<span class="text-[11px] text-muted tabular-nums">{progress}%</span>
		</span>
	</div>
</a>

<style>
	.card {
		perspective: 900px;
	}

	.frame {
		transform-style: preserve-3d;
		transition:
			transform 0.3s ease,
			box-shadow 0.3s ease;
	}

	.card:hover .frame,
	.card:focus-visible .frame {
		transform: translateY(-6px) rotateX(5deg) rotateY(-4deg);
		box-shadow: 0 22px 44px -20px rgb(0 0 0 / 0.5);
	}

	@media (prefers-reduced-motion: reduce) {
		.frame,
		.card:hover .frame,
		.card:focus-visible .frame {
			transition: none;
			transform: none;
			box-shadow: none;
		}
	}
</style>
