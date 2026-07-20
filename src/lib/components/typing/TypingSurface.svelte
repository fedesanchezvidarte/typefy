<script lang="ts">
	import { m } from '$lib/paraglide/messages';
	import type { CharacterState } from '$lib/engine/types';

	interface Props {
		text: string;
		display: readonly CharacterState[];
		cursor: number;
		onChar: (char: string, timestamp: number) => void;
		onBackspace: (timestamp: number) => void;
		onRestartChunk: () => void;
	}

	let { text, display, cursor, onChar, onBackspace, onRestartChunk }: Props = $props();

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

<!-- A label wrapping the hidden input: clicking anywhere on the surface natively refocuses it. -->
<label
	class="surface block w-full max-w-3xl cursor-text rounded-lg border border-zinc-300 p-6 font-mono text-xl leading-relaxed focus-within:border-zinc-900 focus-within:ring-2 focus-within:ring-zinc-900/20"
	data-testid="typing-surface"
	for="typing-input"
>
	<!-- The position index IS the identity of a character slot (fixed-length, never reordered). -->
	{#each chars as char, i (i)}
		<span class={['char', i === cursor && 'caret']} data-state={display[i]}>{char}</span>
	{/each}
	<span class={['char', 'chunk-end', cursor === chars.length && 'caret']} aria-hidden="true">
	</span>
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
	 * Engine-surface rendering lives in scoped CSS (ADR-0008); colors come from the
	 * shared character-state tokens defined in the app theme (layout.css).
	 * Color is never the only signal: incorrect also gets an underline and a
	 * background tint (visible even on spaces).
	 * `corrected` deliberately renders the same as `correct`: only *current*
	 * mistakes are highlighted, so a fixed error carries no lasting mark. The
	 * engine still tracks the state (accuracy, completion, future features).
	 */
	.surface {
		position: relative;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.char {
		border-radius: 0.125rem;
	}

	.char[data-state='pending'] {
		color: var(--color-char-pending);
	}

	.char[data-state='correct'],
	.char[data-state='corrected'] {
		color: var(--color-char-correct);
	}

	.char[data-state='incorrect'] {
		color: var(--color-char-incorrect);
		background-color: var(--color-char-incorrect-bg);
		text-decoration: underline wavy;
		text-decoration-thickness: 1.5px;
	}

	.caret {
		box-shadow: inset 2px 0 0 0 var(--color-caret);
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
