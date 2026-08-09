import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
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
});
