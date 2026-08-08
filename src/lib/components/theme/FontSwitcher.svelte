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
     face so the choice is legible before it's made, rendered inside PencilPanel. -->
<div class="flex flex-col gap-0.5" role="group" aria-label={m.theme_font_group_label()}>
	{#each FONT_IDS as id (id)}
		<button
			type="button"
			data-testid="font-{id}"
			class={[
				'rounded-md px-2.5 py-1.5 text-left text-[15px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
				selected === id ? 'bg-fg text-bg' : 'text-fg hover:bg-border/40'
			]}
			style:font-family={FONTS[id].stack}
			aria-pressed={selected === id}
			onclick={() => choose(id)}
		>
			{labels[id]()}
		</button>
	{/each}
</div>
