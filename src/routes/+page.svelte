<script lang="ts">
	import type { Pathname } from '$app/types';
	import { resolve } from '$app/paths';
	import { m } from '$lib/paraglide/messages';
	import { localizeHref } from '$lib/paraglide/runtime';
	import LandingHero from '$lib/components/landing/LandingHero.svelte';
	import AnimatedHeadline from '$lib/components/landing/AnimatedHeadline.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// Freezes the headline tail permanently the instant the hero surface sees a real
	// keystroke (spec #30) — a plain flag, not reset by anything, since the freeze is for
	// the lifetime of this page view.
	let heroFrozen = $state(false);
</script>

<svelte:head>
	<title>{m.app_name()}</title>
	<meta name="description" content={m.tagline()} />
</svelte:head>

<!-- Kicker → h1 → hero → hint → CTA centered as one block in the viewport (spec #30),
     replacing the old top-anchored layout. 61px accounts for the sticky header's rendered
     height (py-3 + 36px icon row + border). -->
<main
	class="mx-auto flex min-h-[calc(100vh-61px)] w-full max-w-[860px] flex-col items-center justify-center px-6 pt-12 pb-20"
>
	<p class="mb-3.5 text-center text-xs tracking-[0.18em] text-muted uppercase">
		{m.landing_kicker()}
	</p>
	<AnimatedHeadline frozen={heroFrozen} />

	{#if data.heroBook}
		<!-- The demo reads as its own block, so it gets air above the headline it follows
		     rather than sitting right under the type. -->
		<div class="mt-8 w-full">
			<LandingHero book={data.heroBook} onInteract={() => (heroFrozen = true)} />
		</div>
		<p class="mt-4 text-center text-[13px] text-muted">{m.landing_hint()}</p>
	{/if}

	<a
		data-testid="start-typing-cta"
		href={resolve(localizeHref('/type') as Pathname)}
		class="mt-10 rounded-[10px] border border-border bg-sheet px-5.5 py-3 text-[15px] text-fg transition-colors hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
	>
		{m.landing_library_cta()}
	</a>
</main>
