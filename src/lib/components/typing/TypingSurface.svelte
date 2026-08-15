<script lang="ts">
	import { m } from '$lib/paraglide/messages';
	import type { CharacterState } from '$lib/engine/types';
	import { CHARS_PER_LINE } from '$lib/chunking/measure';
	import { computeTranslateY, LOOKAHEAD_LINES } from './teleprompter';

	interface Props {
		text: string;
		display: readonly CharacterState[];
		/**
		 * What the typist actually produced at each position (engine `typed`). Drives the
		 * substitution below: a wrong keystroke shows the wrong character, not the expected one
		 * with a mark under it. Optional so callers that only render pending text can omit it.
		 */
		typed?: readonly (string | null)[];
		cursor: number;
		/**
		 * Identity of the page being typed (the active chunk index). When it
		 * changes, the character spans re-key and play the ~220ms settle/crossfade
		 * (spec #9) — the input itself stays mounted so focus never drops.
		 */
		passageKey: number;
		onChar: (char: string, timestamp: number) => void;
		onBackspace: (timestamp: number) => void;
		/**
		 * How the surface is sized and set (spec #45).
		 *
		 * - `page` — the typing screen. The card is **pinned**: it fills the height its parent
		 *   gives it, the text scrolls inside it, and the type is set denser (17px / 1.6) so
		 *   most of a page is on screen at once.
		 * - `hero` — the landing page. Keeps its own larger display type and a fixed
		 *   `visibleLines` band, because a hero should be big and a page should be dense.
		 *
		 * Both render identically in every other respect — one caret, one input, one character
		 * state model — which is the whole reason this is a variant rather than a second
		 * component.
		 */
		variant?: 'page' | 'hero';
		/**
		 * The viewport's height in rendered lines. **`hero` only** — under `page` the viewport
		 * takes the height its container has, which is what makes the card fill the screen at
		 * any font size the future size setting picks.
		 */
		visibleLines?: number;
	}

	let {
		text,
		display,
		typed = [],
		cursor,
		passageKey,
		onChar,
		onBackspace,
		variant = 'page',
		visibleLines = 5
	}: Props = $props();

	/* Code-point-safe split, mirroring the engine (á, ñ, ¿ occupy one position each). */
	const chars = $derived(Array.from(text));

	/**
	 * The page's **paragraph blocks** (spec #45), and the one structural rule that governs them:
	 * **position indices stay global.** A block carries the index its first character has in the
	 * whole page, and every slot renders at `start + offset` — so the engine, the caret, the
	 * character states and `measured_chars` see exactly the stream they saw when the page was
	 * one span. The split is presentational and nothing downstream may learn about it.
	 *
	 * A `\n` **terminates** the block it ends rather than starting the next one, so its slot
	 * still exists, still holds the caret and still shows the incorrect tint. The line break
	 * itself now comes from the block boundary; see `shownChar`, which renders that slot as
	 * empty precisely so `white-space: pre-wrap` does not emit a SECOND break for the same
	 * character.
	 *
	 * The final block is pushed unconditionally, even when the page ends on a `\n` and it is
	 * therefore empty: it is where the end-of-page caret slot lives.
	 */
	const paragraphs = $derived.by(() => {
		const blocks: { start: number; length: number }[] = [];
		let start = 0;
		for (let i = 0; i < chars.length; i++) {
			if (chars[i] === '\n') {
				blocks.push({ start, length: i - start + 1 });
				start = i + 1;
			}
		}
		blocks.push({ start, length: chars.length - start });
		return blocks;
	});

	/*
	 * What a slot SHOWS, which is not always what it expects: on an incorrect position the
	 * surface renders the character the typist actually produced ("Nprmal", not "Normal" with a
	 * mark under the `o`), so the mistake is legible as itself. The wavy underline and the error
	 * tint stay — the substitution adds a signal, it does not replace one.
	 *
	 * Two positions are deliberately NOT substituted, because in both the substitution would
	 * destroy more information than it adds:
	 *
	 * - a typed character with no visible glyph (space, tab, newline) would render as a blank
	 *   slot, hiding the error the tint is drawn on;
	 * - a slot whose EXPECTED character is `\n` must keep breaking the line, or every wrong
	 *   keystroke at a paragraph break would reflow the page under the typist's eyes.
	 *
	 * In both cases the tint alone reports the error, which is exactly the pre-existing
	 * behaviour.
	 *
	 * A `\n` slot renders as the EMPTY string rather than as the character itself (spec #45):
	 * since paragraphs became blocks, the break comes from the block boundary, and emitting the
	 * newline under `white-space: pre-wrap` as well would break the line twice.
	 */
	function shownChar(index: number): string {
		const expected = chars[index];
		if (expected === '\n') {
			return '';
		}
		if (display[index] !== 'incorrect') {
			return expected;
		}
		const attempt = typed[index];
		if (!attempt || /\s/.test(attempt)) {
			return expected;
		}
		return attempt;
	}

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

	/*
	 * Control keys only — never text (dead keys arrive as 'Dead' here and are useless).
	 *
	 * `Escape` used to restart the page here. Spec #45 removed restarting a page as an action
	 * entirely — there is no button and no shortcut, and a page is un-typed by backspacing like
	 * any other text. Deliberately not left as an undocumented shortcut: a behaviour no UI
	 * announces is one only its author can find.
	 */
	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Backspace') {
			event.preventDefault();
			onBackspace(Date.now());
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
			// `page` (spec #45): the band is the whole card bar a bottom margin of
			// `LOOKAHEAD_LINES`, so the page is still until the caret nears the bottom edge.
			// `hero` keeps spec #32's middle third — in a five-line band a bottom-margin band
			// would leave almost no room above the caret.
			bandTop: variant === 'page' ? 0 : containerHeight / 3,
			bandBottom:
				variant === 'page'
					? containerHeight - LOOKAHEAD_LINES * lineHeight
					: (containerHeight * 2) / 3
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
<label
	class={['surface', variant, 'w-full', 'cursor-text']}
	data-testid="typing-surface"
	for="typing-input"
>
	<div
		class="viewport"
		bind:this={viewportEl}
		style="--visible-lines: {visibleLines}"
		data-testid="typing-viewport"
	>
		<div class="track" bind:this={trackEl} style="transform: translateY({translateY}px)">
			<div class="measure" style="--measure: {CHARS_PER_LINE}ch" data-testid="typing-measure">
				{#key passageKey}
					<div class="passage">
						<!-- One block per paragraph, separated by a real blank line (spec #45). The
						     index rendered is ALWAYS `block.start + offset` — the character's position
						     in the whole page — never the offset within the block. -->
						{#each paragraphs as block, p (p)}
							<p class="para">
								<!-- The position index IS the identity of a character slot (fixed-length, never reordered). -->
								{#each { length: block.length }, offset (offset)}
									{@const i = block.start + offset}
									<span
										class={['char', chars[i] === '\n' && 'newline', i === cursor && 'caret']}
										data-state={display[i]}>{shownChar(i)}</span
									>
								{/each}
								{#if p === paragraphs.length - 1}
									<span
										class={['char', 'chunk-end', cursor === chars.length && 'caret']}
										aria-hidden="true"
									>
									</span>
								{/if}
							</p>
						{/each}
					</div>
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
		display: block;
		background: var(--sheet);
		border: 1px solid var(--border);
		border-radius: 12px;
		font-family: var(--reading-font-stack);
		line-height: var(--lh);
		color: var(--fg);
		transition: background-color 0.25s ease;
	}

	/*
	 * The `hero` variant: spec #32's sheet, unchanged — its own display type, its own
	 * `line-height`, and a fixed `visibleLines` band.
	 */
	.surface.hero {
		--lh: 1.85;
		max-width: 720px;
		padding: 24px 26px;
		font-size: 18px;
	}

	/*
	 * The `page` variant (spec #45): a book page, not a box drawn round a text column.
	 *
	 * It is **pinned** — `height: 100%` of whatever the typing screen gives it, with the
	 * viewport as the flex child that absorbs the remainder — so the card never changes height
	 * mid-session and the text scrolls inside it rather than the document scrolling under it.
	 *
	 * Wider than the measure ON PURPOSE. The 66ch column (ADR-0015) may not widen — it is the
	 * chunking contract — so the card grows through margins instead, which is also what a real
	 * page does. `.measure` is centred inside the padding by `margin-inline: auto`.
	 *
	 * 17px / 1.6 is denser than the hero's 21px / 1.85 for one reason: at ~635px of text
	 * height it puts ~23 rendered lines on screen, so a 24-line page is very nearly whole
	 * before its paragraph gaps.
	 */
	.surface.page {
		--lh: 1.6;
		display: flex;
		flex-direction: column;
		height: 100%;
		max-width: 860px;
		padding: 28px 20px;
		font-size: 17px;
	}

	@media (min-width: 640px) {
		.surface.hero {
			padding: 34px 38px;
			font-size: 21px;
		}

		.surface.page {
			padding: 44px 56px;
		}
	}

	/*
	 * The teleprompter viewport (spec #32 §7, spec #45): an `overflow: hidden` window onto the
	 * track.
	 *
	 * `hero` sizes it in `em` so it always equals `visibleLines` real rendered lines whatever
	 * the font-size breakpoint says. `page` takes the height its pinned card has left over —
	 * `min-height: 0` because a flex child's default `min-height: auto` would let the track's
	 * full height push the card past the viewport and reintroduce document scrolling.
	 */
	.viewport {
		overflow: hidden;
		height: calc(var(--visible-lines) * var(--lh) * 1em);
	}

	.surface.page .viewport {
		flex: 1;
		min-height: 0;
		height: auto;
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
		margin-inline: auto;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	/* A brief settle as one page crossfades into the next; nothing else moves. */
	.passage {
		animation: settle 0.22s ease;
	}

	/*
	 * One paragraph of the page (spec #45). The blank line between paragraphs is exactly one
	 * rendered line — `--lh` in `em` rather than the `1lh` unit, so it holds on the browsers
	 * the E2E suite and the catalog's readers actually run.
	 *
	 * This gap is **display-only**. It makes a page render taller than `MAX_LINES` estimates,
	 * which is fine and expected: the line budget is an input to chunking, never a promise
	 * about rendering, and nothing here may feed back into `src/lib/chunking/` (ADR-0005,
	 * ADR-0015).
	 */
	.para {
		margin: 0;
	}

	.para + .para {
		margin-top: calc(var(--lh) * 1em);
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
