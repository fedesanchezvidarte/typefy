<script lang="ts">
	import { m } from '$lib/paraglide/messages';

	interface Props {
		/** The measurement axis, read off the reducer (`session.mode === 'zen'`). */
		zen: boolean;
		onToggle: () => void;
	}

	let { zen, onToggle }: Props = $props();
</script>

<!--
	The mode toggle (spec #50 §4), in the bottom row's left column.

	**The label is the constant word "Zen" in both states.** `aria-pressed` carries the state, so a
	screen reader says "Zen, toggle button, pressed" and the button never renames itself under the
	cursor — which the old `Zen mode` / `Exit Zen` pair did, moving its own hit target on click.

	The mark is an **ensō**: the circle that closes when the axis is Zen. Hand-rolled rather than
	taken from Lucide, and the only such icon in the app — the closing of the circle IS entering,
	which no icon-set glyph says. It is one `<circle>`; the whole animation is `stroke-dashoffset`
	over a dash pattern sized to the circumference (2πr ≈ 44 at r=7).
-->
<button
	type="button"
	data-testid="zen-toggle"
	class="zen"
	aria-pressed={zen}
	aria-label={m.zen_label()}
	onclick={onToggle}
>
	<svg class="enso" viewBox="0 0 18 18" width="16" height="16" aria-hidden="true">
		<!--
			Rotated so the gap sits at the top-right and the stroke closes clockwise from the
			bottom-left, the direction an ensō is drawn.
		-->
		<circle
			cx="9"
			cy="9"
			r="7"
			fill="none"
			stroke="currentColor"
			stroke-width="1.5"
			stroke-linecap="round"
			transform="rotate(-45 9 9)"
		/>
	</svg>
	<span class="label">{m.zen_label()}</span>
</button>

<style>
	.zen {
		display: flex;
		align-items: center;
		gap: 7px;
		border: 1px solid transparent;
		border-radius: 8px;
		padding: 4px 9px;
		font-size: 13px;
		color: var(--muted);
		white-space: nowrap;
		cursor: pointer;
		transition: color 0.15s ease;
	}

	.enso {
		color: var(--dim);
		transition: color 0.15s ease;
	}

	/*
	 * The open ring: a dash of ~80% of the circumference, leaving a gap the eye reads as an
	 * unfinished stroke. 44 is 2πr at r=7; the values are literal rather than computed because
	 * the radius is literal three lines above and a CSS custom property for one number would be
	 * indirection, not clarity.
	 */
	.enso circle {
		stroke-dasharray: 44;
		stroke-dashoffset: 9;
		transition: stroke-dashoffset 0.3s ease;
	}

	.zen:hover {
		color: var(--fg);
	}

	.zen:hover .enso {
		color: var(--fg);
	}

	.zen:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	/* Zen is on: the circle closes and both the mark and the label take the accent. */
	.zen[aria-pressed='true'],
	.zen[aria-pressed='true'] .enso {
		color: var(--accent);
	}

	.zen[aria-pressed='true'] .enso circle {
		stroke-dashoffset: 0;
	}

	/*
	 * Under 640px the label goes and the mark stands alone (spec #50 §5) — the bottom row cannot
	 * hold the toggle, the navigator and the figures on one line otherwise. `aria-label` on the
	 * button already carries the name, so the accessible name is unchanged by the breakpoint.
	 */
	@media (max-width: 639px) {
		.zen {
			padding: 4px 6px;
		}

		.label {
			display: none;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.zen,
		.enso,
		.enso circle {
			transition: none; /* the circle still closes — it just does not draw */
		}
	}
</style>
