import { isFontId, type FontId } from './fonts';
import { isPaletteId, type PaletteId } from './palettes';

/**
 * Theme persistence contract (spec #9): two cookies, one per axis. The server
 * (hooks.server.ts) reads them to stamp `data-palette` / `data-font` on <html>
 * before paint (no FOUC); the client switchers write them and update the
 * dataset directly — no server round-trip, no page reload.
 *
 * No cookie means "no explicit choice": the <html> attribute is omitted and
 * CSS `prefers-color-scheme` picks warm-light or soft-dark.
 */

export const PALETTE_COOKIE = 'typefy-palette';
export const FONT_COOKIE = 'typefy-font';

/** One year — a preference, not a session. */
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export function parsePalette(value: string | undefined | null): PaletteId | null {
	return isPaletteId(value) ? value : null;
}

export function parseFont(value: string | undefined | null): FontId | null {
	return isFontId(value) ? value : null;
}

/**
 * The exact attribute string injected into app.html's `%typefy.theme%`
 * placeholder. Values are validated ids from the closed sets above, so the
 * interpolation cannot break out of the attribute.
 */
export function themeHtmlAttributes(palette: PaletteId | null, font: FontId | null): string {
	let attributes = '';
	if (palette) {
		attributes += ` data-palette="${palette}"`;
	}
	if (font) {
		attributes += ` data-font="${font}"`;
	}
	return attributes;
}

/** Client-side cookie write for a theme axis (SameSite=Lax, path=/). */
export function themeCookie(name: string, value: string): string {
	return `${name}=${value}; path=/; max-age=${COOKIE_MAX_AGE_SECONDS}; samesite=lax`;
}
