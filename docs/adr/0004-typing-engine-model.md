# ADR-0004 — Typing engine model

**Status:** Accepted

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
- Implementation: hidden input + `keydown` listener + span rendering. **Not** a real `<textarea>`.

## Consequences

- Clean metrics and a simple per-character state model that supports the three colors.
- Critical component to test thoroughly (dead keys, accents, `ñ`, IME) → prime candidate for TDD with
  Vitest ([ADR-0009](0009-vitest-playwright-testing.md)).
- Interacts with the game modes: in **Zen** WPM/accuracy are not tracked, only progress %.

## Pending (post-MVP, already contemplated)

- **Accent modes**: `hardcore` (exact accent required) vs `relaxed` (`dia` = `día` valid). Distinct from
  Zen. To be defined when polishing the engine.

## Alternatives considered

- **Blocking (TypeLit style)** — Simple and pedagogical, but frustrating and complicates the accuracy
  computation.
- **Free typing with optional correction (Monkeytype)** — Valid, but does not reinforce the "finish the
  text" fantasy that gives the product coherence.
