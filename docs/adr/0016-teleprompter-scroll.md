# ADR-0016 — The teleprompter

**Status:** Accepted (Phase 5b — spec #32), amended in Phase 5e (spec #45)

## Phase 5e amendment — the band moved, the model did not

Spec #45 pins the typing surface to the viewport's height and asks the page to **sit still** while
it is typed. That is a change of band, not of mechanism:

- **The band.** Under the surface's `page` variant it runs `bandTop = 0` to
  `bandBottom = containerHeight − LOOKAHEAD_LINES × lineHeight`, with `LOOKAHEAD_LINES = 3`
  (exported from `teleprompter.ts`). `computeTranslateY`'s first case — the line already sits
  inside the band, so return 0 — is what turns that into "no scroll at all until the caret reaches
  the last three lines, then one line at a time, always with three lines of lookahead below." The
  middle-third band of the original decision survives on the **landing hero** (`hero` variant),
  where a bottom-margin band inside a five-line viewport would leave nothing above the caret.
- **The viewport.** `hero` keeps the `em`-sized, `visibleLines`-driven height this ADR described.
  `page` instead takes the height its pinned card has left over (`flex: 1; min-height: 0`), so the
  card fills the screen at whatever font size is set — which is what keeps a future user
  font-size control from breaking the layout.
- **Unchanged:** the pure/DOM split, `computeTranslateY` itself (not one line), the display-only
  guarantee that nothing here can reach `src/lib/chunking/`, and the `prefers-reduced-motion`
  rule (the scroll still happens; only the transition is dropped).

The documented fallback below — natural page scroll with `scrollIntoView` — remains the fallback of
record and remains unexercised.

## Context

Once a chunk becomes a **page** — up to 1600 characters, up to 24 estimated rendered lines
([ADR-0005](0005-paragraph-chunking.md)'s Phase 5b amendment) — a passage no longer fits
comfortably as one static block the way a ~500-character chunk did. Spec #32's own cut-order
listed the teleprompter scroll model as the **first** thing to cut if the spec ran long, with a
documented fallback: natural page scroll plus `scrollIntoView`. It was never cut. It shipped as
originally designed, and this ADR records the design as-built rather than the fallback that was
never exercised.

## Decision

The typing surface renders inside a fixed-height, `overflow: hidden` **viewport**
(`.viewport` in `TypingSurface.svelte`), sized in `em` so it scales with the surface's own
`font-size` breakpoint rather than a hardcoded pixel height. The line holding the caret is held
inside a **middle band** — the viewport's middle third, `bandTop = containerHeight / 3` and
`bandBottom = containerHeight * 2 / 3`, recomputed from the viewport's own measured height rather
than hardcoded, so it tracks the `visibleLines` prop and the font-size breakpoint automatically.
Once the caret's line would move outside that band, the text track translates
(`transform: translateY(...)`) so the caret's line re-enters it.

**Pure math and DOM measurement are deliberately split across two files.**
`src/lib/components/typing/teleprompter.ts` exports `computeTranslateY`: given the caret line's
untransformed position, the line height, the container height and the band, it returns the offset
to apply. It takes pixel numbers in and returns a pixel number out — **zero DOM access**, by
contract, stated in its own module comment. `TypingSurface.svelte`'s `measureAndScroll` effect does
only the measurement the pure module deliberately avoids — `viewportEl.clientHeight`,
`getComputedStyle(trackEl).lineHeight`, `caretEl.offsetTop` — and hands the numbers to the pure
function. The effect re-runs on `cursor`, `passageKey` and `display` changes.

This is **display-only** and cannot become the other kind of measurement this codebase has to keep
separate: it never feeds back into `src/lib/chunking/`, the same seam
[ADR-0005](0005-paragraph-chunking.md)'s determinism rule and
[ADR-0015](0015-ch-measure-chunking-contract.md) protect. A pixel offset computed from a live
`getBoundingClientRect` can never become a chunk boundary, because nothing downstream of
`computeTranslateY` writes to anything the chunker reads.

### `prefers-reduced-motion: reduce`

The scroll itself **still happens** — the teleprompter is not disabled under reduced motion,
because a reduced-motion user still needs the text to keep following the caret, just without the
animated interpolation. What is removed is the smooth `.track { transition: transform 0.3s ease; }`
— under reduced motion `.track` gets `transition: none`, so a position change jumps instantly
instead of animating. This is the same "still functions, loses only the animation" pattern already
applied elsewhere in the same component: the caret keeps blinking versus goes steady, and the
per-page settle crossfade keeps fading versus swaps instantly.

## Consequences

- The documented cut-order fallback — natural `scrollIntoView` — was never exercised. Recorded
  here so a future reader does not go looking for a scaled-back scroll implementation that does
  not exist; the teleprompter shipped exactly as spec #32 originally specified it.
- The pure/DOM split (`teleprompter.ts` vs. the `$effect` in `TypingSurface.svelte`) is what would
  have made the documented cut cheap had it been needed — deleting the module and the one effect
  that calls it, with no scroll logic threaded through the caret/input/character-stream code the
  component also owns. That property survives even though the cut was never taken, and is why the
  split was worth keeping despite the extra file.
- Because the pure module takes plain numbers, it is unit-testable without a DOM or a component
  mount — the three cases (`computeTranslateY`'s module comment) are asserted directly.

## Alternatives considered

- **Natural page scroll with `scrollIntoView`.** The documented fallback. Simpler, no DOM
  measurement of the caret's own position, no `transform`. Not chosen because it was never needed
  — the teleprompter's own cut criterion ("if it feels wrong in practice") was never met — but it
  remains the fallback of record if a future regression makes the transform-based approach
  unworkable on some device class.
- **CSS `scroll-snap` on a scrollable container.** Would offload the animation to the browser's
  own scrolling rather than a JS-driven `transform`. Rejected: snapping is line-grid-shaped, not
  band-shaped, and could not express "stay still until the caret leaves the middle third, then
  scroll exactly enough to bring it back" without JS driving the scroll position anyway.
