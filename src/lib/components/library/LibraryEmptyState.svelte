<script lang="ts">
	import type { Pathname } from '$app/types';
	import { resolve } from '$app/paths';
	import { m } from '$lib/paraglide/messages';
	import { localizeHref } from '$lib/paraglide/runtime';
	import type { LanguageFilter } from '$lib/types';
	import type { BookSort } from '$lib/library/sort';
	import { libraryHref } from '$lib/library/url';

	interface Props {
		/** The search term that matched nothing — always the resolved, non-null `query` the
		 * page already checked before rendering this component (spec #25 §2: this state is
		 * guarded on `query !== null`, not on an empty book list alone — a legitimately narrow
		 * language filter with no search and zero books is NOT this state). */
		query: string;
		/** The active filter and sort, preserved by the reset link below — only the search is
		 * cleared, not a full reset back to the unfiltered-and-unsorted shelf. */
		language: LanguageFilter;
		sort: BookSort;
	}

	let { query, language, sort }: Props = $props();
</script>

<!-- Replaces the "#all-books-heading" grid section, so it carries the same landmark/heading
     shape rather than leaving a gap in the outline: a named region with its own heading. -->
<section aria-labelledby="library-empty-heading" data-testid="library-empty-state">
	<h2 id="library-empty-heading" class="mb-1.5 text-[15px] font-semibold">
		{m.library_empty_heading({ query })}
	</h2>
	<p class="mb-4 text-[13px] text-muted">{m.library_empty_body()}</p>
	<a
		data-testid="library-empty-reset"
		href={resolve(localizeHref(libraryHref({ language, sort, query: null })) as Pathname)}
		class="inline-block rounded-md bg-fg px-2 py-1 text-xs font-semibold tracking-wide text-bg transition-colors hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
	>
		{m.library_empty_reset()}
	</a>
</section>
