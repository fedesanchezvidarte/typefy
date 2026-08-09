import { describe, expect, it } from 'vitest';
import { computeTranslateY } from './teleprompter';

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
