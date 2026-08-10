<script lang="ts">
	import type { Pathname } from '$app/types';
	import { resolve } from '$app/paths';
	import { m } from '$lib/paraglide/messages';
	import { localizeHref } from '$lib/paraglide/runtime';
	import type { ChapterProgress } from '$lib/types';

	interface Props {
		/** The book's SLUG — the `/type/[slug]` segment, never the uuid. */
		slug: string;
		/** Already folded by `buildChapterProgress`; empty for a book with no structure. */
		chapters: ChapterProgress[];
		/**
		 * Whether to render completion at all. A guest's entries all carry `pagesCompleted: 0`
		 * — honest, but "0 of 12 pages" invites the reader to fix a number they have no account
		 * to fix. They get the page count instead; the numerals are a signed-in thing.
		 */
		signedIn: boolean;
	}

	let { slug, chapters, signedIn }: Props = $props();

	/** Deep-links into the chapter's first page. `?page=` is canonical since spec #32. */
	const chapterHref = (chapter: ChapterProgress) =>
		resolve(localizeHref(`/type/${slug}?page=${chapter.firstPage}`) as Pathname);
</script>

<!-- Renders NOTHING for a book with no chapter structure. That is a legal spec #33 state
     (ingestion found no headings in the HTML edition), not a failure, and an empty-state panel
     would report it as one — the reader still has the primary Start/Continue action above. -->
{#if chapters.length > 0}
	<!-- A `<nav>`, not a `<section>` (spec #34 phase 8, a11y).
	     `<section aria-labelledby>` exposes this as a plain `region`, which says only "here is
	     a named box". The chapter list is the spec's PRIMARY NAVIGATION into typing — every row
	     is a link into `/type/[slug]?page=N` and nothing here is prose — so a screen-reader user
	     jumping by landmark should find it under navigation, next to the site nav, rather than
	     having to know a region called "Chapters" exists. `aria-labelledby` stays: with more
	     than one `<nav>` in the document each needs its own accessible name to be tellable
	     apart, and the heading already is that name. -->
	<nav data-testid="chapter-list" aria-labelledby="chapters-heading" class="mt-10">
		<h2 id="chapters-heading" class="mb-3 text-[15px] font-semibold text-fg">
			{m.book_detail_chapters_heading()}
		</h2>
		<ul class="overflow-hidden rounded-xl border border-border bg-sheet">
			{#each chapters as chapter (chapter.index)}
				<li class="border-b border-border last:border-b-0">
					<!-- The whole row is the action, so the target is a row rather than a small
					     "Start" hit area, and one Tab stop per chapter keeps the keyboard walk
					     down the list short. -->
					<a
						data-testid="chapter-row-{chapter.index}"
						href={chapterHref(chapter)}
						class="flex items-baseline gap-4 px-4 py-3 transition-colors hover:bg-bg focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
					>
						<span class="min-w-0 flex-1">
							<span class="block truncate text-[14px] font-medium text-fg">{chapter.title}</span>
							<span class="mt-0.5 block text-[12px] text-muted tabular-nums">
								{m.book_detail_chapter_pages({
									first: chapter.firstPage,
									last: chapter.lastPage
								})}
							</span>
						</span>
						<span class="shrink-0 text-[12px] text-muted tabular-nums">
							{#if signedIn}
								{m.book_detail_progress_pages({
									completed: chapter.pagesCompleted,
									total: chapter.pageCount
								})}
							{:else}
								{m.page_count({ count: chapter.pageCount })}
							{/if}
						</span>
					</a>
				</li>
			{/each}
		</ul>
	</nav>
{/if}
