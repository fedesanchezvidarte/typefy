import { describe, expect, it } from 'vitest';
import { computeTranslateY, LOOKAHEAD_LINES } from './teleprompter';

/**
 * Pure math only (spec #32 §7, §11 R7) — see the module comment for why no DOM appears here.
 */
describe('computeTranslateY', () => {
	it('does not scroll while the line already sits inside the band', () => {
		const translateY = computeTranslateY({
			activeLineTop: 120,
			lineHeight: 30,
			containerHeight: 300,
			bandTop: 100,
			bandBottom: 200
		});
		expect(translateY).toBe(0);
	});

	it('pins the line to the band bottom once it would render past it', () => {
		const translateY = computeTranslateY({
			activeLineTop: 250,
			lineHeight: 30,
			containerHeight: 300,
			bandTop: 100,
			bandBottom: 200
		});
		// lineBottom (280) - bandBottom (200) = -80, i.e. shift the track up by 80.
		expect(translateY).toBe(-80);
		// The line now renders exactly at the band's bottom edge.
		expect(250 + translateY + 30).toBe(200);
	});

	it('pins the line to the band top when it sits above it, never shifting down', () => {
		const translateY = computeTranslateY({
			activeLineTop: 20,
			lineHeight: 30,
			containerHeight: 300,
			bandTop: 100,
			bandBottom: 200
		});
		// bandTop (100) - activeLineTop (20) would be +80, a downward shift — clamped to 0.
		expect(translateY).toBe(0);
	});

	it('clamps a band that runs past the container height', () => {
		const translateY = computeTranslateY({
			activeLineTop: 400,
			lineHeight: 30,
			containerHeight: 300,
			bandTop: 250,
			bandBottom: 500 // past containerHeight — must be clamped to 300
		});
		expect(translateY).toBe(300 - (400 + 30));
	});
});

/**
 * The typing screen's band since spec #45: the whole card, less a bottom margin of
 * `LOOKAHEAD_LINES`. These are the same three cases above, parameterised the way
 * `TypingSurface` actually calls the function under `variant: 'page'` — the band moved, the
 * math did not.
 */
describe('computeTranslateY — the page band (bottom margin, spec #45)', () => {
	const lineHeight = 30;
	const containerHeight = 600; // 20 rendered lines
	const band = {
		bandTop: 0,
		bandBottom: containerHeight - LOOKAHEAD_LINES * lineHeight // 510 → 17 lines
	};

	it('holds the page completely still while the caret is above the lookahead margin', () => {
		// Every line from the very first to the last one wholly inside the band.
		for (let line = 0; line < 17; line++) {
			expect(
				computeTranslateY({
					activeLineTop: line * lineHeight,
					lineHeight,
					containerHeight,
					...band
				})
			).toBe(0);
		}
	});

	it('follows one line at a time once the caret reaches the margin', () => {
		expect(
			computeTranslateY({ activeLineTop: 17 * lineHeight, lineHeight, containerHeight, ...band })
		).toBe(-lineHeight);
		expect(
			computeTranslateY({ activeLineTop: 18 * lineHeight, lineHeight, containerHeight, ...band })
		).toBe(-2 * lineHeight);
	});

	it('always leaves LOOKAHEAD_LINES of text visible below the caret', () => {
		const activeLineTop = 40 * lineHeight; // deep into a long page
		const translateY = computeTranslateY({ activeLineTop, lineHeight, containerHeight, ...band });
		const renderedBottom = activeLineTop + lineHeight + translateY;
		expect(containerHeight - renderedBottom).toBe(LOOKAHEAD_LINES * lineHeight);
	});

	it('never scrolls back down past where the text naturally sits, after backspacing up', () => {
		expect(computeTranslateY({ activeLineTop: 0, lineHeight, containerHeight, ...band })).toBe(0);
	});
});
