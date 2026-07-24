<script lang="ts">
	import type { PageData } from './$types';
	import { m } from '$lib/paraglide/messages';
	import TextPicker from '$lib/components/typing/TextPicker.svelte';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>{m.typing_page_title()} · {m.app_name()}</title>
</svelte:head>

<main class="flex min-h-svh flex-col items-center gap-8 p-8">
	<TextPicker books={data.books} />
</main>
