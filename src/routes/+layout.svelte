<script lang="ts">
	import type { Pathname } from '$app/types';
	import type { LayoutData } from './$types';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { locales, localizeHref } from '$lib/paraglide/runtime';
	import AuthControl from '$lib/components/AuthControl.svelte';
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';

	let { children, data }: { children: import('svelte').Snippet; data: LayoutData } = $props();
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>

<!-- Fixed corner control so it lives in the layout without pushing the full-height
     typing pages. It is not part of the typing surface (spec #7). -->
<header class="fixed top-4 right-4 z-10">
	<AuthControl user={data.user} />
</header>
{@render children()}

<div style="display:none">
	{#each locales as locale (locale)}
		<a href={resolve(localizeHref(page.url.pathname, { locale }) as Pathname)}>{locale}</a>
	{/each}
</div>
