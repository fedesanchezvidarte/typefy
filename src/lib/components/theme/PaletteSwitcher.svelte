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

<!-- Phase 5a (spec #30 §2): each option is a miniature page specimen — bg rect, sheet card,
     two fg text rules, one accent mark — rather than a half-circle bg/fg chip. -->
<div class="flex gap-2" role="group" aria-label={m.theme_palette_group_label()}>
	{#each PALETTE_IDS as id (id)}
		<button
			type="button"
			data-testid="palette-{id}"
			class={['page', selected === id && 'page-selected']}
			style:--page-bg={PALETTES[id].tokens.bg}
			style:--page-sheet={PALETTES[id].tokens.sheet}
			style:--page-fg={PALETTES[id].tokens.fg}
			style:--page-accent={PALETTES[id].tokens.accent}
			aria-label={labels[id]()}
			aria-pressed={selected === id}
			title={labels[id]()}
			onclick={() => choose(id)}
		>
			<span class="page-sheet">
				<span class="page-rule"></span>
				<span class="page-rule page-rule-short"></span>
				<span class="page-accent"></span>
			</span>
		</button>
	{/each}
</div>

<style>
	/* A miniature page: the button IS the bg rect, a sheet card sits inset on it, two fg
	   rules stand in for text, and one accent mark completes the palette's four-colour
	   identity — the same split the real typing surface renders. */
	.page {
		width: 56px;
		height: 44px;
		padding: 6px;
		border-radius: 8px;
		cursor: pointer;
		border: 1px solid var(--border);
		background: var(--page-bg);
	}

	.page-selected {
		border: 2px solid var(--accent);
	}

	.page:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	.page-sheet {
		display: flex;
		flex-direction: column;
		gap: 3px;
		width: 100%;
		height: 100%;
		border-radius: 4px;
		padding: 5px 6px;
		background: var(--page-sheet);
	}

	.page-rule {
		display: block;
		height: 2px;
		border-radius: 1px;
		width: 100%;
		background: var(--page-fg);
	}

	.page-rule-short {
		width: 65%;
	}

	.page-accent {
		display: block;
		margin-top: 2px;
		width: 30%;
		height: 2px;
		border-radius: 1px;
		background: var(--page-accent);
	}
</style>
