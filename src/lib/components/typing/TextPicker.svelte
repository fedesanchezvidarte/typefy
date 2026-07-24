<script lang="ts">
	import type { Pathname } from '$app/types';
	import { resolve } from '$app/paths';
	import { m } from '$lib/paraglide/messages';
	import { localizeHref } from '$lib/paraglide/runtime';
	import type { TypeableTextSummary } from '$lib/types';

	interface Props {
		books: readonly TypeableTextSummary[];
	}

	let { books }: Props = $props();

	/* Content language of a text — independent of the UI locale (spec #5). */
	const languageLabels = {
		en: m.lang_label_en,
		es: m.lang_label_es
	};
</script>

<section data-testid="text-picker" class="flex w-full max-w-2xl flex-col gap-4">
	<h2 class="text-2xl font-semibold">{m.picker_heading()}</h2>
	<ul class="grid gap-4 sm:grid-cols-2">
		{#each books as book (book.id)}
			<li>
				<!-- A locale-aware link: /es/type/... from the ES UI, keeping content language
				     independent of the UI locale. Selecting navigates to the book's typing page. -->
				<a
					data-testid="text-picker-option-{book.id}"
					href={resolve(localizeHref(`/type/${book.id}`) as Pathname)}
					class="block w-full rounded-lg border border-zinc-300 p-4 text-left transition-colors hover:border-zinc-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900"
				>
					<span class="block text-lg font-semibold">{book.title}</span>
					<span class="block text-sm text-zinc-600">{book.author}</span>
					<span class="mt-2 block text-sm text-zinc-500">
						{languageLabels[book.language]()} · {m.picker_chunk_count({ count: book.chunkCount })}
					</span>
				</a>
			</li>
		{/each}
	</ul>
</section>
