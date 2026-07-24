<script lang="ts">
	import { m } from '$lib/paraglide/messages';
	import {
		DEFAULT_DARK_PALETTE,
		DEFAULT_LIGHT_PALETTE,
		PALETTE_IDS,
		PALETTES,
		type PaletteId
	} from '$lib/theme/palettes';
	import { PALETTE_COOKIE, themeCookie } from '$lib/theme/theme';

	interface Props {
		/** The cookie choice as read by the server; null = no explicit choice yet. */
		initial: PaletteId | null;
	}

	let { initial }: Props = $props();

	// Deliberately initial-only: after mount the switcher owns the selection
	// (the server value never changes without a reload).
	// svelte-ignore state_referenced_locally
	let selected = $state(initial);

	/*
	 * With no explicit choice the CSS media query paints the default palette, but
	 * the dots don't know which one that was. matchMedia is external state, so an
	 * effect (client-only by definition) resolves the visual selection once.
	 */
	$effect(() => {
		if (selected === null) {
			selected = window.matchMedia('(prefers-color-scheme: dark)').matches
				? DEFAULT_DARK_PALETTE
				: DEFAULT_LIGHT_PALETTE;
		}
	});

	const labels: Record<PaletteId, () => string> = {
		'warm-light': m.palette_warm_light,
		'cool-light': m.palette_cool_light,
		'soft-dark': m.palette_soft_dark,
		'near-black': m.palette_near_black
	};

	function choose(id: PaletteId) {
		selected = id;
		document.documentElement.dataset.palette = id;
		document.cookie = themeCookie(PALETTE_COOKIE, id);
	}
</script>

<div class="flex gap-1.5" role="group" aria-label={m.theme_palette_group_label()}>
	{#each PALETTE_IDS as id (id)}
		<button
			type="button"
			data-testid="palette-{id}"
			class={['dot', selected === id && 'dot-selected']}
			style:--dot-bg={PALETTES[id].tokens.bg}
			style:--dot-fg={PALETTES[id].tokens.fg}
			aria-label={labels[id]()}
			aria-pressed={selected === id}
			title={labels[id]()}
			onclick={() => choose(id)}
		></button>
	{/each}
</div>

<style>
	/* A dot previews its palette with the palette's own bg/fg split — these two
	   colours are the palette's identity, not themeable chrome. */
	.dot {
		width: 20px;
		height: 20px;
		border-radius: 50%;
		padding: 0;
		cursor: pointer;
		border: 1px solid var(--border);
		background: linear-gradient(135deg, var(--dot-bg) 0 50%, var(--dot-fg) 50% 100%);
	}

	.dot-selected {
		border: 2px solid var(--accent);
	}

	.dot:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
</style>
