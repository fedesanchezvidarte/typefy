import { page } from 'vitest/browser';
import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { CHARS_PER_LINE } from '$lib/chunking/measure';
import TypingSurface from './TypingSurface.svelte';

/**
 * The `ch` measure (spec #32 §5, ADR-0015), acceptance criterion #9 part 1: "the surface's
 * measure resolves to exactly `CHARS_PER_LINE` `ch` in every reading font" —
 * `computedWidth / widthOf('0') === CHARS_PER_LINE`. Deliberately NOT literal equality of
 * rendered characters-per-line across faces (part 2, and the property the spec's correction
 * explains is false for the proportional faces) — that is Phase 7's fuller coverage. This is
 * the one component test the Feature Brief asks the Phase 5 implementer to add as evidence,
 * not the whole suite.
 *
 * The width of `'0'` is asked of the BROWSER itself via a same-font probe span sized `1ch`,
 * rather than reimplemented with canvas text measurement — `1ch` is defined as that advance
 * width, so this is the most direct way to check "does our `max-width: {N}ch` actually land
 * on the inner, padding-free wrapper and resolve to exactly N," which is the thing that can
 * silently break (a typo landing the measure on `.surface` instead would read as measure
 * MINUS padding, not `N`).
 */
/**
 * The typo is rendered as itself: expecting "Normal" and typing `p` for the `o` shows
 * "Nprmal", not "Normal" with a mark under a character the typist never produced. The wavy
 * underline and the error tint are unchanged — this ADDS a signal rather than replacing one,
 * so the assertions below check the substituted glyph AND that the slot is still `incorrect`.
 */
describe('TypingSurface — incorrect positions show the character actually typed', () => {
	function renderSurface(
		text: string,
		display: readonly ('pending' | 'correct' | 'corrected' | 'incorrect')[],
		typed: readonly (string | null)[]
	) {
		render(TypingSurface, {
			text,
			display,
			typed,
			cursor: typed.filter((t) => t !== null).length,
			passageKey: 0,
			onChar: () => {},
			onBackspace: () => {},
			onRestartChunk: () => {}
		});
		return page.getByTestId('typing-measure').element() as HTMLElement;
	}

	/** The rendered glyphs of the real character slots, excluding the chunk-end caret slot. */
	function rendered(measureEl: HTMLElement, length: number): string {
		return [...measureEl.querySelectorAll<HTMLElement>('.char')]
			.slice(0, length)
			.map((span) => span.textContent)
			.join('');
	}

	it('renders the typo instead of the expected character', () => {
		const measureEl = renderSurface(
			'Normal',
			['correct', 'incorrect', 'pending', 'pending', 'pending', 'pending'],
			['N', 'p', null, null, null, null]
		);
		expect(rendered(measureEl, 6)).toBe('Nprmal');
		const spans = measureEl.querySelectorAll<HTMLElement>('.char');
		expect(spans[1].dataset.state).toBe('incorrect');
	});

	it('keeps the expected character when the typed one has no visible glyph', () => {
		// A space typed for the `o` would render as a blank slot, hiding the error the tint
		// is drawn on — so the expected character stands and the tint alone reports it.
		const measureEl = renderSurface(
			'Normal',
			['correct', 'incorrect', 'pending', 'pending', 'pending', 'pending'],
			['N', ' ', null, null, null, null]
		);
		expect(rendered(measureEl, 6)).toBe('Normal');
	});

	it('never substitutes into a newline slot, so a wrong keystroke cannot reflow the page', () => {
		const measureEl = renderSurface('a\nb', ['correct', 'incorrect', 'pending'], ['a', 'x', null]);
		expect(rendered(measureEl, 3)).toBe('a\nb');
	});

	it('shows the expected text when no typed array is supplied at all', () => {
		const text = 'Normal';
		render(TypingSurface, {
			text,
			display: Array.from(text, () => 'pending' as const),
			cursor: 0,
			passageKey: 0,
			onChar: () => {},
			onBackspace: () => {},
			onRestartChunk: () => {}
		});
		const measureEl = page.getByTestId('typing-measure').element() as HTMLElement;
		expect(rendered(measureEl, 6)).toBe('Normal');
	});
});

describe('TypingSurface — the ch measure', () => {
	it('resolves the measure wrapper to exactly CHARS_PER_LINE ch', async () => {
		// A desktop-width viewport (spec's own out-of-scope list explicitly excludes
		// "mobile-specific layout work beyond what the `ch` measure gives for free" — on a
		// viewport narrower than 66ch, `.measure`'s `width: auto` is capped by the CONTAINER
		// before `max-width` ever binds, which is a real and accepted narrow-viewport
		// consequence, not a break of this contract). The default browser-mode viewport here
		// is a phone width, which is exactly that narrow case, so it is widened for this
		// assertion to test the property the criterion is actually about.
		await page.viewport(1280, 800);

		const text = 'hello world';
		render(TypingSurface, {
			text,
			display: Array.from(text, () => 'pending' as const),
			cursor: 0,
			passageKey: 0,
			onChar: () => {},
			onBackspace: () => {},
			onRestartChunk: () => {}
		});

		const measureEl = page.getByTestId('typing-measure').element() as HTMLElement;
		const computed = getComputedStyle(measureEl);
		const measuredWidth = measureEl.getBoundingClientRect().width;

		const probe = document.createElement('span');
		probe.style.position = 'absolute';
		probe.style.visibility = 'hidden';
		probe.style.whiteSpace = 'nowrap';
		probe.style.fontFamily = computed.fontFamily;
		probe.style.fontSize = computed.fontSize;
		probe.style.width = '1ch';
		document.body.appendChild(probe);
		const oneCh = probe.getBoundingClientRect().width;
		probe.remove();

		expect(oneCh).toBeGreaterThan(0);
		// A tolerance of half a character absorbs sub-pixel layout rounding without hiding a
		// real drift (a stray unit, or the measure landing on the wrong element).
		expect(measuredWidth / oneCh).toBeGreaterThan(CHARS_PER_LINE - 0.5);
		expect(measuredWidth / oneCh).toBeLessThan(CHARS_PER_LINE + 0.5);
	});

	/**
	 * The rest of acceptance criterion #9 (spec #32, corrected per the Feature Brief's
	 * conflict-flag on the "why it is not optional" section): the measure resolves to exactly
	 * `CHARS_PER_LINE` `ch` in EVERY reading font, not only the default Roboto the test above
	 * exercises — and separately, rendered characters-per-line is never BELOW `CHARS_PER_LINE`
	 * in any of them. The two are deliberately not the same assertion: this one is what makes
	 * the 24-line budget safe, and it is asserted as a floor, not an equality, because the
	 * proportional faces are expected to fit MORE than 66 (ADR-0015's corrected rationale).
	 */
	describe('across all three reading fonts (ADR-0015)', () => {
		/** `:root[data-font]` is what `layout.css` keys `--reading-font-stack` off of. */
		function setReadingFont(font: 'sans' | 'serif' | 'mono') {
			document.documentElement.dataset.font = font;
		}

		afterEach(() => {
			delete document.documentElement.dataset.font;
		});

		/** Long enough to wrap several times at 66ch in every one of the three faces. */
		const prose = 'the quick brown fox jumps over the lazy dog and then trots back again '.repeat(
			6
		);

		for (const font of ['sans', 'serif', 'mono'] as const) {
			it(`resolves to exactly CHARS_PER_LINE ch, and fits at least CHARS_PER_LINE characters on its first rendered line — ${font}`, async () => {
				await page.viewport(1280, 800);
				setReadingFont(font);

				render(TypingSurface, {
					text: prose,
					display: Array.from(prose, () => 'pending' as const),
					cursor: 0,
					passageKey: 0,
					onChar: () => {},
					onBackspace: () => {},
					onRestartChunk: () => {}
				});

				const measureEl = page.getByTestId('typing-measure').element() as HTMLElement;
				const computed = getComputedStyle(measureEl);
				const measuredWidth = measureEl.getBoundingClientRect().width;

				const probe = document.createElement('span');
				probe.style.position = 'absolute';
				probe.style.visibility = 'hidden';
				probe.style.whiteSpace = 'nowrap';
				probe.style.fontFamily = computed.fontFamily;
				probe.style.fontSize = computed.fontSize;
				probe.style.width = '1ch';
				document.body.appendChild(probe);
				const oneCh = probe.getBoundingClientRect().width;
				probe.remove();

				// Part 1 — the contract: the measure itself is CHARS_PER_LINE ch, in THIS face.
				expect(measuredWidth / oneCh).toBeGreaterThan(CHARS_PER_LINE - 0.5);
				expect(measuredWidth / oneCh).toBeLessThan(CHARS_PER_LINE + 0.5);

				// Part 2 — the property that makes the line budget safe: count how many
				// characters actually land on the FIRST rendered line, by their offsetTop
				// against the first character's. A face fitting fewer than CHARS_PER_LINE here
				// would mean a page estimated at MAX_LINES really renders taller — the one
				// direction the estimate must never be wrong in.
				const spans = measureEl.querySelectorAll<HTMLElement>('.char');
				expect(spans.length).toBeGreaterThan(CHARS_PER_LINE); // the fixture must wrap at all
				const firstTop = spans[0].offsetTop;
				let firstLineCount = 0;
				for (const span of spans) {
					if (span.offsetTop !== firstTop) break;
					firstLineCount += 1;
				}
				expect(
					firstLineCount,
					`${font} fit only ${firstLineCount} chars on its first line, below CHARS_PER_LINE (${CHARS_PER_LINE})`
				).toBeGreaterThanOrEqual(CHARS_PER_LINE);
			});
		}
	});
});
