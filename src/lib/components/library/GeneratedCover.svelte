<script lang="ts">
	import { m } from '$lib/paraglide/messages';
	import { coverTitleSize } from '$lib/theme/cover';
	import type { TypeableTextSummary } from '$lib/types';

	interface Props {
		book: TypeableTextSummary;
	}

	let { book }: Props = $props();

	/* Content language label — the book's language, independent of UI locale. */
	const languageLabels = {
		en: m.lang_label_en,
		es: m.lang_label_es
	};

	const titleSize = $derived(coverTitleSize(book.title));
</script>

<!-- Generated typographic cover (spec #9, brief §3): composed from the book's
     own title and author, set in the active font on a colour drawn from the
     active palette — it restyles with the theme. -->
<div class="cover" data-testid="generated-cover">
	<span class="lang">{languageLabels[book.language]()}</span>
	<span class={['title', titleSize]}>{book.title}</span>
	<span class="author">{book.author}</span>
</div>

<style>
	.cover {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		justify-content: space-between;
		padding: 16px;
		background: color-mix(in oklab, var(--accent) 14%, var(--sheet));
		text-align: left;
	}

	.lang {
		font-size: 10px;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--muted);
	}

	.title {
		font-weight: 600;
		line-height: 1.12;
		letter-spacing: -0.01em;
		color: var(--fg);
		overflow-wrap: anywhere;
	}

	/* Title-length-based size steps (coverTitleSize): a one-word and a
	   twelve-word title both sit correctly in the same 2/3 frame. */
	.title.lg {
		font-size: 32px;
	}

	.title.md {
		font-size: 25px;
	}

	.title.sm {
		font-size: 19px;
	}

	.author {
		font-size: 12px;
		color: var(--muted);
	}
</style>
