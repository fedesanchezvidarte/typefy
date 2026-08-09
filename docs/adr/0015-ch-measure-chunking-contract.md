# ADR-0015 — The `ch` measure as a chunking contract

**Status:** Accepted (Phase 5b — spec #32)

## Context

[ADR-0005](0005-paragraph-chunking.md)'s Phase 5b amendment estimates a chunk's rendered line
count against `CHARS_PER_LINE = 66`, a pure constant with no DOM access — deliberately: the
determinism rule that amendment records requires chunk boundaries to be byte-identical on every
device, so the estimate cannot consult the real rendered width.

That estimate is only honest if it holds a one-directional promise: the real typing surface must
**never** fit fewer than 66 characters per rendered line. If it could, a page whose paragraphs were
budgeted at 24 estimated lines could render as *more* than 24 real lines and overflow the
teleprompter's fixed-height viewport ([ADR-0016](0016-teleprompter-scroll.md)) — the one failure
mode the dual budget exists to prevent.

The **reading font** axis ([ADR-0011](0011-two-axis-theming.md), amended Phase 5a) offers three
faces with materially different average character widths — Roboto, Roboto Serif (proportional) and
Roboto Mono (fixed-width). A single px-based `max-width` cannot honestly bound characters-per-line
the same way across all three: a width tuned safe for the mono face would under-fill the
proportional faces, and a width tuned to look right on the proportional faces would risk fitting
fewer than 66 characters per line in mono.

## Decision

**The typing surface's measure is pinned in `ch` units — `max-width: 66ch` — never px.**

`1ch` is the advance width of the digit `"0"` in the currently active font: a fixed, face-relative
unit, not a fixed pixel count. In the monospace face (Roboto Mono), every character has the same
advance width as `"0"`, so `66ch` fits **exactly** 66 characters per line. In the proportional
faces (Roboto, Roboto Serif), average prose is narrower than a digit, so `66ch` fits **more** than
66 characters per line — roughly 75-85 in practice.

**Characters-per-line is therefore deliberately not constant across faces.** That was never the
goal, and an earlier draft of the Line budget glossary entry claimed it was — corrected as part of
this ADR. What `ch` actually guarantees is the *safe direction*: a face that fits more than 66
characters per line renders a 24-line-budgeted page in **fewer** than 24 real lines, which can only
under-fill the teleprompter band, never overflow it. The dangerous direction — fitting *fewer* than
66 — is exactly what a px measure would risk on the mono face at typical body sizes, and `ch` rules
it out **by construction**, for every face, with no per-face tuning and no measurement step.

Wired as: `src/lib/chunking/measure.ts` exports `CHARS_PER_LINE = 66` with zero imports (the
comment there names this ADR); `TypingSurface.svelte` imports it and sets
`style="--measure: {CHARS_PER_LINE}ch"` on the padding-free `.measure` wrapper, consumed by
`max-width: var(--measure)`.

### Why this earns its own ADR rather than a CSS comment

The contract is invisible from either file alone. `measure.ts`'s `CHARS_PER_LINE` is a pure number
with no CSS awareness — nothing there says a rendered line must never fit fewer than 66 characters,
only that 66 is used to *estimate* one. `TypingSurface.svelte`'s `66ch` is a CSS rule with no
chunking awareness — nothing there says this number is also a chunker's line-cost divisor. The two
only make sense **together**: change one without the other and the "line budget is safe" guarantee
breaks silently, with no compiler error, no failing test that names the cause, and no code
adjacency to catch it.

A concrete failure this is written to prevent: a future "clean up this magic number" pass that
converts `66ch` to a px value for a redesign, or that bumps `CHARS_PER_LINE` to relax the character
backstop without checking the CSS. Either edit compiles, passes unrelated tests, and only shows up
as intermittent teleprompter overflow on the mono face, on long dialogue-heavy books, for someone
who was not the editor. Recording the contract as an ADR — cross-referenced from both files' module
comments — is what gives a future editor of either side a reason to go looking for the other before
changing it.

## Consequences

- Characters-per-line varies by reading font. This is a known, accepted property, not a bug to fix
  or a regression to catch.
- The acceptance criterion this decision exists to satisfy is two-part, not one: (1) the surface's
  computed measure divided by the width of `"0"` in the active font equals exactly `CHARS_PER_LINE`
  (66), confirming the CSS wiring; and (2) rendered characters-per-line never falls *below*
  `CHARS_PER_LINE` in any of the three faces, confirming the safety direction. A test that only
  checks (1) would pass on a px regression that happened to render 66 characters in one face while
  silently failing the guarantee in another.
- `measure.ts` and `TypingSurface.svelte` must be reviewed together whenever either changes; the
  module comments on both sides name this ADR for exactly that reason.

## Alternatives considered

- **A px-based `max-width`, tuned per reading font.** Would need three separately-maintained
  widths instead of one shared constant, and any future reading font would need its own tuning
  pass before shipping — a step with no test to enforce it. Rejected: it reintroduces exactly the
  risk `ch` removes by construction, and moves the safety property from "true by definition" to
  "true because someone tuned it correctly."
- **Measure the real rendered width via the DOM and adjust the line budget dynamically.** Would
  make the budget honestly accurate rather than a conservative estimate. Rejected outright: it
  breaks the chunker's determinism requirement ([ADR-0005](0005-paragraph-chunking.md)'s Phase 5b
  amendment) — chunk boundaries are the progress key and must be byte-identical regardless of
  viewport, zoom, or font rendering, and a DOM-measured budget would make the same book chunk
  differently per device.
