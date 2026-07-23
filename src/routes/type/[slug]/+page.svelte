<script lang="ts">
	import type { PageData } from './$types';
	import { m } from '$lib/paraglide/messages';
	import TypingSession from '$lib/components/typing/TypingSession.svelte';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>{data.book.title} · {m.app_name()}</title>
</svelte:head>

<!-- Fresh session per book: keying on the slug remounts the whole flow on navigation. -->
{#key data.book.id}
	<TypingSession book={data.book} />
{/key}
