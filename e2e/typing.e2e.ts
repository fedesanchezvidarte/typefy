import { expect, test, type Page } from '@playwright/test';
// Fixture contents are imported (not duplicated) so the tests always type the
// exact strings the app renders. Their only dependency is a type-only import,
// which Playwright's transpiler erases.
import { prideAndPrejudiceExcerpt } from '../src/lib/fixtures/en';
import { donQuijoteExcerpt } from '../src/lib/fixtures/es';

const EN_ID = prideAndPrejudiceExcerpt.id;
const ES_ID = donQuijoteExcerpt.id;
const EN_CHUNK_0 = prideAndPrejudiceExcerpt.chunks[0].content;
const ES_CHUNK_0 = donQuijoteExcerpt.chunks[0].content;

/** Character spans of the active chunk (the trailing `.chunk-end` sentinel is last). */
function chars(page: Page) {
	return page.locator('[data-testid="typing-surface"] .char');
}

/** Real typing through the OS-level keyboard path; no artificial per-key delay. */
async function type(page: Page, text: string) {
	await page.keyboard.type(text, { delay: 0 });
}

/**
 * Opens /type (or a locale-prefixed variant) and picks a text. The click only
 * registers once the page has hydrated, so it is retried (same pattern as
 * smoke.e2e.ts). Resolves with the hidden input focused and ready to type.
 */
async function pickText(page: Page, textId: string, path = '/type') {
	await page.goto(path);
	await expect(page.getByTestId('text-picker')).toBeVisible();
	await expect(async () => {
		await page.getByTestId(`text-picker-option-${textId}`).click();
		await expect(page.getByTestId('typing-surface')).toBeVisible({ timeout: 2000 });
	}).toPass();
	await expect(page.getByTestId('typing-input')).toBeFocused();
}

test.describe('text picker', () => {
	test('renders both fixtures; choosing one shows the surface with focus ready', async ({
		page
	}) => {
		await page.goto('/type');
		await expect(page.getByTestId('text-picker')).toBeVisible();
		await expect(page.getByTestId(`text-picker-option-${EN_ID}`)).toBeVisible();
		await expect(page.getByTestId(`text-picker-option-${ES_ID}`)).toBeVisible();

		await pickText(page, EN_ID);
		await expect(page.getByTestId('typing-surface')).toBeVisible();
		await expect(page.getByTestId('metrics-bar')).toBeVisible();
		await expect(page.getByTestId('chunk-progress')).toHaveText('Chunk 1 of 6');
		await expect(page.getByTestId('typing-input')).toBeFocused();
	});

	test('picker options are reachable keyboard-only (Tab, then Enter starts typing)', async ({
		page
	}) => {
		await page.goto('/type');
		await expect(page.getByTestId('text-picker')).toBeVisible();

		// Tab from page load until focus lands on a picker option (bounded walk
		// so a new header control cannot make this loop forever).
		let reached = false;
		for (let i = 0; i < 10 && !reached; i++) {
			await page.keyboard.press('Tab');
			const focusedTestId = await page.evaluate(
				() => document.activeElement?.getAttribute('data-testid') ?? ''
			);
			reached = focusedTestId.startsWith('text-picker-option-');
		}
		expect(reached, 'Tab should reach a text-picker option within 10 stops').toBe(true);

		// Enter activates the focused option once hydrated (retried like clicks).
		await expect(async () => {
			await page.keyboard.press('Enter');
			await expect(page.getByTestId('typing-surface')).toBeVisible({ timeout: 2000 });
		}).toPass();
		await expect(page.getByTestId('typing-input')).toBeFocused();
	});
});

test.describe('character states (spec criterion path)', () => {
	test('correct → incorrect → backspace → corrected; first-attempt-correct survives retype', async ({
		page
	}) => {
		// EN chunk 0 starts "It is a truth..." — positions 0..2 are 'I', 't', ' '.
		await pickText(page, EN_ID);

		// Correct characters go green.
		await type(page, 'It');
		await expect(chars(page).nth(0)).toHaveAttribute('data-state', 'correct');
		await expect(chars(page).nth(1)).toHaveAttribute('data-state', 'correct');

		// A wrong character shows red; the cursor still advances (free typing).
		await type(page, 'x'); // expected ' '
		await expect(chars(page).nth(2)).toHaveAttribute('data-state', 'incorrect');
		await expect(chars(page).nth(3)).toHaveClass(/caret/);

		// Backspace returns the position to pending.
		await page.keyboard.press('Backspace');
		await expect(chars(page).nth(2)).toHaveAttribute('data-state', 'pending');
		await expect(chars(page).nth(2)).toHaveClass(/caret/);

		// Retyping correctly marks the state 'corrected' — never plain 'correct'
		// again (engine state; visually it renders the same as 'correct').
		await type(page, ' ');
		await expect(chars(page).nth(2)).toHaveAttribute('data-state', 'corrected');

		// Backspacing over a first-attempt-correct character and retyping it
		// correctly keeps it 'correct'; the ever-incorrect one stays 'corrected'.
		await page.keyboard.press('Backspace');
		await page.keyboard.press('Backspace');
		await expect(chars(page).nth(1)).toHaveAttribute('data-state', 'pending');
		await type(page, 't ');
		await expect(chars(page).nth(1)).toHaveAttribute('data-state', 'correct');
		await expect(chars(page).nth(2)).toHaveAttribute('data-state', 'corrected');
	});
});

test.describe('live metrics', () => {
	test('em-dash placeholders until the first word boundary, then numbers; corrected char caps accuracy below 100%', async ({
		page
	}) => {
		await pickText(page, EN_ID);
		const wpm = page.getByTestId('metrics-wpm');
		const accuracy = page.getByTestId('metrics-accuracy');

		await expect(wpm).toHaveText('—');
		await expect(accuracy).toHaveText('—');

		// Mistype inside the first word, fix it — still before any word boundary.
		await type(page, 'Ix'); // 'x' wrong for 't'
		await page.keyboard.press('Backspace');
		await type(page, 't');
		await expect(chars(page).nth(1)).toHaveAttribute('data-state', 'corrected');
		await expect(wpm).toHaveText('—');
		await expect(accuracy).toHaveText('—');

		// The space (word boundary) flips both to numbers; the corrected
		// character counts as a miss, so accuracy is numeric but below 100%.
		await type(page, ' ');
		await expect(wpm).toHaveText(/^\d+$/);
		await expect(accuracy).toHaveText(/^\d+\.\d%$/);
		await expect(accuracy).not.toHaveText('100.0%');
	});
});

test.describe('chunk completion', () => {
	test('an unfixed error blocks completion; fixing it completes and auto-advances', async ({
		page
	}) => {
		test.setTimeout(60_000);
		// Plant the error at the start of the final word so recovery is short.
		const lastWord = 'daughters.';
		const errorIndex = EN_CHUNK_0.lastIndexOf(lastWord);
		expect(errorIndex).toBeGreaterThan(0);

		await pickText(page, EN_ID);
		await type(page, EN_CHUNK_0.slice(0, errorIndex));
		await type(page, 'X'); // wrong for 'd'
		await expect(chars(page).nth(errorIndex)).toHaveAttribute('data-state', 'incorrect');
		await type(page, EN_CHUNK_0.slice(errorIndex + 1));

		// Every position is judged but one is incorrect: the chunk must not advance.
		await expect(page.getByTestId('chunk-progress')).toHaveText('Chunk 1 of 6');

		// Typing past the end is a no-op: the cursor stays parked on the end sentinel.
		await type(page, 'z');
		await expect(page.getByTestId('chunk-progress')).toHaveText('Chunk 1 of 6');
		await expect(page.locator('[data-testid="typing-surface"] .chunk-end')).toHaveClass(/caret/);

		// Backspace to the error, then retype the last word: completion is
		// instant and the session auto-advances to chunk 2.
		for (let i = 0; i < lastWord.length; i++) {
			await page.keyboard.press('Backspace');
		}
		await expect(chars(page).nth(errorIndex)).toHaveAttribute('data-state', 'pending');
		await type(page, lastWord);
		await expect(page.getByTestId('chunk-progress')).toHaveText('Chunk 2 of 6');

		// The completed chunk's frozen figures appear, with the corrected
		// character counted as a miss (accuracy below 100%).
		const lastChunk = page.getByTestId('metrics-last-chunk');
		await expect(lastChunk).toBeVisible();
		await expect(lastChunk).toContainText(/\d+\.\d%/);
		await expect(lastChunk).not.toContainText('100.0%');
	});
});

test.describe('restart controls', () => {
	test('Escape restarts the chunk: all states reset and typing starts clean', async ({ page }) => {
		await pickText(page, EN_ID);
		await type(page, 'Ix is'); // one error, four correct-ish positions

		await page.keyboard.press('Escape');
		for (let i = 0; i < 5; i++) {
			await expect(chars(page).nth(i)).toHaveAttribute('data-state', 'pending');
		}
		await expect(chars(page).nth(0)).toHaveClass(/caret/);
		await expect(page.getByTestId('chunk-progress')).toHaveText('Chunk 1 of 6');

		// The reset attempt is discarded: a fresh correct keystroke is plain correct.
		await type(page, 'I');
		await expect(chars(page).nth(0)).toHaveAttribute('data-state', 'correct');
	});

	test('the restart-session button resets states and metrics and refocuses the input', async ({
		page
	}) => {
		await pickText(page, EN_ID);
		await type(page, 'It is '); // crosses a word boundary → numeric metrics
		await expect(page.getByTestId('metrics-wpm')).toHaveText(/^\d+$/);

		await page.getByTestId('restart-session').click();
		await expect(chars(page).nth(0)).toHaveAttribute('data-state', 'pending');
		await expect(page.getByTestId('metrics-wpm')).toHaveText('—');
		await expect(page.getByTestId('metrics-accuracy')).toHaveText('—');
		await expect(page.getByTestId('chunk-progress')).toHaveText('Chunk 1 of 6');

		// Button-triggered restarts must not strand focus on the button.
		await expect(page.getByTestId('typing-input')).toBeFocused();
		await type(page, 'I');
		await expect(chars(page).nth(0)).toHaveAttribute('data-state', 'correct');
	});
});

test.describe('Spanish characters', () => {
	test('á judged exactly: plain "a" is incorrect, the accented char corrects it; í and ñ typed correctly are correct', async ({
		page
	}) => {
		// Positions are derived from the fixture, not hardcoded. In this chunk the
		// first í ("vivía") precedes the first á ("más"), which precedes the first
		// ñ ("añadidura") — assert that ordering so a fixture edit fails loudly.
		const iIndex = ES_CHUNK_0.indexOf('í');
		const aIndex = ES_CHUNK_0.indexOf('á');
		const nIndex = ES_CHUNK_0.indexOf('ñ');
		expect(iIndex).toBeGreaterThan(-1);
		expect(aIndex).toBeGreaterThan(iIndex);
		expect(nIndex).toBeGreaterThan(aIndex);

		await pickText(page, ES_ID);

		// Typing up to (and past) í delivers the precomposed character: correct.
		await type(page, ES_CHUNK_0.slice(0, aIndex));
		await expect(chars(page).nth(iIndex)).toHaveAttribute('data-state', 'correct');

		// Plain 'a' where 'á' is expected is a miss (exact characters required).
		await type(page, 'a');
		await expect(chars(page).nth(aIndex)).toHaveAttribute('data-state', 'incorrect');
		await page.keyboard.press('Backspace');
		await type(page, ES_CHUNK_0[aIndex]); // 'á'
		await expect(chars(page).nth(aIndex)).toHaveAttribute('data-state', 'corrected');

		// Continue through ñ typed correctly.
		await type(page, ES_CHUNK_0.slice(aIndex + 1, nIndex + 1));
		await expect(chars(page).nth(nIndex)).toHaveAttribute('data-state', 'correct');
	});

	/*
	 * Honest limitation: true OS-level dead-key composition (e.g. pressing `´`
	 * then `a` on a Spanish layout) cannot be reproduced in headless Playwright —
	 * composition happens in the OS/IME layer, below the browser. What the app
	 * actually consumes is the single composed character delivered through the
	 * beforeinput/input path (ADR-0004 as amended). CDP `Input.insertText`
	 * exercises exactly that delivery path without synthetic key events, so the
	 * composed-character handling is covered; the OS composition itself is not.
	 */
	test('a composed "á" delivered via CDP Input.insertText is judged correct (chromium-only)', async ({
		page,
		browserName
	}) => {
		test.skip(browserName !== 'chromium', 'CDP sessions are chromium-only');

		const aIndex = ES_CHUNK_0.indexOf('á');
		await pickText(page, ES_ID);
		await type(page, ES_CHUNK_0.slice(0, aIndex));

		const cdp = await page.context().newCDPSession(page);
		await cdp.send('Input.insertText', { text: ES_CHUNK_0[aIndex] });

		await expect(chars(page).nth(aIndex)).toHaveAttribute('data-state', 'correct');
		await expect(chars(page).nth(aIndex + 1)).toHaveClass(/caret/);
	});
});

test.describe('full session (ES text, 5 chunks)', () => {
	test('typing every chunk correctly auto-advances through the session into the summary', async ({
		page
	}) => {
		// ~2.6k real keystrokes across 5 chunks: give the test room to breathe.
		test.setTimeout(240_000);

		await pickText(page, ES_ID);
		for (const [index, chunk] of donQuijoteExcerpt.chunks.entries()) {
			await expect(page.getByTestId('chunk-progress')).toHaveText(`Chunk ${index + 1} of 5`);
			await type(page, chunk.content);
		}

		// The summary appears and receives focus (the surface unmounted).
		const summary = page.getByTestId('session-summary');
		await expect(summary).toBeVisible();
		await expect(summary).toBeFocused();

		// Aggregates: 5 chunks, flawless run → 100.0%, plausible WPM and mm:ss time.
		await expect(page.getByTestId('summary-chunks')).toHaveText('5');
		await expect(page.getByTestId('summary-accuracy')).toHaveText('100.0%');
		await expect(page.getByTestId('summary-wpm')).toHaveText(/^[1-9]\d*$/);
		await expect(page.getByTestId('summary-time')).toHaveText(/^\d{2}:\d{2}$/);
		await expect(page.getByTestId('summary-time')).not.toHaveText('00:00');

		// Restarting from the summary returns to a clean chunk 1, ready to type.
		await page.getByTestId('summary-restart-session').click();
		await expect(page.getByTestId('chunk-progress')).toHaveText('Chunk 1 of 5');
		await expect(chars(page).nth(0)).toHaveAttribute('data-state', 'pending');
		await expect(page.getByTestId('typing-input')).toBeFocused();
	});
});

test.describe('UI locale vs content language', () => {
	test('the EN text is typeable from the Spanish UI at /es/type', async ({ page }) => {
		await pickText(page, EN_ID, '/es/type');
		// Spanish UI chrome around English content: locale and text are independent.
		await expect(page.getByTestId('chunk-progress')).toHaveText('Fragmento 1 de 6');
		await type(page, 'It is');
		await expect(chars(page).nth(0)).toHaveAttribute('data-state', 'correct');
		await expect(chars(page).nth(4)).toHaveAttribute('data-state', 'correct');
	});
});
