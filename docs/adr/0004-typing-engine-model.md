# ADR-0004 — Typing engine model

**Status:** Accepted (amended 2026-07-20, 2026-08-01 and 2026-08-07, see below)

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
- Interacts with the game modes: in **Zen** WPM/accuracy are not tracked, only progress %. (Delivered
  in the 2026-08-07 amendment below, which scopes measurement to spans rather than whole passages.)

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

## Amendment (2026-08-07, Phase 4a implementation — spec #24)

The 2026-07-20 amendment closed with a prediction: the state machine never imports the metrics
module, "so Zen mode later disables tracking with a flag, not a fork". Phase 4a is that later, and
the prediction held — but it needed two additions to this model, and one of them widens a seam this
ADR has already recorded once. [ADR-0014](0014-mode-measurement-axis.md) settles what `mode` *is*;
this records what it did to the engine.

### Zen spans are discounted by the same mechanism as `awaiting`, and the two are kept disjoint

The 2026-08-01 amendment above measured `awaiting` with an open-span marker (`awaitingSince`) plus an
accumulator (`awaitingMs`), fed into `computeMetrics`'s `excludeMs`. **Zen reuses that mechanism
exactly**, at two scopes: `unmeasuredSince` / `unmeasuredMs` mirror the pair for the session, and
`chunkUnmeasuredMs` carries the same total for the active traversal. The fields are flat rather than
nested in a `span` object precisely so the visual parity with the `awaiting` pair is legible — the
parity is the argument for reusing the mechanism rather than inventing a second one.

Zen adds a **second reason to discount, not a new way to discount**. That matters because the two
discounts are summed, and **summing them is only correct because they are disjoint by construction**:

- entering `awaiting` **closes** any open Zen span into the accumulators and nulls the marker, so
  `awaitingSince` alone owns the clock during a wait;
- `window-loaded`, on the branch returning to `active`, **reopens** the Zen span iff the mode is
  still `zen`;
- a `set-mode` to `zen` while not `active` stamps no marker at all, for the same reason.

A span that could not be stamped when the mode was set — no clock exists in `createSession`, and none
is stamped while `awaiting` — **opens at the first stroke that carries one**. Without that, a session
*opened* in Zen would accrue no discount at all and a wholly-Zen traversal would report
`measuredMs === elapsedMs` rather than 0. It is the counterpart of the `restart` rule below: the
engine waits for a real instant instead of inventing one, but it does not forget to open the span.

Overlapping the two would subtract the same milliseconds twice and silently **inflate** cumulative
WPM. It is floored at 0, so it would never crash and never go negative — which is exactly what would
make it hard to notice, and why the disjointness is a named rule with a named test rather than an
incidental property.

Two smaller rules follow the precedents this ADR already set. `restart`, the one `ChunkEvent`
carrying no clock, leaves the Zen marker null rather than stamping a fabricated instant — the
`awaitingSince` precedent, applied verbatim. And the **open** Zen span is discounted live when
`runningMetrics` is given an `endTime`, for the same reason the open wait is: a UI polling the figure
while the user sits in Zen must not watch WPM decay for a reason that is not the typist's.

### `metrics.ts` now reads a provenance flag — the same seam, widened a second time

The 2026-08-01 amendment recorded `excludeMs` as a concession: a delivery-layer concern inside the
metrics module, leaving the "pure function of a log slice" framing "one parameter less pure". Phase
4a adds **no fourth parameter** — `computeMetrics(slice, endTime?, excludeMs = 0)` keeps its exact
signature — but the counting terms are now taken over `slice.filter((k) => k.measured !== false)`, so
the module reads a **provenance flag** on the keystrokes it scores. That is a second, smaller
widening of the same seam, and it is surfaced here rather than smuggled.

The split inside the function is deliberate and is the whole design in one line: **counting terms
filter, the time term does not.** `typedChars` and the first-attempt population exclude Zen strokes;
the elapsed span stays first-stroke → `endTime ?? last`, minus `excludeMs`. Recomputing the span over
the measured strokes only would be a second span calculation that could drift from the accumulator,
and it could not account for Zen time spent *between* strokes or *before* the first one. One span
minus one accumulated discount cannot drift.

### `absent means measured` — the provenance is optional, and that is the regression guarantee

`Keystroke.measured` and the `measured` field on `char`/`backspace` events are typed **optional**,
and an absent flag reads as measured. `session.ts` stamps it from `SessionState.mode` and is the only
module that does; `chunk.ts` copies it off the event exactly as it copies `timestamp`, gains no
import, and keeps the metrics-free promise its header has always carried.

The optionality is not laziness. It is the operational form of "a fully-Normal session is
byte-identical to pre-4a": **the entire pre-4a engine suite runs green with no edits**, over fixtures
that carry no flag at all. Together with `createSession`'s defaulted third `mode` parameter, it is
what makes the regression guarantee a property of the type rather than a promise in a test plan. It
is the same construction argument the schema backfill and the v1 attempt buffer rest on
([ADR-0010](0010-progress-data-model.md)'s Phase 4a amendment) — everything produced before the mode
axis existed was, by construction, fully measured.

### What the model gained, in the model's own terms

- `SessionState` carries `mode` and, alongside the span accounting, two booleans that are *not*
  derived comparisons: `chunkFullyMeasured` (killed permanently by any switch to Zen during a
  traversal, never restored by switching back) and `everUnmeasured` (session-scoped, cleared only by
  `restart-session`). Both are booleans rather than `…Ms === 0` tests because **a zero-millisecond
  Zen excursion is still a Zen excursion**, and both the row and the summary must say so.
- `ChunkResult.grossWpm` and `.accuracyRaw` become `number | null`, null exactly when the traversal
  was not wholly measured, while `measuredMs` / `measuredChars` / `mode` are recorded either way.
  `elapsedMs` keeps its meaning — wall clock, first keystroke to completion — unchanged.
- `SessionSummary.averageWpm` and `.overallAccuracy` become `number | null`, all-or-nothing on
  `everUnmeasured`. This is deliberately **different** from `runningMetrics`, which always returns
  numbers; the two must not be conflated ([ADR-0014](0014-mode-measurement-axis.md) on why the live
  figure and the persisted row are honest at different scales).
- Completion is **untouched**. A chunk still completes exactly when no character is `pending` or
  `incorrect`, in both modes. `set-mode` touches the span accounting and nothing else — not
  `activeChunk`, not the log, not `status`, not `results` — and is valid in every status, so
  switching is free mid-word, mid-passage or between passages. Re-asserting the current mode returns
  the identical state object rather than fabricating a zero-length span boundary.

## Pending (post-MVP, already contemplated)

- **Accent modes**: `hardcore` (exact accent required) vs `relaxed` (`dia` = `día` valid). Distinct from
  Zen. To be defined when polishing the engine.

## Alternatives considered

- **Blocking (TypeLit style)** — Simple and pedagogical, but frustrating and complicates the accuracy
  computation.
- **Free typing with optional correction (Monkeytype)** — Valid, but does not reinforce the "finish the
  text" fantasy that gives the product coherence.
