<script lang="ts">
	import type { PageData } from './$types';
	import type { Pathname } from '$app/types';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { m } from '$lib/paraglide/messages';
	import { localizeHref } from '$lib/paraglide/runtime';
	import { completionPercent } from '$lib/library/completion';
	import BookCover from '$lib/components/books/BookCover.svelte';
	import BookFacts from '$lib/components/books/BookFacts.svelte';
	import ChapterList from '$lib/components/books/ChapterList.svelte';
	import ResetProgress from '$lib/components/books/ResetProgress.svelte';

	let { data }: { data: PageData } = $props();

	// Read here rather than inside the components, matching `/type/[slug]`: the layout already
	// carries the user, and a component that reads `$app/state` itself can only be driven in a
	// test by stubbing it.
	const signedIn = $derived(page.data.user != null);

	/**
	 * `Start` when nothing has been typed, `Continue` otherwise. Derived from `chunksCompleted`
	 * rather than carried as a third field on the payload — one fact, one source.
	 */
	const started = $derived(data.chunksCompleted > 0);

	/**
	 * The primary action goes to `/type/[slug]` with **no page parameter**, deliberately: the
	 * existing resume logic (`first_incomplete_chunk_index`) decides where the book opens, and a
	 * `?page=` here would freeze that decision at page-render time. The chapter rows are the
	 * only thing that names a page.
	 */
	const typeHref = $derived(resolve(localizeHref(`/type/${data.book.id}`) as Pathname));

	const percent = $derived(completionPercent(data.book, data.chunksCompleted));
</script>

<svelte:head>
	<title>{data.book.title} · {m.app_name()}</title>
</svelte:head>

<main class="mx-auto w-full max-w-[900px] px-6 pt-11 pb-24">
	<!-- Cover left, facts right; one column below the breakpoint with the cover FIRST, so the
	     book is identifiable before it is described. The cover is capped rather than fluid: at
	     full width on a phone a 2/3 frame would push the title off the first screen. -->
	<div class="flex flex-col gap-7 sm:flex-row sm:items-start sm:gap-9">
		<BookCover
			book={data.book}
			loading="eager"
			class="w-[168px] shrink-0 self-start sm:w-[196px]"
		/>
		<div class="min-w-0 flex-1">
			<BookFacts book={data.book} summary={data.summary} />

			<a
				data-testid="book-detail-start"
				href={typeHref}
				class="mt-7 inline-block rounded-md bg-fg px-3.5 py-2 text-[13px] font-semibold tracking-wide text-bg transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
			>
				{started ? m.book_detail_continue() : m.book_detail_start()}
			</a>
		</div>
	</div>

	<!-- Progress is absent ENTIRELY for a guest — not zeroed, not greyed. There is nothing for
	     a signed-out reader to have made progress on, and a 0% bar reads as a lost streak. -->
	{#if signedIn}
		<section
			data-testid="book-detail-progress"
			aria-labelledby="book-progress-heading"
			class="mt-10"
		>
			<h2 id="book-progress-heading" class="mb-2 text-[15px] font-semibold text-fg">
				{m.book_detail_progress_heading()}
			</h2>
			<div class="flex items-center gap-3">
				<span class="h-[5px] flex-1 overflow-hidden rounded-sm bg-border" aria-hidden="true">
					<span class="block h-full bg-accent" style:width="{percent}%"></span>
				</span>
				<!-- The numerals ARE the accessible value, which is why the bar above is
				     `aria-hidden`: colour and width are never the only signal. -->
				<span class="text-[12px] text-muted tabular-nums">
					{m.book_detail_progress_pages({
						completed: data.chunksCompleted,
						total: data.book.chunkCount
					})} · {percent}%
				</span>
			</div>
			<!--
				Only when there IS progress to reset (spec #51 §5). The section itself already sets
				this pattern — absent entirely for a guest, because "a 0% bar reads as a lost
				streak" — and a destructive control that can only no-op is noise on the screen of
				every user who has just found a book.
			-->
			{#if data.chunksCompleted > 0}
				<ResetProgress bookId={data.book.bookId} />
			{/if}
		</section>
	{/if}

	<ChapterList slug={data.book.id} chapters={data.chapters} {signedIn} />
</main>
