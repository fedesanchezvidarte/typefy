/**
 * Palette axis of the two-axis theming model (spec #9, ADR-0011).
 *
 * A palette is a pure token record — colour and only colour, never a typeface
 * (brief condition 1). The token values here are the single source of truth;
 * `src/routes/layout.css` mirrors them as CSS custom properties, and
 * `theme.spec.ts` asserts the two stay in parity.
 *
 * Adding a palette later is appending a record here (plus its CSS block) —
 * the model never changes.
 */

export type ColorScheme = 'light' | 'dark';

/** The full token contract every palette must define (brief ask #2). */
export interface PaletteTokens {
	/** Page background. */
	readonly bg: string;
	/** The sheet — the typing surface, one step off the background. */
	readonly sheet: string;
	/** Full-strength foreground: `correct`/`corrected` characters, headings. */
	readonly fg: string;
	/** Dimmed foreground: `pending` characters. */
	readonly dim: string;
	/** Muted chrome: meta line, secondary copy. */
	readonly muted: string;
	readonly border: string;
	/** The only expressive colour — wordmark caret bar, progress, links. */
	readonly accent: string;
	/** Error red: the only chromatic event on the typing surface. */
	readonly error: string;
	/** Background tint behind an `incorrect` character (makes a wrong space visible). */
	readonly errorTint: string;
	readonly caret: string;
}

export interface Palette {
	readonly scheme: ColorScheme;
	readonly tokens: PaletteTokens;
}

/** Exact values from the approved Claude Design mockup (docs/design/Typefy.dc.html). */
export const PALETTES = {
	'warm-light': {
		scheme: 'light',
		tokens: {
			bg: '#F3EDE2',
			sheet: '#FBF7EF',
			fg: '#2A251E',
			dim: '#BEB29C',
			muted: '#8C7F6A',
			border: '#E5DCC9',
			accent: '#B06B2E',
			error: '#B23A2E',
			errorTint: '#F1DAD3',
			caret: '#2A251E'
		}
	},
	'cool-light': {
		scheme: 'light',
		tokens: {
			bg: '#EDF0F3',
			sheet: '#FBFCFD',
			fg: '#1E2830',
			dim: '#AAB4BE',
			muted: '#68737F',
			border: '#DBE1E7',
			accent: '#3F6DA3',
			error: '#C23C2E',
			errorTint: '#F5DAD5',
			caret: '#1E2830'
		}
	},
	'soft-dark': {
		scheme: 'dark',
		tokens: {
			bg: '#23262B',
			sheet: '#2C3037',
			fg: '#E5E2DB',
			dim: '#6C737E',
			muted: '#98A0A9',
			border: '#3A3F47',
			accent: '#C89B6A',
			error: '#E5776A',
			errorTint: '#3A2724',
			caret: '#E5E2DB'
		}
	},
	'near-black': {
		scheme: 'dark',
		tokens: {
			bg: '#0E0F12',
			sheet: '#17181C',
			fg: '#F2F1EC',
			dim: '#555A63',
			muted: '#8A9099',
			border: '#262A31',
			accent: '#6BA5E8',
			error: '#F0655A',
			errorTint: '#331F1D',
			caret: '#F2F1EC'
		}
	}
} as const satisfies Record<string, Palette>;

export type PaletteId = keyof typeof PALETTES;

export const PALETTE_IDS = Object.keys(PALETTES) as readonly PaletteId[];

/**
 * First-visit defaults: warm-light, unless the system prefers dark — then
 * soft-dark (the neutral dark). System preference only picks this initial
 * default; it never pairs palettes or flips day/night (brief §1).
 */
export const DEFAULT_LIGHT_PALETTE: PaletteId = 'warm-light';
export const DEFAULT_DARK_PALETTE: PaletteId = 'soft-dark';

export function isPaletteId(value: unknown): value is PaletteId {
	return typeof value === 'string' && value in PALETTES;
}
