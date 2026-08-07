<script lang="ts">
	import type { Pathname } from '$app/types';
	import { resolve } from '$app/paths';
	import { m } from '$lib/paraglide/messages';
	import { localizeHref } from '$lib/paraglide/runtime';
	import type { LanguageFilter } from '$lib/types';
	import { LANGUAGE_FILTERS } from '$lib/library/language-filter';
	import type { BookSort } from '$lib/library/sort';
	import { libraryHref } from '$lib/library/url';

	interface Props {
		/** The RESOLVED filter the load applied — not the raw `?lang`, so `?lang=fr` still
		 * marks the fallback as current rather than nothing. */
		active: LanguageFilter;
		/** The active search and sort (spec #25 §2), carried through so switching the
		 * language never silently drops them — `libraryHref` is the one place a library URL
		 * is built, and it needs the whole state to stay explicit about all three. */
		query: string | null;
		sort: BookSort;
	}

	let { active, query, sort }: Props = $props();

	// The two language options reuse the content-language labels GeneratedCover already
	// uses — that is exactly what they are. Only "All" is new.
	const labels: Record<LanguageFilter, () => string> = {
		en: m.lang_label_en,
		es: m.lang_label_es,
		all: m.library_filter_all
	};
</script>

<!-- Links, not a form: back/forward, shareability and keyboard operability with no
     JavaScript and no submit button. A <select> would need either a visible submit for
     three options or an onchange handler that breaks without JS. -->
<nav aria-label={m.library_filter_label()} data-testid="library-language-filter">
	<ul class="flex gap-0.5">
		{#each LANGUAGE_FILTERS as value (value)}
			<li>
				<!-- Every option carries an explicit `lang`, the default included, so the active
				     state and a shared URL are never ambiguous; `/type` with no param still
				     works and still defaults. `aria-current="page"` rather than "true": these
				     are links to a URL that IS the current view. (LanguageSwitcher uses "true"
				     because its controls are buttons — the divergence is deliberate.) The
				     filled pill and semibold weight are the non-colour half of the signal:
				     colour alone would not carry the active option. -->
				<a
					data-testid="library-language-filter-{value}"
					href={resolve(localizeHref(libraryHref({ language: value, query, sort })) as Pathname)}
					aria-current={value === active ? 'page' : undefined}
					class={[
						'block rounded-md px-2 py-1 text-xs tracking-wide transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
						value === active ? 'bg-fg font-semibold text-bg' : 'text-muted hover:text-fg'
					]}
				>
					{labels[value]()}
				</a>
			</li>
		{/each}
	</ul>
</nav>
