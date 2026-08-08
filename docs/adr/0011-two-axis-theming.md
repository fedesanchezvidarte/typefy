# ADR-0011 — Two-axis theming: palettes as data, fonts as data

**Status:** Accepted

## Context

The look & feel design (spec #9, `docs/design/look-and-feel-brief.md` + the approved Claude
Design mockup) makes theming a product feature: a reading sanctuary should let the reader pick
the page they read on. We needed a theming model that stays cheap to QA, cheap to extend, and
impossible to fragment — before message keys and tokens hardened around a worse one.

## Decision

One fixed skeleton, two independent user-facing axes:

- **Palette** — colour and only colour. Four at launch (`warm-light` default, `cool-light`,
  `soft-dark`, `near-black`), each a pure 10-token record (`bg, sheet, fg, dim, muted, border,
  accent, error, errorTint, caret`) plus a `light|dark` scheme flag. Source of truth:
  `src/lib/theme/palettes.ts`; painted by `src/routes/layout.css`
  (`:root[data-palette=…]` blocks), with a unit test asserting TS/CSS parity.
- **Font family** — type and only type. Three at launch (`sans` default, `serif`, `mono`), all
  IBM Plex, self-hosted via Fontsource. The superfamily's shared metrics are what satisfy the
  brief's optical-matching condition: switching family never reflows the passage.

Mechanics: each axis persists as its own cookie (`typefy-palette`, `typefy-font`); the server
stamps `data-palette`/`data-font` onto `<html>` before paint (no FOUC); switchers update the
dataset and cookie client-side with no reload. With no cookie, CSS `prefers-color-scheme`
picks warm-light or soft-dark — system preference only selects the *initial* default; there is
no light↔dark pairing and no day/night flip.

The typing surface is **tonal**: `pending` = `dim`, `correct`/`corrected` = `fg`,
`incorrect` = `error` on `errorTint` (plus wavy underline — colour is never the only signal).
There is no green. This survives every palette and every form of colour blindness because it
is built on contrast, not hue.

## Consequences

- The skeleton (spacing, radii, motion, component anatomy) never varies by theme; adding a
  palette is appending a record + a CSS block, not changing the model.
- No theme can carry a typographic identity (no "Console" theme that arrives as mono) — the
  accepted trade-off of strict axis separation.
- Contrast QA is per-palette (4 checks), not per-combination (12), because fonts share metrics.
- Combo presets ("the bookish one") remain possible later as sugar over the two axes.

## Alternatives considered

- **Monolithic themes (palette+font bundles)** — richer identities, but 12 QA combinations,
  and adding either axis multiplies the matrix.
- **Light/dark only with an accent picker** — cheaper, but abandons the "reading sanctuary"
  register that motivated the design.
- **Runtime-injected CSS variables from JS only (no CSS blocks)** — one source of truth, but
  themes flash on load without SSR stamping and break with JS disabled; the parity test keeps
  the duplication honest instead.

## Phase 5a amendment (spec #30)

**Font family → reading font, scoped to book text.**

The font axis is no longer app-wide. Interface chrome (header, library, all UI text) is fixed
to Roboto and does not vary with the user's choice. The axis — renamed in effect **reading
font** — now applies only to the two places a user reads/types a book's own text: the typing
screen's `TypingSurface` and the landing hero's `TypingSurface` instance. `FontId`/`FONTS`
(`src/lib/theme/fonts.ts`) keep their shape and their wire format: the cookie name
(`typefy-font`) and the `data-font` attribute are unchanged, so an existing user's saved
preference still resolves correctly with no migration. Only the *display* concept — what the
choice visibly controls — narrows.

The three faces also change: IBM Plex Sans/Serif/Mono → Roboto/Roboto Serif/Roboto Mono
(self-hosted via Fontsource, same import mechanism, static weights 400/500/600 pinned per
face — Roboto Mono ships 400/500 only). Roboto is also the fixed chrome face, so the `sans`
reading-font option and chrome now happen to render in the same family at different weights —
an accepted overlap, not a merge of the two axes: chrome is never user-selectable, and the
other two reading-font options (serif, mono) still diverge from chrome.

**The optical-matching/no-reflow condition is dropped for this axis.** ADR-0011's original
decision required the three font faces to share metrics precisely so switching the axis never
reflowed the passage — true when all three were cuts of one superfamily (IBM Plex). Roboto,
Roboto Serif and Roboto Mono are three unrelated font families with different x-heights,
character widths and line-height defaults; guaranteeing zero reflow across them is not a
condition Fontsource's metric data lets us cheaply hold, and the spec does not ask for it.
Switching reading font may now reflow the passage the user is typing — the character-state
model already tolerates a passage's rendered width changing (it re-derives from character
index, not pixel position), so this costs nothing functionally, only the visual promise ADR-
0011 originally made. The palette axis's conditions (colour-and-only-colour, no typeface
assumption) are unaffected.

**Consequence for the "no theme can carry a typographic identity" line.** Still holds: chrome
never adopts a reading-font identity, and no combo preset is introduced by this spec.

Mechanically: `--font-stack` (one variable, applied to `body`) is split into
`--chrome-font-stack` (fixed Roboto, applied to `body`) and `--reading-font-stack` (driven by
`data-font`, consumed only inside `TypingSurface`'s scoped CSS — `src/routes/layout.css`,
`src/lib/theme/fonts.ts`, `src/lib/components/typing/TypingSurface.svelte`).
