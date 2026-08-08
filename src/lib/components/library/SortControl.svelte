<script lang="ts">
	import type { Pathname } from '$app/types';
	import { resolve } from '$app/paths';
	import { m } from '$lib/paraglide/messages';
	import { localizeHref } from '$lib/paraglide/runtime';
	import type { LanguageFilter } from '$lib/types';
	import { BOOK_SORTS, type BookSort } from '$lib/library/sort';
	import { libraryHref } from '$lib/library/url';

	interface Props {
		/** The active filter and search (spec #25 §2), carried through so changing the sort
		 * never silently drops them — `libraryHref` is the one place a library URL is built. */
		language: LanguageFilter;
		query: string | null;
		/** The RESOLVED sort the load applied — not the raw `?sort`, so an unrecognised value
		 * still marks `'default'` as current rather than nothing. */
		active: BookSort;
	}

	let { language, query, active }: Props = $props();

	const labels: Record<BookSort, () => string> = {
		default: m.library_sort_default,
		title: m.library_sort_title,
		length: m.library_sort_length
	};
</script>

<!-- Links, not a form: back/forward, shareability and keyboard operability with no
     JavaScript and no submit button — same reasoning as `LanguageFilter`. -->
<nav aria-label={m.library_sort_label()} data-testid="library-sort-control">
	<ul class="flex gap-0.5">
		{#each BOOK_SORTS as value (value)}
			<li>
				<!-- `'default'` renders as an explicit pill rather than being treated as an
				     absence of choice — it is "listBooks' own order," a real, reachable option,
				     matching how `LanguageFilter` always renders `all` explicitly. The active
				     pill is a `sheet` fill with an `accent` hairline (spec #30), matching
				     `LanguageFilter`'s treatment; semibold weight and the border are the
				     non-colour half of the active signal. -->
				<a
					data-testid="library-sort-{value}"
					href={resolve(localizeHref(libraryHref({ language, query, sort: value })) as Pathname)}
					aria-current={value === active ? 'page' : undefined}
					class={[
						'block rounded-md border px-2 py-1 text-xs tracking-wide transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
						value === active
							? 'border-accent bg-sheet font-semibold text-fg'
							: 'border-transparent text-muted hover:text-fg'
					]}
				>
					{labels[value]()}
				</a>
			</li>
		{/each}
	</ul>
</nav>
