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

<!-- Fresh session per book: keying on the book id remounts the whole flow on navigation.
     Deliberately keyed on `data.book.id` and NOT on `startIndex`, so neither a
     `?page=N`/`?passage=N` link nor an in-session page-navigator jump remounts and
     discards a live session (spec #32 §10 D1, "A' engine seek"): a jump is handled
     entirely in-engine (`session.ts`'s `seek` event) plus shallow routing from
     `TypingSession.svelte`, never by widening this key.

     `data.window` is the FIRST window only (spec #18). Windows 2..n never come back
     through this load — `TypingSession` fetches them from the chunks endpoint into its
     own state, because any load invalidation here would re-run the book read and
     re-serialise mid-passage (spec §6).

     `data.mode` is the cookie's value as the server read it (spec #24 §10). It SEEDS the
     session and is not a live binding: the toggle owns the axis from mount on, and writes
     the cookie so the next load agrees. Navigating to another book remounts through this
     `{#key}`, which is what makes the choice survive the navigation. -->

{#key data.book.id}
	<TypingSession
		book={data.book}
		window={data.window}
		startIndex={data.startIndex}
		chunksCompleted={data.chunksCompleted}
		completedChunkIds={data.completedChunkIds}
		mode={data.mode}
		chapters={data.chapters}
		{userId}
	/>
{/key}
