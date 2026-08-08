<script lang="ts">
	import { Pencil } from '@lucide/svelte';
	import { m } from '$lib/paraglide/messages';
	import type { FontId } from '$lib/theme/fonts';
	import type { PaletteId } from '$lib/theme/palettes';
	import LanguageSwitcher from '../LanguageSwitcher.svelte';
	import FontSwitcher from './FontSwitcher.svelte';
	import PaletteSwitcher from './PaletteSwitcher.svelte';
	import RibbonPanel from './RibbonPanel.svelte';

	/**
	 * Pencil trigger + ribbon panel hosting the three theme/language groups (Phase 5a, spec
	 * #30 §2). Composes `FontSwitcher`, `PaletteSwitcher`, `LanguageSwitcher` as-is — they keep
	 * their own cookie-write/dataset logic; this component only supplies the shared open/close
	 * chrome and layout (via `RibbonPanel`).
	 */
	interface Props {
		palette: PaletteId | null;
		font: FontId | null;
		signedIn: boolean;
	}

	let { palette, font, signedIn }: Props = $props();

	let open = $state(false);
	let triggerEl = $state<HTMLButtonElement | null>(null);
</script>

<div class="trigger-wrap">
	<button
		type="button"
		bind:this={triggerEl}
		class="icon-trigger"
		data-testid="pencil-trigger"
		aria-label={m.header_pencil_aria_label()}
		aria-expanded={open}
		aria-haspopup="true"
		title={m.header_pencil_aria_label()}
		onclick={() => (open = !open)}
	>
		<Pencil size={20} strokeWidth={1.75} aria-hidden="true" />
	</button>

	<RibbonPanel
		bind:open
		{triggerEl}
		width="min(320px, calc(100vw - 32px))"
		label={m.header_pencil_aria_label()}
	>
		<div class="flex flex-col gap-4">
			<section>
				<h2 class="panel-heading">{m.theme_font_group_label()}</h2>
				<FontSwitcher initial={font} />
			</section>
			<section>
				<h2 class="panel-heading">{m.theme_palette_group_label()}</h2>
				<PaletteSwitcher initial={palette} />
			</section>
			<section>
				<h2 class="panel-heading">{m.language_switcher_label()}</h2>
				<LanguageSwitcher {signedIn} />
			</section>
		</div>
	</RibbonPanel>
</div>

<style>
	.trigger-wrap {
		position: relative;
		display: inline-flex;
	}

	.icon-trigger {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 36px;
		height: 36px;
		border-radius: 8px;
		color: var(--fg);
		cursor: pointer;
	}

	.icon-trigger:hover {
		background: color-mix(in srgb, var(--fg) 8%, transparent);
	}

	.icon-trigger:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	.panel-heading {
		margin-bottom: 6px;
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--muted);
	}
</style>
