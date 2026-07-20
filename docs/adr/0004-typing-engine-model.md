# ADR-0004 — Typing engine model

**Status:** Accepted (amended 2026-07-20, see below)

## Context

The typing engine is the core of the product and defines how accuracy is computed. We had to decide what
happens when the user makes a mistake, among three models: blocking (don't advance until correct), free
typing with optional correction (Monkeytype style), or free typing with correction required to complete.

## Decision

**Free typing with correction required to complete the chunk**:

- Each character has a state: `pending`, `correct`, `corrected`, `incorrect`.
- An error is shown in **red**; fixing it with backspace turns it **yellow** (`corrected`).
- You can advance with visible errors, but the **chunk does not complete** until everything is correct
  (consistent with the "writing the text" fantasy: a text with typos is not finished).
- **Accuracy (raw)** = first-attempt correct characters / total characters. The `corrected` state counts
  as a miss even though it is visually resolved.
- **WPM** measured over the chunk's time.
- Implementation: hidden input + key event handling + span rendering. **Not** a real `<textarea>`.
  (Event strategy refined by the 2026-07-20 amendment below.)

## Consequences

- Clean metrics and a simple per-character state model that supports the three colors.
- Critical component to test thoroughly (dead keys, accents, `ñ`, IME) → prime candidate for TDD with
  Vitest ([ADR-0009](0009-vitest-playwright-testing.md)).
- Interacts with the game modes: in **Zen** WPM/accuracy are not tracked, only progress %.

## Amendment (2026-07-20, Phase 1 implementation — spec #5)

The hidden-input architecture stands, but the original "hidden input + `keydown` listener" wording is
refined: `keydown` alone cannot observe dead-key/IME composition (`´` then `a` must arrive as a single
composed `á`; during composition `keydown` reports `Dead`). The implementation therefore reads **text
from `beforeinput`/`input` events** — which deliver the final composed character — and retains
**`keydown` for control keys only** (Backspace, Escape). The engine itself only ever receives composed
characters; composition handling lives entirely in the UI layer.

Two design decisions made during Phase 1 are folded in as part of the same model:

- The engine is a **pure reducer** (`state + event → state`) with timestamps injected via events —
  no clock or DOM access inside `src/lib/engine/`, which is what makes the TDD mandate of ADR-0009
  practical.
- The **keystroke log is the single source of truth for metrics**: each keystroke carries an immutable
  **first-attempt record** the first time a position is judged (retyping never rewrites it), and every
  metric is computed over a slice of the log (word / chunk / session). The state machine never imports
  the metrics module, so Zen mode later disables tracking with a flag, not a fork.

## Pending (post-MVP, already contemplated)

- **Accent modes**: `hardcore` (exact accent required) vs `relaxed` (`dia` = `día` valid). Distinct from
  Zen. To be defined when polishing the engine.

## Alternatives considered

- **Blocking (TypeLit style)** — Simple and pedagogical, but frustrating and complicates the accuracy
  computation.
- **Free typing with optional correction (Monkeytype)** — Valid, but does not reinforce the "finish the
  text" fantasy that gives the product coherence.
