# ADR-0014 — Mode as the measurement axis

**Status:** Accepted (Phase 4a — spec #24)

## Context

CONTEXT.md promised **Normal mode** and **Zen mode** from Phase 0, and the code never delivered
them. Zen was `let zen = $state(false)` inside `TypingSession.svelte`: a per-visit presentation
toggle that hid figures the engine went on computing, forgot itself on every visit, and was
invisible to the engine, to `chunk_attempts` and to the rollups. The glossary said Zen meant "no
WPM/accuracy tracking"; every row in the database said otherwise.

Making that promise true is not a rendering change. It decides what the engine derives, what the
summary shows, what a row contains, and — through `best_wpm` — what every future stats screen reads.
So the question is not "how should Zen look" but **what kind of thing `mode` is**, and that has to be
settled before Phase 4's polish and stats work harden around a worse answer.

There was a second, forcing problem. Measurement was pinned to *one whole passage*: a figure meant
"this traversal", and there was nowhere honest for a mid-passage mode switch to go. The same
pinning is what a future **page-view** presentation would break, because a passage would stop being
the natural unit of a sitting.

## Decision

**`mode` is the measurement axis, with exactly two values, and it measures spans rather than
passages.**

### Two values, one meaning

`mode` is `normal` (default) or `zen`. It answers one question — *is this stretch of typing being
measured?* — and must not accumulate a second meaning. In `zen` the engine **keeps the keystroke
log** but derives, displays and persists **no** WPM and **no** accuracy.

Keeping the log is not a concession: it costs nothing (it is already in memory), it is what makes a
mid-session switch back to Normal work at all, and "no tracking" stays honest at the level users
mean it — nothing is measured at them, nothing is shown to them, nothing is written about them.

The axis is stored as a `text` column with a `CHECK` listing the allowed values, rather than a
Postgres enum: extending the axis is then a one-line migration instead of an `ALTER TYPE`, while a
typo'd client value can still never land in the source-of-truth table.

### Presentation is a separate axis, added beside `mode`, never a third value inside it

**This is the decision most likely to be "helpfully" undone later, and spec #24 §1 says so
explicitly.** A future page-view — showing a full book page rather than a single passage — is a
*presentation* concern. It is added as its own axis, alongside `mode`, and `mode` never gains a
third value.

Folding presentation into measurement produces `zen-page` / `normal-page` and a combinatorial mess
the moment a third value of either appears: every consumer of `mode` — the CHECK constraint, the
rollup guard, the summary, the buffer's type guard — would then have to parse a compound rather than
read a value. This is exactly the discipline [ADR-0011](0011-two-axis-theming.md) applied to
theming, where palette and typeface are two independent axes rather than one enum of combinations,
and the reasoning transfers unchanged.

Two structural guardrails back the rule, and they are guardrails rather than walls:

- `Mode` and `isMode` live in `src/lib/types.ts` and the cookie lives in its own module,
  `src/lib/mode/mode.ts` — deliberately **not** in `src/lib/theme/theme.ts`, where the presentation
  axes live. A `Mode` sitting next to `PaletteId` and `FontId` invites the next reader to add
  `data-mode` to `themeHtmlAttributes` and give mode a look. Living apart makes that a cross-module
  change rather than a two-line one.
- `hooks.server.ts` is untouched. Mode is read in the typing route's load, because exactly one route
  uses it and there is no chrome attribute to stamp before paint.

### Measurement is scoped to the measured span

A **measured span** is a contiguous stretch typed in Normal. A traversal or a session may contain
several, separated by Zen stretches, and every figure is computed over the measured spans only:

- **Counting terms** — typed characters and first-attempt records — exclude Zen strokes. Each
  `Keystroke` carries its own `measured` provenance, stamped by `session.ts` from the current mode,
  so a slice can be scored without a second source of truth about when the mode changed.
- **Time** in Zen stretches is excluded from elapsed exactly as `awaiting` time already is, through
  `computeMetrics`'s `excludeMs` — an open-span marker plus an accumulator. Zen adds a second reason
  to discount, not a new mechanism. The mechanics, and the disjointness rule the two discounts need,
  are recorded in [ADR-0004](0004-typing-engine-model.md)'s Phase 4a amendment.

Span-scoping is what makes a mid-passage switch correct *now*, and it is the property that survives
page-view later: when a passage is no longer the natural unit of a sitting, "what did this number
measure?" must be answerable from the row itself.

### The live figure and the persisted row deliberately differ

Each is honest at its own scale, and conflating them would break one of them.

- **Live and session figures** (`runningMetrics`) measure every Normal span and always return
  numbers. Someone who types half a session in Zen and switches back sees a figure covering the
  Normal half — real typing, really measured. It is information for the person typing right now and
  it disappears with the session.
- **A persisted `chunk_attempts` row requires a whole clean traversal.** Any Zen time in that
  passage — even an instantaneous toggle that accrued no milliseconds — writes `mode = 'zen'` with
  `gross_wpm` and `accuracy_raw` **NULL**, while `measured_ms` and `measured_chars` still record what
  was measured.

The asymmetry is the point. `chunk_attempts` is what `best_wpm` and every future stats screen read;
a partial figure filed as *that passage's* result would let a twenty-character Normal sprint at the
tail of a passage bank a personal best. The live figure carries no such consequence.

The **session summary** is the persisted row's counterpart rather than the live figure's: it is
all-or-nothing on a session-scoped `everUnmeasured` flag, so a session containing any Zen time shows
no WPM and no accuracy tile at all. The flag, not `unmeasuredMs === 0`, is the predicate — an
instantaneous toggle accrues zero milliseconds and still means the session was in Zen.

### The best floor is a sanity floor, never an anti-cheat

A measured span shorter than **100 characters** (≈20 words) is stored, counted and completed like any
other attempt, but never sets `best_wpm` or `best_accuracy_raw`. Chunks are 400-600 characters
([ADR-0005](0005-paragraph-chunking.md)), so a genuine passage clears the floor comfortably; what it
stops is a short sprint producing an unbeatable rate. An absolute character count is chosen over a
fraction of the chunk deliberately: it is independent of chunk size and of layout, and it stays
meaningful when the presented unit stops being one chunk.

**`measured_chars` is client-asserted, exactly like `gross_wpm`**
([ADR-0012](0012-client-trusted-progress-writes.md)). The floor is enforced by Postgres, but its
*input* is not verified: a client can post `mode = 'normal'` with `measured_chars = 10000` and buy a
best the guard was meant to refuse, or post `mode = 'zen'` on a measured passage and refuse itself
one. So the floor stops an accident — a genuine short sprint banking a personal best — and stops
nothing a determined client chooses to assert. It must **never** be credited with more than that,
least of all by a stats or leaderboard screen looking for a reason to trust a number.

ADR-0012's revisit trigger is **not** tripped by this: progress is still strictly private, nothing is
comparative, and the blast radius is still exactly one account. But the trigger's scope now
implicitly covers `measured_chars` too, and whoever trips it must read it that way.

## Consequences

- The glossary is true. **Zen mode** means what CONTEXT.md has claimed since Phase 0, and a Zen
  passage writes no metrics about a user who asked not to be measured.
- **Zen progress is progress.** Completion, resume, book percentages and continue reading are
  mode-blind: `attempt_count`, `first_completed_at` and `chunks_completed` all move on a Zen
  completion exactly as on a Normal one. Only `best_*` is withheld.
- `gross_wpm` and `accuracy_raw` become nullable, and `chunk_attempts` gains three columns — the
  schema half of this decision is recorded in [ADR-0010](0010-progress-data-model.md)'s Phase 4a
  amendment, and the engine half in [ADR-0004](0004-typing-engine-model.md)'s.
- A fully-Normal session is unchanged, by construction rather than by care: `mode` defaults to
  `normal` in `createSession`, an absent `measured` flag reads as measured, and the entire pre-4a
  engine suite runs green unedited.
- Page-view is now addable without a metrics rewrite, which was the forcing reason to settle this
  before Phase 4's polish rather than during it.
- The two-value rule has a cost worth naming: a mode that genuinely *is* a measurement variant —
  a timed sprint, an accuracy-gated run — belongs on this axis and would extend the CHECK, the
  rollup guard and the summary's predicate together. Spec #24 deliberately shipped no such mode, so
  that path is untested. The rule is "presentation goes elsewhere", not "this axis is closed".

## Alternatives considered

- **Keep Zen a presentation toggle and gate only the display.** Cheapest, and what existed. Rejected
  because it is the dishonesty this ADR exists to remove: the engine still measures, the row still
  carries a figure, and `best_wpm` still moves — the glossary's claim stays false and the database
  goes on disagreeing with it on every row.
- **One enum of combinations (`normal`, `zen`, `normal-page`, `zen-page`).** Fewer columns and one
  value to read. Rejected as ADR-0011 rejected monolithic themes: the matrix multiplies with every
  value of either axis, and every consumer degrades into parsing a compound.
- **Write a partial figure on a mixed traversal**, scaled to the measured span. Superficially more
  informative. Rejected because `best_wpm` reads that column: a short measured span at the tail of a
  passage would produce a high, unbeatable rate filed as that passage's result. The floor would then
  be load-bearing rather than a sanity check, and its input is client-asserted.
- **A per-span history table.** Fully general, and answers questions nobody has asked. Rejected as
  over-engineering: the two summary columns answer "what did this row measure?", which is the only
  question the schema actually owes an answer to today.
- **Recompute metrics server-side so the floor's input could be trusted.** The honest fix for the
  client-asserted caveat above, and out of scope: it is ADR-0012's standing question, and it becomes
  worth answering when something comparative exists, not before.
