<script lang="ts">
	import { m } from '$lib/paraglide/messages';

	interface Props {
		/** 1-based active page number, matching `PageMeta`. */
		current: number;
		total: number;
		/**
		 * Fires with an ABSOLUTE, 0-based chunk index — the shape `session.ts`'s `seek`
		 * event and `resolveStartIndex` both already use. The 1-based/0-based translation
		 * happens once, here, so nothing downstream has to re-derive it.
		 */
		onNavigate: (index: number) => void;
	}

	let { current, total, onNavigate }: Props = $props();

	/**
	 * Free text while typing in the jump box, reset to `current` whenever IT moves (a
	 * navigator click, or an auto-advance elsewhere on the page) — a "writable `$derived`":
	 * Svelte 5 lets a `$derived` be assigned to directly (the jump box's own `bind:value`,
	 * and `submitJump` resetting on an invalid entry), and the assignment holds until
	 * `current` changes again, at which point it recomputes. No separate `$state` + `$effect`
	 * pair needed for what is really one value with two writers.
	 */
	let jumpValue = $derived(String(current));

	const atStart = $derived(current <= 1);
	const atEnd = $derived(current >= total);

	function goPrevious() {
		if (!atStart) onNavigate(current - 2); // current is 1-based; -2 lands one page back
	}

	function goNext() {
		if (!atEnd) onNavigate(current); // current (1-based) IS the next page's 0-based index
	}

	/**
	 * The jump box. Invalid or out-of-range input is silently ignored rather than
	 * clamped or erroring — the same "a stale/hand-edited value must never break the
	 * flow" posture `resolveStartIndex` already applies to `?page=`. The field simply
	 * resets to the current page on the next render (the `$effect` above).
	 */
	function submitJump(event: SubmitEvent) {
		event.preventDefault();
		const parsed = Number.parseInt(jumpValue, 10);
		if (
			!Number.isFinite(parsed) ||
			parsed < 1 ||
			parsed > total ||
			String(parsed) !== jumpValue.trim()
		) {
			jumpValue = String(current);
			return;
		}
		if (parsed !== current) {
			onNavigate(parsed - 1);
		}
	}
</script>

<!-- No keyboard shortcuts (spec #32, deliberate): arrows and the jump box are the
     whole affordance. -->
<nav
	class="flex items-center gap-2 text-sm text-muted"
	aria-label={m.page_nav_group_label()}
	data-testid="page-navigator"
>
	<button
		type="button"
		data-testid="page-nav-previous"
		class="rounded-md border border-border px-2 py-1 transition-colors hover:border-accent hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border disabled:hover:text-muted"
		aria-label={m.page_nav_previous()}
		disabled={atStart}
		onclick={goPrevious}
	>
		‹
	</button>
	<form class="flex items-center gap-1.5" onsubmit={submitJump}>
		<label class="sr-only" for="page-nav-jump">{m.page_nav_jump_label()}</label>
		<input
			id="page-nav-jump"
			data-testid="page-nav-jump"
			class="w-12 rounded-md border border-border bg-transparent px-1.5 py-1 text-center tabular-nums focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
			type="text"
			inputmode="numeric"
			autocomplete="off"
			bind:value={jumpValue}
		/>
		<span data-testid="page-nav-total">{m.page_nav_of({ total })}</span>
	</form>
	<button
		type="button"
		data-testid="page-nav-next"
		class="rounded-md border border-border px-2 py-1 transition-colors hover:border-accent hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border disabled:hover:text-muted"
		aria-label={m.page_nav_next()}
		disabled={atEnd}
		onclick={goNext}
	>
		›
	</button>
</nav>
