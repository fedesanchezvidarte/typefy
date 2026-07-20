<script lang="ts">
	import { m } from '$lib/paraglide/messages';
	import type { TypeableText } from '$lib/types';

	interface Props {
		texts: readonly TypeableText[];
		onSelect: (text: TypeableText) => void;
	}

	let { texts, onSelect }: Props = $props();

	/* Content language of a text — independent of the UI locale (spec #5). */
	const languageLabels = {
		en: m.lang_label_en,
		es: m.lang_label_es
	};
</script>

<section data-testid="text-picker" class="flex w-full max-w-2xl flex-col gap-4">
	<h2 class="text-2xl font-semibold">{m.picker_heading()}</h2>
	<ul class="grid gap-4 sm:grid-cols-2">
		{#each texts as text (text.id)}
			<li>
				<button
					type="button"
					data-testid="text-picker-option-{text.id}"
					class="w-full rounded-lg border border-zinc-300 p-4 text-left transition-colors hover:border-zinc-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900"
					onclick={() => onSelect(text)}
				>
					<span class="block text-lg font-semibold">{text.title}</span>
					<span class="block text-sm text-zinc-600">{text.author}</span>
					<span class="mt-2 block text-sm text-zinc-500">
						{languageLabels[text.language]()} · {m.picker_chunk_count({ count: text.chunkCount })}
					</span>
				</button>
			</li>
		{/each}
	</ul>
</section>
