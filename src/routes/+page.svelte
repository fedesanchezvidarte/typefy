<script lang="ts">
	import { m } from '$lib/paraglide/messages';
	import LanguageSwitcher from '$lib/components/LanguageSwitcher.svelte';
</script>

<svelte:head>
	<title>{m.app_name()}</title>
	<meta name="description" content={m.tagline()} />
</svelte:head>

<main class="flex min-h-svh flex-col items-center justify-center gap-6 p-8 text-center">
	<h1 class="text-5xl font-bold tracking-tight">{m.app_name()}</h1>
	<p class="text-lg text-zinc-600">{m.tagline()}</p>
	<LanguageSwitcher />
</main>
