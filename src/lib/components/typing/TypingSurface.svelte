<script lang="ts">
	import { m } from '$lib/paraglide/messages';
	import type { CharacterState } from '$lib/engine/types';

	interface Props {
		text: string;
		display: readonly CharacterState[];
		cursor: number;
		/**
		 * Identity of the passage being typed (the active chunk index). When it
		 * changes, the character spans re-key and play the ~220ms settle/crossfade
		 * (spec #9) — the input itself stays mounted so focus never drops.
		 */
		passageKey: number;
		onChar: (char: string, timestamp: number) => void;
		onBackspace: (timestamp: number) => void;
		onRestartChunk: () => void;
	}

	let { text, display, cursor, passageKey, onChar, onBackspace, onRestartChunk }: Props = $props();

	/* Code-point-safe split, mirroring the engine (á, ñ, ¿ occupy one position each). */
	const chars = $derived(Array.from(text));

	let input = $state<HTMLInputElement | null>(null);

	/** Lets the page return focus here after button-triggered restarts. */
	export function focusInput() {
		input?.focus();
	}

	function emitTyped(data: string) {
		const composed = Array.from(data);
		if (composed.length !== 1) {
			return; // only single composed characters reach the engine (no paste, no multi-char)
		}
		onChar(composed[0], Date.now());
	}

	/*
	 * Text is read ONLY from beforeinput/input (ADR-0004 as amended): dead-key and IME
	 * composition deliver the final composed character (e.g. 'á'), which is exactly
	 * what the engine judges. keydown below handles control keys only.
	 */
	function handleBeforeInput(event: InputEvent) {
		if (event.inputType === 'insertText') {
			event.preventDefault(); // consume it here; keep the hidden input empty
			if (event.data) {
				emitTyped(event.data);
			}
			return;
		}
		if (event.inputType === 'insertLineBreak' || event.inputType === 'insertParagraph') {
			event.preventDefault(); // chunks never contain newlines
		}
	}

	function handleInput(event: Event) {
		// Composition fallback: while composing we wait; once composition ends the
		// composed value lands in the input — flush it to the engine and clear.
		if ((event as InputEvent).isComposing) {
			return;
		}
		const target = event.currentTarget as HTMLInputElement;
		if (target.value) {
			emitTyped(target.value);
			target.value = '';
		}
	}

	/* Control keys only — never text (dead keys arrive as 'Dead' here and are useless). */
	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Backspace') {
			event.preventDefault();
			onBackspace(Date.now());
		} else if (event.key === 'Escape') {
			event.preventDefault();
			onRestartChunk();
		}
	}
</script>

<!-- A label wrapping the hidden input: clicking anywhere on the sheet natively refocuses it. -->
<label class="surface block w-full cursor-text" data-testid="typing-surface" for="typing-input">
	{#key passageKey}
		<span class="passage">
			<!-- The position index IS the identity of a character slot (fixed-length, never reordered). -->
			{#each chars as char, i (i)}
				<span class={['char', i === cursor && 'caret']} data-state={display[i]}>{char}</span>
			{/each}
			<span class={['char', 'chunk-end', cursor === chars.length && 'caret']} aria-hidden="true">
			</span>
		</span>
	{/key}
	<input
		bind:this={input}
		id="typing-input"
		data-testid="typing-input"
		class="typing-input"
		type="text"
		aria-label={m.typing_input_label()}
		autocomplete="off"
		autocapitalize="off"
		spellcheck="false"
		onbeforeinput={handleBeforeInput}
		oninput={handleInput}
		onkeydown={handleKeydown}
		{@attach (node) => {
			node.focus();
		}}
	/>
</label>

<style>
	/*
	 * The sheet (spec #9, brief §2): the passage sits on its own surface one step
	 * off the background — no texture, no drop-shadow theatre. Engine-surface
	 * rendering lives in scoped CSS (ADR-0008); every colour comes from the
	 * palette token contract in layout.css.
	 *
	 * Tonal, not chromatic: `pending` is dimmed foreground, `correct` and
	 * `corrected` are full foreground (a fixed error carries no lasting mark —
	 * the engine still tracks the state for accuracy), and `incorrect` is the
	 * only chromatic event on the page. There is no green. Colour is never the
	 * only signal: incorrect also gets a wavy underline and a background tint
	 * (visible even on spaces).
	 */
	.surface {
		position: relative;
		max-width: 720px;
		background: var(--sheet);
		border: 1px solid var(--border);
		border-radius: 12px;
		padding: 24px 26px;
		font-size: 18px;
		line-height: 1.85;
		color: var(--fg);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		transition: background-color 0.25s ease;
	}

	@media (min-width: 640px) {
		.surface {
			padding: 34px 38px;
			font-size: 21px;
		}
	}

	/* A brief settle as one passage crossfades into the next; nothing else moves. */
	.passage {
		display: inline;
		animation: settle 0.22s ease;
	}

	@keyframes settle {
		from {
			opacity: 0.45;
		}
	}

	.char {
		border-radius: 2px;
	}

	.char[data-state='pending'] {
		color: var(--dim);
	}

	.char[data-state='correct'],
	.char[data-state='corrected'] {
		color: var(--fg);
	}

	.char[data-state='incorrect'] {
		color: var(--error);
		background-color: var(--error-tint);
		text-decoration: underline wavy;
		text-decoration-thickness: 1.5px;
	}

	.caret {
		box-shadow: inset 2px 0 0 0 var(--caret);
		animation: caret-blink 1.1s step-end infinite;
	}

	@keyframes caret-blink {
		50% {
			box-shadow: none;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.caret {
			animation: none; /* steady caret instead of blinking */
		}

		.passage {
			animation: none; /* instant swap instead of the settle crossfade */
		}

		.surface {
			transition: none;
		}
	}

	/* Visually hidden but focusable — never display:none. */
	.typing-input {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		border: 0;
		opacity: 0;
	}
</style>
