# ADR-0004 — Typing engine model

**Status:** Accepted (amended 2026-07-20 and 2026-08-01, see below)

## Context

The typing engine is the core of the product and defines how accuracy is computed. We had to decide what
happens when the user makes a mistake, among three models: blocking (don't advance until correct), free
typing with optional correction (Monkeytype style), or free typing with correction required to complete.

## Decision

**Free typing with correction required to complete the chunk**:

- Each character has a state: `pending`, `correct`, `corrected`, `incorrect`.
- An error is shown in **red**; fixing it with backspace marks it `corrected`. (Rendering of
  `corrected` refined by the 2026-07-20 amendment below.)
- You can advance with visible errors, but the **chunk does not complete** until everything is correct
  (consistent with the "writing the text" fantasy: a text with typos is not finished).
- **Accuracy (raw)** = first-attempt correct characters / total characters. The `corrected` state counts
  as a miss even though it is visually resolved.
- **WPM** measured over the chunk's time.
- Implementation: hidden input + key event handling + span rendering. **Not** a real `<textarea>`.
  (Event strategy refined by the 2026-07-20 amendment below.)

## Consequences

- Clean metrics and a simple per-character state model that drives the rendering.
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
- **`corrected` renders identically to `correct`** (user feedback after testing full sessions: a
  lasting yellow mark on fixed errors felt demotivating). Only *current* mistakes are highlighted;
  once fixed, a character carries no visual mark. The `corrected` state remains in the engine — it
  caps raw accuracy, satisfies chunk completion, and enables future error-position features. An
  opt-in "highlight corrections" setting is a candidate for the settings phase.

## Amendment (2026-08-01, Phase 3b implementation — spec #18)

Windowed reads ([ADR-0006](0006-books-chunks-data-model.md)'s Phase 3b amendment) mean the session no
longer holds the whole text. The engine had assumed it did — `createSession` sized a dense `results`
array from the chunk list, and "the next chunk" was always in hand. Building the windowed read path
changed the state model, and the spec mandated recording it here.

### The `awaiting` state, and what it costs

`SessionState.finished: boolean` is replaced by a named `status: 'active' | 'awaiting' | 'finished'`.
A session enters `awaiting` when it completes a passage whose successor exists in the text
(`books.chunk_count`) but is not in the loaded **window**.

**`awaiting` is the engine's first state the user cannot leave by typing.** Every prior state of this
machine transitioned on a keystroke; this one transitions on `window-loaded`, an event from the
delivery layer. Typing events arriving while `awaiting` return the identical state object — nothing
enters a log, no metric can move, and nothing is buffered into the chunk that eventually arrives.
That is a real change to the model this ADR describes, not an implementation detail.

**`activeChunk` becoming nullable is the cost the named state buys down, not something that
vanished.** It is now `ChunkEngineState | null`, null whenever `status !== 'active'`. The nullability
is unavoidable: a session with no loaded passage has no chunk state to hold. What the named `status`
buys is that the nullability is checked in *one* documented place per call site instead of degenerating
into scattered `activeChunk === null` tests that each have to guess whether null means "waiting" or
"done" — two conditions that need opposite handling and are indistinguishable from the null alone.
Recording the trade honestly: one field got weaker so that a boolean pair could not go out of sync.

### `metrics.ts` was touched, and that is a compromise

`computeMetrics` gained a third parameter, `excludeMs`, which discounts dead time from the elapsed
span before the gross-WPM formula runs. **This puts a delivery-layer concern inside the metrics
module**, and the 2026-07-20 amendment's framing — metrics as a pure function of a log slice — is now
one parameter less pure. It is small (defaulted to 0, so every existing caller and test is untouched)
and it has no effect on `accuracyRaw` or `typedChars`, which carry no time term. But it is a
concession and it is recorded as one rather than pretended away.

It was still the right trade. The alternative was recomputing WPM in `session.ts` to apply the
discount there, which puts a second copy of the gross-WPM formula in a second module — the one thing
`metrics.ts` exists to prevent — or lifting cumulative WPM out of the engine entirely to solve a
delivery-layer problem, which the spec rejected. A dead-time term on a time-based metric is at least
about time; a duplicated formula is about nothing.

### How the wait is measured — no clock reached the engine

The pure-reducer rule of the 2026-07-20 amendment holds unbroken: **nothing in `src/lib/engine/` reads
a clock.** The wait is measured entirely from injected timestamps.

- Entering `awaiting`, `awaitingSince` is stamped from **the completing keystroke event's own
  timestamp** — the instant the passage finished. The one `ChunkEvent` carrying no timestamp
  (`restart`) leaves `awaitingSince` null instead, so the wait opens unmeasured rather than at a
  fabricated instant.
- `window-loaded` carries its own injected `timestamp`, which closes the wait into the cumulative
  `awaitingMs`. A window that arrives without the awaited index leaves `awaitingSince` alone rather
  than restarting it, so a partial delivery cannot erase time already waited.
- `computeMetrics` subtracts `awaitingMs` from the first→last-stroke span before dividing, floored at
  zero: a session that waited longer than it typed reports 0 elapsed and 0 WPM, never negative time.

The implementation goes one step further than the design required: `runningMetrics` also discounts the
**open** wait when an `endTime` is supplied. A UI polling live metrics during a slow fetch would
otherwise watch WPM decay for a reason that is not the typist's, because `awaitingMs` alone only closes
the gap after the window lands.

### The session is not re-created per window

An arriving window is *merged* into a `ReadonlyMap<number, Chunk>` keyed by absolute index; the
session object survives. Re-creating it per window would have been simpler and is wrong: it would
reset `completedLog`, and `completedLog` is the concatenated keystroke log across passage boundaries —
which is the definition of the running cumulative WPM this project displays (CONTEXT.md, *WPM*). A
per-window session would silently redefine the headline metric as "WPM since the last window
boundary", a number nobody asked for and nobody could have noticed was wrong.

`results` became a sparse `ReadonlyMap<number, ChunkResult>` keyed by absolute index for the same
reason: the old dense array was sized from the full chunk list. Absolute indices are untouched
throughout — `activeIndex + 1` on the meta line, `?passage=N`, and the `chunk_id` persisted to
`chunk_attempts` all still read the same numbers.

### `window-loaded` adopts an authoritative `chunkCount`

The event carries the endpoint's `chunkCount` and the session **always** adopts it, merge path
included. That is the whole reconciliation mechanism for a re-ingest that changed the book's length
mid-session: a client holding a stale smaller bound stops ending the session early, and a stale larger
bound can no longer strand it in permanent `awaiting` — `chunkCount <= activeIndex` while awaiting
resolves to `finished` and a summary instead of a hang.

### `restart-session` returns to the opening index, not to 0

Previously `restart-session` rebuilt the session at index 0. With windows, index 0 is usually not
loaded on a resumed session, so restarting a session opened at passage 900 would drop straight into
`awaiting` for a window nothing is going to request. It now returns to the session's `openingIndex`.
This is a small **user-visible** change beyond the spec's letter and was approved by the user before
implementation. It is also what the summary's "Restart session" button already reads as, it keeps
every needed chunk in hand, and it is identical to the old behaviour for the landing hero and for any
session opened at passage 1.

## Pending (post-MVP, already contemplated)

- **Accent modes**: `hardcore` (exact accent required) vs `relaxed` (`dia` = `día` valid). Distinct from
  Zen. To be defined when polishing the engine.

## Alternatives considered

- **Blocking (TypeLit style)** — Simple and pedagogical, but frustrating and complicates the accuracy
  computation.
- **Free typing with optional correction (Monkeytype)** — Valid, but does not reinforce the "finish the
  text" fantasy that gives the product coherence.
