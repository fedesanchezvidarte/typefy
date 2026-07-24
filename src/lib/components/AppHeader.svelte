<script lang="ts">
	import type { User } from '@supabase/supabase-js';
	import type { Pathname } from '$app/types';
	import { resolve } from '$app/paths';
	import { m } from '$lib/paraglide/messages';
	import { localizeHref } from '$lib/paraglide/runtime';
	import type { FontId } from '$lib/theme/fonts';
	import type { PaletteId } from '$lib/theme/palettes';
	import AuthControl from './AuthControl.svelte';
	import LanguageSwitcher from './LanguageSwitcher.svelte';
	import FontSwitcher from './theme/FontSwitcher.svelte';
	import PaletteSwitcher from './theme/PaletteSwitcher.svelte';

	interface Props {
		user: User | null;
		palette: PaletteId | null;
		font: FontId | null;
	}

	let { user, palette, font }: Props = $props();
</script>

<!-- Sticky, blurred over the page background (spec #9): the settings surface
     for both theme axes lives here — theming is a feature, so it is showcased. -->
<header
	class="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border px-4 py-3 backdrop-blur-[10px] sm:px-6"
	style="background: color-mix(in srgb, var(--bg) 86%, transparent);"
>
	<a
		href={resolve(localizeHref('/') as Pathname)}
		class="flex items-center rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
		data-testid="wordmark"
	>
		<span class="text-[21px] font-semibold tracking-[-0.03em] text-fg"
			>{m.app_name().toLowerCase()}</span
		>
		<span
			class="ml-[3px] inline-block h-[19px] w-[3px] translate-y-[2px] rounded-[1px] bg-accent"
			aria-hidden="true"
		></span>
	</a>
	<div class="flex flex-wrap items-center gap-x-3 gap-y-2">
		<PaletteSwitcher initial={palette} />
		<div class="h-5 w-px bg-border" aria-hidden="true"></div>
		<FontSwitcher initial={font} />
		<div class="h-5 w-px bg-border" aria-hidden="true"></div>
		<LanguageSwitcher signedIn={!!user} />
		<nav class="flex items-center">
			<a
				href={resolve(localizeHref('/type') as Pathname)}
				data-testid="nav-library"
				class="rounded-md px-2 py-1.5 text-[13px] text-muted transition-colors hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
			>
				{m.header_library()}
			</a>
		</nav>
		<AuthControl {user} />
	</div>
</header>
