<script lang="ts">
	import type { Pathname } from '$app/types';
	import { resolve } from '$app/paths';
	import { m } from '$lib/paraglide/messages';
	import { localizeHref } from '$lib/paraglide/runtime';
	import LanguageSwitcher from '$lib/components/LanguageSwitcher.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>{m.app_name()}</title>
	<meta name="description" content={m.tagline()} />
</svelte:head>

<main class="flex min-h-svh flex-col items-center justify-center gap-6 p-8 text-center">
	<h1 class="text-5xl font-bold tracking-tight">{m.app_name()}</h1>
	<p class="text-lg text-zinc-600">{m.tagline()}</p>
	<a
		data-testid="start-typing-cta"
		href={resolve(localizeHref('/type') as Pathname)}
		class="rounded-md bg-zinc-900 px-6 py-3 text-lg font-semibold text-white transition-colors hover:bg-zinc-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900"
	>
		{m.landing_start_typing()}
	</a>
	<LanguageSwitcher signedIn={!!data.user} />
</main>
