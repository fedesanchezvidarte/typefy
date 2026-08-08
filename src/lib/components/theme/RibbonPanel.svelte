<script module lang="ts">
	/**
	 * A cubic-bezier(0.16, 1, 0.3, 1) evaluator (Newton-Raphson root-finding — the standard
	 * approach for turning an authored bezier curve into a `(t) => easedT` function, mirroring
	 * what a browser does natively for `transition-timing-function`). Needed because Svelte's
	 * JS-driven `css()` transitions ease in script, not CSS: this is the fast-start /
	 * gentle-settle "ease-out-expo"-family curve the brief names for the unfold transform
	 * (§3.2), not a generic linear/cubicOut stand-in.
	 */
	function cubicBezier(p1x: number, p1y: number, p2x: number, p2y: number) {
		const A = (a1: number, a2: number) => 1 - 3 * a2 + 3 * a1;
		const B = (a1: number, a2: number) => 3 * a2 - 6 * a1;
		const C = (a1: number) => 3 * a1;
		const calc = (t: number, a1: number, a2: number) =>
			((A(a1, a2) * t + B(a1, a2)) * t + C(a1)) * t;
		const slope = (t: number, a1: number, a2: number) =>
			3 * A(a1, a2) * t * t + 2 * B(a1, a2) * t + C(a1);

		function tForX(x: number): number {
			let t = x;
			for (let i = 0; i < 8; i++) {
				const currentSlope = slope(t, p1x, p2x);
				if (currentSlope === 0) break;
				t -= (calc(t, p1x, p2x) - x) / currentSlope;
			}
			return t;
		}

		return (x: number) => {
			if (x <= 0) return 0;
			if (x >= 1) return 1;
			return calc(tForX(x), p1y, p2y);
		};
	}

	const EASE_OUT_EXPO_FAMILY = cubicBezier(0.16, 1, 0.3, 1);
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * Shared ribbon-panel shell (Phase 5a, spec #30 §2): the anchored dropdown used by both
	 * `PencilPanel` and `AccountMenu`. Owns the open/close mechanics — outside-click, Escape,
	 * the ~180ms unfold/page-turn transform, reduced-motion handling — so neither consumer
	 * reimplements them.
	 *
	 * Positioning is CSS-only (`position: absolute; top: 100%; right: 0`, brief §3.1): the
	 * caller wraps its trigger button AND this component in one `position: relative` element,
	 * which is what anchors the panel to the header's bottom edge, right-aligned to the
	 * trigger, with no JS measurement needed.
	 */
	interface Props {
		/** Bindable so the trigger button (owned by the caller) can toggle it directly. */
		open: boolean;
		/**
		 * The trigger button's element, needed for two things only RibbonPanel can't infer
		 * from CSS: excluding it from "outside click" (otherwise the trigger's own click would
		 * immediately reopen a panel it just closed) and returning focus there when Escape
		 * closes the panel (focus must never silently die — CLAUDE.md keyboard rule).
		 */
		triggerEl: HTMLElement | null;
		/** CSS width, e.g. `min(320px, calc(100vw - 32px))` — content-driven per panel. */
		width: string;
		/** Accessible name for the panel region. */
		label: string;
		children: Snippet;
	}

	let { open = $bindable(), triggerEl, width, label, children }: Props = $props();

	let panelEl = $state<HTMLElement | null>(null);

	function isOutside(target: EventTarget | null): boolean {
		const node = target as Node | null;
		if (!node) return true;
		if (panelEl?.contains(node)) return false;
		if (triggerEl?.contains(node)) return false;
		return true;
	}

	function handlePointerDown(event: PointerEvent) {
		if (isOutside(event.target)) {
			open = false;
		}
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			event.preventDefault();
			open = false;
			triggerEl?.focus();
		}
	}

	// Listeners only exist while the panel is open — nothing to clean up on a closed panel,
	// and a stray outside click never has anything to evaluate against.
	$effect(() => {
		if (!open) return;
		document.addEventListener('pointerdown', handlePointerDown);
		document.addEventListener('keydown', handleKeydown);
		return () => {
			document.removeEventListener('pointerdown', handlePointerDown);
			document.removeEventListener('keydown', handleKeydown);
		};
	});

	/**
	 * The ~180ms unfold/page-turn transform (brief §3.2, a resolved judgment call, not a new
	 * aesthetic decision): scaleY on one axis only (0.4 → 1) plus a short upward translate and
	 * an opacity fade. `prefers-reduced-motion: reduce` collapses the duration to 0 — an
	 * instant, transform-free toggle rather than a shortened animation.
	 */
	function unfold(_node: Element, { duration = 180 }: { duration?: number } = {}) {
		const reduced =
			typeof window !== 'undefined' &&
			window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		return {
			duration: reduced ? 0 : duration,
			easing: EASE_OUT_EXPO_FAMILY,
			css: (t: number) =>
				`transform-origin: top center; transform: scaleY(${0.4 + 0.6 * t}) translateY(${-8 * (1 - t)}px); opacity: ${t};`
		};
	}
</script>

{#if open}
	<div bind:this={panelEl} class="ribbon-panel" aria-label={label} style:width transition:unfold>
		{@render children()}
	</div>
{/if}

<style>
	/*
	 * Bookmark-ribbon shape (brief §3.1): flush against the header's bottom edge — no gap,
	 * square top corners, as if the ribbon hangs directly off the header rule — with a
	 * V-shaped notch cut into the bottom edge, the classic cut-tail end of a ribbon. The
	 * notch is a `clip-path` rather than a border trick because the panel's background,
	 * border AND box-shadow all need to follow the same silhouette.
	 */
	.ribbon-panel {
		position: absolute;
		top: 100%;
		right: 0;
		margin-top: 0;
		max-width: calc(100vw - 32px);
		background: var(--sheet);
		border: 1px solid var(--border);
		border-top: none;
		border-radius: 0 0 10px 10px;
		box-shadow: 0 16px 36px -14px rgba(0, 0, 0, 0.4);
		padding: 14px 14px calc(14px + 12px) 14px;
		clip-path: polygon(
			0% 0%,
			100% 0%,
			100% calc(100% - 12px),
			58% calc(100% - 12px),
			50% 100%,
			42% calc(100% - 12px),
			0% calc(100% - 12px)
		);
		z-index: 30;
	}
</style>
