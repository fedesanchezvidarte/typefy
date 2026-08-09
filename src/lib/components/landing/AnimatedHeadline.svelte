<script lang="ts">
	import { untrack } from 'svelte';
	import { m } from '$lib/paraglide/messages';

	interface Props {
		/**
		 * True the instant the hero `TypingSurface` has seen a real keystroke
		 * (spec #30): the tail animation stops permanently for this page view and
		 * settles back on the first word ("book" / "un libro").
		 */
		frozen: boolean;
	}

	let { frozen }: Props = $props();

	/*
	 * Fixed cycle order: book → page → word, looping forever. Three flat keys per
	 * locale rather than a structured message — see the Feature Brief §7, each word
	 * needs independent per-locale text and the cycle order never changes at runtime.
	 *
	 * Spec #32 dropped the fourth word, "passage": once "page" became this product's own
	 * term for a chunk (superseding "passage" in the UI), keeping a separate "passage" tail
	 * word would have cycled the headline through two words that mean the same thing here.
	 * "book" and "word" still name genuinely different scales of text, so the cycle is
	 * shortened rather than the collision papered over with a synonym.
	 */
	// Paraglide messages return a branded `LocalizedString`; the animation slices these
	// strings character by character, which yields plain `string`s that no longer carry the
	// brand — so the words the animation actually works with are plain strings from the start.
	const words = $derived([
		`${m.landing_headline_tail_book()}`,
		`${m.landing_headline_tail_page()}`,
		`${m.landing_headline_tail_word()}`
	]);

	/*
	 * Visual-taste values (flagged in the final report per the brief §4): a 55ms
	 * per-character type/backspace interval and an 1800ms hold on a completed
	 * word, picked from the spec's 1.6-2s range.
	 */
	const CHAR_INTERVAL_MS = 55;
	const HOLD_MS = 1800;

	// `untrack`: this is a one-time initial value, not a live binding — displayText is
	// mutated independently by the animation afterward, so it must not re-derive from
	// `words` on every locale change (that would fight the in-flight animation).
	let wordIndex = $state(0);
	let displayText = $state(untrack(() => words[0]));
	let caretVisible = $state(false);
	let started = false;
	let timer: ReturnType<typeof setTimeout> | undefined;

	function reducedMotion() {
		return (
			typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
		);
	}

	function clearTimer() {
		if (timer) clearTimeout(timer);
		timer = undefined;
	}

	function typeNextChar(target: string) {
		if (frozen) return;
		if (displayText.length < target.length) {
			caretVisible = true;
			displayText = target.slice(0, displayText.length + 1);
			timer = setTimeout(() => typeNextChar(target), CHAR_INTERVAL_MS);
			return;
		}
		// Word fully typed: hold with the caret hidden, then start backspacing.
		caretVisible = false;
		timer = setTimeout(() => {
			const nextIndex = (wordIndex + 1) % words.length;
			backspaceCurrent(words[nextIndex], nextIndex);
		}, HOLD_MS);
	}

	function backspaceCurrent(nextTarget: string, nextIndex: number) {
		if (frozen) return;
		if (displayText.length > 0) {
			caretVisible = true;
			displayText = displayText.slice(0, -1);
			timer = setTimeout(() => backspaceCurrent(nextTarget, nextIndex), CHAR_INTERVAL_MS);
			return;
		}
		wordIndex = nextIndex;
		timer = setTimeout(() => typeNextChar(nextTarget), CHAR_INTERVAL_MS);
	}

	/* Starts the cycle once, on mount, unless reduced motion says never to animate at all. */
	$effect(() => {
		// Re-reads `words` inside the callback (not captured into a local up front) so a
		// locale switch before the first cycle starts is picked up — `started` guards against
		// the effect re-running and restarting the whole animation on an unrelated change.
		if (started || frozen || reducedMotion()) return;
		started = true;
		timer = setTimeout(() => {
			const nextIndex = (wordIndex + 1) % words.length;
			backspaceCurrent(words[nextIndex], nextIndex);
		}, HOLD_MS);
	});

	/* Freeze: stop wherever we are and settle back on the first word, caret off. */
	$effect(() => {
		if (!frozen) return;
		clearTimer();
		wordIndex = 0;
		displayText = words[0];
		caretVisible = false;
	});
</script>

<h1
	class="mx-auto mb-3.5 text-center text-[clamp(28px,5vw,46px)] leading-[1.12] font-semibold tracking-[-0.025em] text-balance"
>
	<!-- The accessible name is ALWAYS the full static string, regardless of animation state
	     (spec #30) — this is what a screen reader announces for the heading. -->
	<span class="sr-only">{m.landing_headline()} {m.landing_headline_tail_book()}</span>
	<span aria-hidden="true">
		{m.landing_headline()}
		<span class="tail text-accent">
			<!-- Hidden copies of every tail word, stacked in the same grid cell: the cell is
			     exactly as wide as the widest word actually renders, in the real face and at the
			     real size. -->
			{#each words as word (word)}
				<span class="tail-sizer">{word}</span>
			{/each}
			<span class="tail-text"
				>{displayText}<span class="caret" class:caret-visible={caretVisible} aria-hidden="true"
				></span></span
			>
		</span>
	</span>
</h1>

<style>
	/*
	 * Reserves width for the widest tail word so the headline never reflows per word (spec
	 * #30). The reservation used to be a `min-width` in `ch` with the text left-aligned in it,
	 * which over-reserved (a `ch` is the "0" advance, wider than these lowercase words average)
	 * AND parked the whole slack on the right — so a short word like "word" left the line
	 * visibly off-centre. Now the slot is measured from the words themselves and the current
	 * word is centred in it: what slack remains splits evenly, so the line reads as centred
	 * whatever word is showing.
	 */
	.tail {
		display: inline-grid;
	}

	/* Every child shares one cell: the sizers set the width, the live text sits on top. */
	.tail > * {
		grid-area: 1 / 1;
	}

	.tail-sizer {
		visibility: hidden;
		/* Room for the caret, which the sizers don't carry. */
		padding-right: 3px;
	}

	.tail-text {
		justify-self: center;
		white-space: nowrap;
	}

	.caret {
		display: inline-block;
		width: 2px;
		height: 0.85em;
		margin-left: 1px;
		vertical-align: -0.1em;
		background: var(--accent);
		opacity: 0;
	}

	.caret-visible {
		animation: caret-blink 1s step-end infinite;
	}

	@keyframes caret-blink {
		0%,
		50% {
			opacity: 1;
		}
		50.01%,
		100% {
			opacity: 0;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.caret {
			animation: none;
			opacity: 0;
		}
	}
</style>
