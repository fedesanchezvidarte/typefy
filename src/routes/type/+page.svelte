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
			<!-- Progress is 0 for everyone until Phase 2b wires per-user data. -->
			<BookCard {book} progress={0} />
		{/each}
	</div>
</main>
