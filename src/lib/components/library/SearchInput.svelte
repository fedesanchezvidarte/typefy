<script lang="ts">
	import type { Pathname } from '$app/types';
	import { resolve } from '$app/paths';
	import { m } from '$lib/paraglide/messages';
	import { localizeHref } from '$lib/paraglide/runtime';
	import type { LanguageFilter } from '$lib/types';
	import type { BookSort } from '$lib/library/sort';

	interface Props {
		/** The active filter and sort (spec #25 §2), carried as HIDDEN inputs so submitting a
		 * search never drops them — a GET form only sends the fields it holds. */
		language: LanguageFilter;
		sort: BookSort;
		/** The ACTIVE search term the load resolved (`parseSearchQuery`), or `null` for "no
		 * search" — the input's starting value, so a shared/reloaded `?q=...` URL shows what
		 * is actually active rather than an empty box. */
		query: string | null;
	}

	let { language, sort, query }: Props = $props();
</script>

<!-- A GET form, not JS-driven: submitting navigates, so back/forward and a shareable URL work
     with no script at all — the same reasoning `LanguageFilter`/`SortControl` use for plain
     links, applied to the one control that needs free-text input instead of a fixed set of
     options. The hidden `lang`/`sort` inputs are what make search compose with the other two
     controls instead of resetting them on submit. -->
<form method="GET" action={resolve(localizeHref('/type') as Pathname)} data-testid="library-search">
	<label for="library-search-input" class="mb-1 block text-xs tracking-wide text-muted">
		{m.library_search_label()}
	</label>
	<div class="flex gap-2">
		<input
			id="library-search-input"
			type="search"
			name="q"
			value={query ?? ''}
			placeholder={m.library_search_placeholder()}
			data-testid="library-search-input"
			class="min-w-0 flex-1 rounded-md border border-border bg-sheet px-2 py-1 text-xs text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
		/>
		<!-- Hidden, not disabled: a disabled field is excluded from the submitted form data,
		     which is exactly the drop this exists to prevent. -->
		<input type="hidden" name="lang" value={language} />
		<input type="hidden" name="sort" value={sort} />
		<button
			type="submit"
			data-testid="library-search-submit"
			class="rounded-md bg-fg px-2 py-1 text-xs font-semibold tracking-wide text-bg transition-colors hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
		>
			{m.library_search_submit()}
		</button>
	</div>
</form>
