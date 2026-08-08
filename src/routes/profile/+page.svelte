<script lang="ts">
	import type { PageData } from './$types';
	import { m } from '$lib/paraglide/messages';

	let { data }: { data: PageData } = $props();

	const displayName = $derived(
		data.user.user_metadata?.full_name ?? data.user.user_metadata?.name ?? data.user.email ?? ''
	);
</script>

<svelte:head>
	<title>{m.profile_heading()} · {m.app_name()}</title>
</svelte:head>

<main class="mx-auto w-full max-w-[560px] px-6 pt-16 pb-24">
	<h1 class="mb-6 text-[26px] font-semibold tracking-[-0.02em] text-fg">{m.profile_heading()}</h1>
	<div class="rounded-xl border border-border bg-sheet p-6">
		<p class="text-[15px] font-medium text-fg">{displayName}</p>
		{#if data.user.email}
			<p class="mt-1 text-[13px] text-muted">{data.user.email}</p>
		{/if}
		<p class="mt-5 text-[14px] text-muted">{m.profile_coming_soon()}</p>
	</div>
</main>
