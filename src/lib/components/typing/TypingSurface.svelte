<script lang="ts">
	import { m } from '$lib/paraglide/messages';
	import type { CharacterState } from '$lib/engine/types';
	import { CHARS_PER_LINE } from '$lib/chunking/measure';
	import { computeTranslateY } from './teleprompter';

	interface Props {
		text: string;
		display: readonly CharacterState[];
		cursor: number;
		/**
		 * Identity of the page being typed (the active chunk index). When it
		 * changes, the character spans re-key and play the ~220ms settle/crossfade
		 * (spec #9) — the input itself stays mounted so focus never drops.
		 */
		passageKey: number;
		onChar: (char: string, timestamp: number) => void;
		onBackspace: (timestamp: number) => void;
		onRestartChunk: () => void;
		/**
		 * The teleprompter viewport's height, in rendered lines (spec #32 §7). Defaults to a
		 * screenful-ish band for the typing screen; the landing hero passes a smaller number
		 * to bound its own height now that its one page carries paragraph breaks and can run
		 * to ~1,600 characters (brief §3.4, R11) — the viewport is a prop rather than a
		 * hardcoded height for exactly that reuse.
		 */
		visibleLines?: number;
	}

	let {
		text,
		display,
		cursor,
		passageKey,
		onChar,
		onBackspace,
		onRestartChunk,
		visibleLines = 10
	}: Props = $props();

	/* Code-point-safe split, mirroring the engine (á, ñ, ¿ occupy one position each). */
	const chars = $derived(Array.from(text));

	let input = $state<HTMLInputElement | null>(null);
	let viewportEl = $state<HTMLDivElement | null>(null);
	let trackEl = $state<HTMLDivElement | null>(null);

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
	 *
	 * Enter (spec #32 §7): the hidden input is `type="text"`, single-line, so a REAL
	 * hardware Enter key never reaches here at all — `handleKeydown`'s `Enter` branch
	 * `preventDefault()`s it before the browser has any default action to turn into a
	 * `beforeinput`. This branch is therefore the MOBILE/IME return-key path: some virtual
	 * keyboards deliver the line break as `insertLineBreak`/`insertParagraph` here without
	 * ever dispatching a `keydown` with `key: 'Enter'`. It used to `preventDefault()` and
	 * drop the break ("chunks never contain newlines"); now it emits `'\n'` instead, since
	 * a page's paragraph breaks are ordinary typed characters. **Unverified on a real iOS
	 * or Android keyboard** — see the Phase 5 report.
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
			event.preventDefault(); // no scroll, no browser default — the input stays empty
			onChar('\n', Date.now());
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
		} else if (event.key === 'Enter') {
			// The real hardware/desktop path (spec #32 §7, acceptance criterion #8): no
			// scroll, no implicit submit, no browser default — and a `\n` is an ordinary
			// character from here on, judged exactly like any other keystroke.
			event.preventDefault();
			onChar('\n', Date.now());
		}
	}

	// ── Teleprompter (spec #32 §7, §11 R7) ─────────────────────────────────────────────
	//
	// Pure math lives in `./teleprompter.ts`; this effect does only the DOM measurement
	// that module deliberately never touches. Display-only, and it can never feed back
	// into `src/lib/chunking/` — see that module's comment for the seam this preserves.

	let translateY = $state(0);

	function measureAndScroll() {
		if (!viewportEl || !trackEl) return;
		const caretEl = trackEl.querySelector<HTMLElement>('.caret');
		if (!caretEl) {
			translateY = 0;
			return;
		}
		const containerHeight = viewportEl.clientHeight;
		const lineHeight = Number.parseFloat(getComputedStyle(trackEl).lineHeight) || 0;
		if (containerHeight <= 0 || lineHeight <= 0) return;
		translateY = computeTranslateY({
			activeLineTop: caretEl.offsetTop,
			lineHeight,
			containerHeight,
			// The middle third of the viewport, matching "held within a middle band" (spec
			// #32 §7) without hardcoding pixel offsets that would drift from the viewport
			// height prop.
			bandTop: containerHeight / 3,
			bandBottom: (containerHeight * 2) / 3
		});
	}

	$effect(() => {
		// Re-measure whenever the cursor moves or the page changes. `display` is read too:
		// a restore or a correction can change which span is `.caret` without moving
		// `cursor` in the same tick from this effect's point of view. `void` rather than a
		// bare reference: a bare expression statement is a lint error, and these three exist
		// only to register as dependencies.
		void cursor;
		void passageKey;
		void display;
		measureAndScroll();
	});
</script>

<!-- A label wrapping the hidden input: clicking anywhere on the sheet natively refocuses it. -->
<label class="surface block w-full cursor-text" data-testid="typing-surface" for="typing-input">
	<div
		class="viewport"
		bind:this={viewportEl}
		style="--visible-lines: {visibleLines}"
		data-testid="typing-viewport"
	>
		<div class="track" bind:this={trackEl} style="transform: translateY({translateY}px)">
			<div class="measure" style="--measure: {CHARS_PER_LINE}ch" data-testid="typing-measure">
				{#key passageKey}
					<span class="passage">
						<!-- The position index IS the identity of a character slot (fixed-length, never reordered). -->
						{#each chars as char, i (i)}
							<span
								class={['char', char === '\n' && 'newline', i === cursor && 'caret']}
								data-state={display[i]}>{char}</span
							>
						{/each}
						<span
							class={['char', 'chunk-end', cursor === chars.length && 'caret']}
							aria-hidden="true"
						>
						</span>
					</span>
				{/key}
			</div>
		</div>
	</div>
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
	 * The sheet (spec #9, brief §2): the page sits on its own surface one step
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
		font-family: var(--reading-font-stack);
		font-size: 18px;
		line-height: 1.85;
		color: var(--fg);
		transition: background-color 0.25s ease;
	}

	@media (min-width: 640px) {
		.surface {
			padding: 34px 38px;
			font-size: 21px;
		}
	}

	/*
	 * The teleprompter viewport (spec #32 §7): a fixed-height, `overflow: hidden` window.
	 * Height is in `em`, so it scales with the surface's own `font-size` breakpoint and
	 * always equals `visibleLines` real rendered lines at `line-height: 1.85` — one
	 * definition, not a px number that would drift from the font-size media query above.
	 */
	.viewport {
		overflow: hidden;
		height: calc(var(--visible-lines) * 1.85em);
	}

	.track {
		transition: transform 0.3s ease;
	}

	/*
	 * The `ch` measure (spec #32 §5, ADR-0015): the SINGLE place `CHARS_PER_LINE` becomes a
	 * CSS value, on an inner, padding-free wrapper — never `.surface`, which carries
	 * horizontal padding and would produce a measure-minus-padding. `white-space: pre-wrap`
	 * lives here too: a `\n` in the character stream breaks the line, and prose wraps
	 * exactly at this width.
	 */
	.measure {
		max-width: var(--measure);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	/* A brief settle as one page crossfades into the next; nothing else moves. */
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

	/*
	 * The newline glyph (spec #32 §7 D2). A bare `\n` renders as a line break with no
	 * visible glyph — a bad home for the caret (an inset box-shadow on a zero-width span is
	 * invisible) and an invisible home for an error (nothing to see, nothing to backspace
	 * toward). `display: inline-block` plus a minimum width hosts the caret; the `↵` glyph
	 * itself is revealed via `::after` ONLY when the position is `incorrect` or holds the
	 * caret — visible exactly when it carries information, invisible the rest of the time
	 * so the page still reads as prose rather than spamming a mark at every paragraph break.
	 * `position: absolute` keeps the glyph from adding its own width to the line box.
	 */
	.char.newline {
		position: relative;
		display: inline-block;
		min-width: 0.5ch;
	}

	.char.newline::after {
		content: '↵';
		position: absolute;
		top: 0;
		left: 0;
		opacity: 0;
		color: var(--dim);
	}

	.char.newline.caret::after {
		opacity: 0.4;
	}

	.char.newline[data-state='incorrect']::after {
		opacity: 0.7;
		color: var(--error);
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

		.track {
			/* The scroll itself still happens (spec #32 §7 R7) — only the smooth
			   interpolation is disabled, so the jump between positions is instant. */
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
