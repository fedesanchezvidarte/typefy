<script lang="ts">
	import type { PageData } from './$types';
	import { page } from '$app/state';
	import { m } from '$lib/paraglide/messages';
	import TypingSession from '$lib/components/typing/TypingSession.svelte';

	let { data }: { data: PageData } = $props();

	// Read here, passed down as a prop: `TypingSession` takes `userId` rather than reading
	// `page.data.user` itself, so its component tests can drive guest vs signed-in without
	// stubbing `$app/state` (brief §3.7). It is also the sole gate on the write path.
	const userId = $derived(page.data.user?.id ?? null);
</script>

<svelte:head>
	<title>{data.book.title} · {m.app_name()}</title>
</svelte:head>

<!-- Fresh session per book: keying on the slug remounts the whole flow on navigation.
     Deliberately keyed on the slug and NOT on `startIndex`, so a `?passage=N` change
     does not remount and discard an in-flight session. -->
{#key data.book.id}
	<TypingSession
		book={data.book}
		startIndex={data.startIndex}
		chunksCompleted={data.chunksCompleted}
		completedChunkIds={data.completedChunkIds}
		{userId}
	/>
{/key}
