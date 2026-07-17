---
name: ui-ux-patterns
description: "UI/UX conventions for Typefy: Svelte components, Tailwind + scoped CSS, character-state rendering, Paraglide i18n usage, and accessibility. Use when writing or modifying components or pages."
---

# UI/UX Patterns Skill

> **Living document.** Written during bootstrapping from the agreed stack (ADR-0007, ADR-0008). Refine with concrete component examples as the UI lands.

## Styling (ADR-0008)

- **Tailwind** for layout, spacing, typography, and general UI.
- **Svelte scoped CSS** for the typing engine's rendering and animations (caret, character transitions) — this is the one area where utility classes get in the way.
- Design tokens (colors for character states, fonts) live in the Tailwind config / CSS variables, not scattered as arbitrary values.

## Character-state rendering (ADR-0004)

- The typing surface renders each character as a span keyed to its engine state:
  `pending` (dim) · `correct` (default/green) · `corrected` (**yellow**) · `incorrect` (**red**).
- Rendering is a pure function of engine state — components hold no typing logic of their own; they dispatch DOM events to the engine and render what it returns.
- Input capture: hidden input + `keydown` — keep focus management airtight (clicking anywhere in the typing area refocuses the hidden input).

## Component conventions

- Components live in `src/lib/components/` (shared) or beside their route when route-specific.
- Props typed explicitly; use Svelte 5 runes idioms once scaffolding lands (confirm at Phase 0 and update this skill).
- Keep components presentational; state orchestration lives in the page/route layer or dedicated state modules.

## i18n with Paraglide (ADR-0007)

- Every user-facing string is a Paraglide message, added for **EN and ES in the same change**.
- Message keys are semantic (`catalog_empty_state`), not textual (`no_books_found_text`).
- Don't concatenate translated fragments; use message parameters.

## Accessibility

A typing app lives on the keyboard — a11y is core, not a checkbox:

- The whole typing flow must work keyboard-only (start, type, correct, advance, finish).
- Never trap focus in a way the user can't escape; visible focus indicators everywhere else.
- Color is never the only signal: `corrected`/`incorrect` states need a non-color cue (e.g. underline/strikethrough) for color-blind users.
- Live metrics (WPM/accuracy) update politely (`aria-live="polite"` or equivalent) without drowning screen readers — in Zen mode, they're absent entirely.
- Respect `prefers-reduced-motion` in engine animations.

## Anti-Patterns

- Typing logic inside components (belongs to `src/lib/engine/`).
- Hardcoded user-facing strings, or EN-only messages.
- Arbitrary one-off colors for character states instead of the shared tokens.
- Animations that ignore `prefers-reduced-motion`.
- Focus lost after chunk completion, forcing a mouse click to continue typing.
