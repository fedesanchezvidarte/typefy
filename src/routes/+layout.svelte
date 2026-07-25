<script lang="ts">
	import type { Pathname } from '$app/types';
	import type { LayoutData } from './$types';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { locales, localizeHref } from '$lib/paraglide/runtime';
	import AppHeader from '$lib/components/AppHeader.svelte';
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';

	let { children, data }: { children: import('svelte').Snippet; data: LayoutData } = $props();
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>

<AppHeader user={data.user} palette={data.palette} font={data.font} />
{@render children()}

<div style="display:none">
	{#each locales as locale (locale)}
		<a href={resolve(localizeHref(page.url.pathname, { locale }) as Pathname)}>{locale}</a>
	{/each}
</div>
