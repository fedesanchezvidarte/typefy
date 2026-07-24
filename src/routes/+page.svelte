<script lang="ts">
	import type { Pathname } from '$app/types';
	import { resolve } from '$app/paths';
	import { m } from '$lib/paraglide/messages';
	import { localizeHref } from '$lib/paraglide/runtime';
	import LandingHero from '$lib/components/landing/LandingHero.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>{m.app_name()}</title>
	<meta name="description" content={m.tagline()} />
</svelte:head>

<main class="mx-auto w-full max-w-[860px] px-6 pt-13 pb-24">
	<p class="mb-3.5 text-center text-xs tracking-[0.18em] text-muted uppercase">
		{m.landing_kicker()}
	</p>
	<h1
		class="mx-auto mb-3.5 text-center text-[clamp(28px,5vw,46px)] leading-[1.12] font-semibold tracking-[-0.025em] text-balance"
	>
		{m.landing_headline()}
	</h1>
	<p
		class="mx-auto mb-10 max-w-[540px] text-center text-base leading-relaxed text-pretty text-muted"
	>
		{m.landing_sub()}
	</p>

	{#if data.heroBook}
		<LandingHero book={data.heroBook} />
		<p class="mt-4 text-center text-[13px] text-muted">{m.landing_hint()}</p>
	{/if}

	<div class="mt-18 grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-7">
		<div>
			<h2 class="mb-1.5 text-[15px] font-semibold">{m.landing_feature_read_title()}</h2>
			<p class="text-sm leading-relaxed text-muted">{m.landing_feature_read_body()}</p>
		</div>
		<div>
			<h2 class="mb-1.5 text-[15px] font-semibold">{m.landing_feature_tonal_title()}</h2>
			<p class="text-sm leading-relaxed text-muted">{m.landing_feature_tonal_body()}</p>
		</div>
		<div>
			<h2 class="mb-1.5 text-[15px] font-semibold">{m.landing_feature_guest_title()}</h2>
			<p class="text-sm leading-relaxed text-muted">{m.landing_feature_guest_body()}</p>
		</div>
	</div>

	<div class="mt-16 flex flex-col items-center gap-4.5">
		<p class="text-xs tracking-[0.16em] text-muted uppercase">{m.landing_library_kicker()}</p>
		<a
			data-testid="start-typing-cta"
			href={resolve(localizeHref('/type') as Pathname)}
			class="rounded-[10px] border border-border bg-sheet px-5.5 py-3 text-[15px] text-fg transition-colors hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
		>
			{m.landing_library_cta()}
		</a>
	</div>
</main>
