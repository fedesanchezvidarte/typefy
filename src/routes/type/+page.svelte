<script lang="ts">
	import type { PageData } from './$types';
	import { m } from '$lib/paraglide/messages';
	import BookCard from '$lib/components/library/BookCard.svelte';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>{m.library_heading()} · {m.app_name()}</title>
</svelte:head>

<main class="mx-auto w-full max-w-[1040px] px-6 pt-11 pb-24">
	<h1 class="mb-1.5 text-[26px] font-semibold tracking-[-0.02em]">{m.library_heading()}</h1>
	<p class="mb-9 text-[15px] text-muted">{m.library_sub()}</p>
	<div
		data-testid="text-picker"
		class="grid grid-cols-[repeat(auto-fill,minmax(158px,1fr))] gap-x-[22px] gap-y-[26px]"
	>
		{#each data.books as book (book.id)}
			<!-- Book-lifetime completion (spec #12): completed passages ÷ the book's passage
			     count, not session progress. 0 for guests and for untouched books — an absent
			     entry is "never attempted", which renders the same as "attempted, none finished".
			     The chunkCount guard covers a book seeded with no chunks (the column defaults to
			     0), which would otherwise divide by zero and render NaN%. -->
			<BookCard
				{book}
				progress={book.chunkCount > 0
					? Math.round((100 * (data.progressByBook[book.bookId] ?? 0)) / book.chunkCount)
					: 0}
			/>
		{/each}
	</div>
</main>
