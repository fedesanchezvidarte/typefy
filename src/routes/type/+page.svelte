<script lang="ts">
	import type { PageData } from './$types';
	import { m } from '$lib/paraglide/messages';
	import BookCard from '$lib/components/library/BookCard.svelte';
	import LanguageFilter from '$lib/components/library/LanguageFilter.svelte';
	import SearchInput from '$lib/components/library/SearchInput.svelte';
	import SortControl from '$lib/components/library/SortControl.svelte';
	import LibraryEmptyState from '$lib/components/library/LibraryEmptyState.svelte';
	import { completionPercent } from '$lib/library/completion';

	let { data }: { data: PageData } = $props();

	/**
	 * Book-lifetime completion (spec #12): completed passages ÷ the book's passage count,
	 * not session progress. 0 for guests and for untouched books — an absent entry is
	 * "never attempted", which renders the same as "attempted, none finished". The
	 * divide-by-zero guard for a book seeded with no chunks lives in `completionPercent`.
	 */
	const percent = (book: PageData['books'][number]) =>
		completionPercent(book, data.progressByBook[book.bookId] ?? 0);
</script>

<svelte:head>
	<title>{m.library_heading()} · {m.app_name()}</title>
</svelte:head>

<main class="mx-auto w-full max-w-[1040px] px-6 pt-11 pb-24">
	<h1 class="mb-1.5 text-[26px] font-semibold tracking-[-0.02em]">{m.library_heading()}</h1>
	<p class="mb-5 text-[15px] text-muted">{m.library_sub()}</p>

	<!-- One coherent control group (spec #25 §2): each control carries the other two through
	     `libraryHref` so changing any one preserves the rest, and none of the three can drop
	     the others on navigation or submit. -->
	<div class="mb-9 flex flex-wrap items-end gap-x-6 gap-y-4">
		<LanguageFilter active={data.language} query={data.query} sort={data.sort} />
		<SortControl language={data.language} query={data.query} active={data.sort} />
		<SearchInput language={data.language} sort={data.sort} query={data.query} />
	</div>

	<!-- No empty state and no placeholder: fewer than three in-progress books render fewer
	     cards, zero render no section at all. The cards are the same BookCard as the grid's,
	     so a book legitimately appears twice on the page — E2E scopes through the container
	     testids rather than by giving the section a different card. -->
	{#if data.continueReading.length > 0}
		<section
			data-testid="continue-reading"
			aria-labelledby="continue-reading-heading"
			class="mb-11"
		>
			<h2 id="continue-reading-heading" class="mb-4 text-[15px] font-semibold">
				{m.library_continue_heading()}
			</h2>
			<div class="grid grid-cols-[repeat(auto-fill,minmax(158px,1fr))] gap-x-[22px] gap-y-[26px]">
				{#each data.continueReading as book (book.id)}
					<BookCard {book} progress={percent(book)} />
				{/each}
			</div>
		</section>
	{/if}

	<!-- Guarded on `query !== null`, not on an empty book list alone: a legitimately narrow
	     language filter with zero books is NOT the search-empty state, it's just a short
	     grid (spec #25 §2). -->
	{#if data.books.length === 0 && data.query !== null}
		<LibraryEmptyState query={data.query} language={data.language} sort={data.sort} />
	{:else}
		<!-- The grid carries a heading of its own: a named region above an unnamed one would
		     leave the grid an orphan in the landmark/heading outline. -->
		<section aria-labelledby="all-books-heading">
			<h2 id="all-books-heading" class="mb-4 text-[15px] font-semibold">
				{m.library_all_heading()}
			</h2>
			<div
				data-testid="text-picker"
				class="grid grid-cols-[repeat(auto-fill,minmax(158px,1fr))] gap-x-[22px] gap-y-[26px]"
			>
				{#each data.books as book (book.id)}
					<BookCard {book} progress={percent(book)} />
				{/each}
			</div>
		</section>
	{/if}
</main>
