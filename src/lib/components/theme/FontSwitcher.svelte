<script lang="ts">
	import { m } from '$lib/paraglide/messages';
	import { DEFAULT_FONT, FONT_IDS, FONTS, type FontId } from '$lib/theme/fonts';
	import { FONT_COOKIE, themeCookie } from '$lib/theme/theme';

	interface Props {
		/** The cookie choice as read by the server; null = default (sans). */
		initial: FontId | null;
	}

	let { initial }: Props = $props();

	// Deliberately initial-only: after mount the switcher owns the selection
	// (the server value never changes without a reload).
	// svelte-ignore state_referenced_locally
	let selected = $state(initial ?? DEFAULT_FONT);

	const labels: Record<FontId, () => string> = {
		sans: m.font_sans,
		serif: m.font_serif,
		mono: m.font_mono
	};

	function choose(id: FontId) {
		selected = id;
		document.documentElement.dataset.font = id;
		document.cookie = themeCookie(FONT_COOKIE, id);
	}
</script>

<!-- Phase 5a (spec #30 §2): a specimen list, not a pill row — each option is set in its own
     face so the choice is legible before it's made, rendered inside PencilPanel. The row shows
     a specimen phrase in the face plus the face's own name; the accessible name stays the short
     axis label ("Sans"/"Serif"/"Mono") via aria-label, since the specimen text is decoration.
     Selection is an accent hairline on a sheet fill, matching PaletteSwitcher and the library
     filter pills — not a filled-dark chip. -->
<div class="flex flex-col gap-1" role="group" aria-label={m.theme_font_group_label()}>
	{#each FONT_IDS as id (id)}
		<button
			type="button"
			data-testid="font-{id}"
			class={['specimen', selected === id && 'specimen-selected']}
			aria-label={labels[id]()}
			aria-pressed={selected === id}
			onclick={() => choose(id)}
		>
			<span class="specimen-text" style:font-family={FONTS[id].stack}>{m.font_specimen()}</span>
			<span class="specimen-name">{FONTS[id].name}</span>
		</button>
	{/each}
</div>

<style>
	.specimen {
		display: flex;
		flex-direction: column;
		gap: 2px;
		width: 100%;
		border: 1px solid transparent;
		border-radius: 8px;
		padding: 7px 10px;
		text-align: left;
		cursor: pointer;
		transition:
			border-color 120ms ease,
			background-color 120ms ease;
	}

	.specimen:hover:not(.specimen-selected) {
		background: color-mix(in srgb, var(--fg) 6%, transparent);
	}

	.specimen-selected {
		border-color: var(--accent);
		background: var(--sheet);
	}

	.specimen:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	.specimen-text {
		font-size: 15px;
		line-height: 1.2;
		color: var(--fg);
	}

	.specimen-name {
		font-size: 10px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--muted);
	}
</style>
