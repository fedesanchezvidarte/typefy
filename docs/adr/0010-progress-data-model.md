# ADR-0010 — Progress data model: append-only attempts + rollups

**Status:** Accepted (Phase 2a — spec #7 — tables created; Phase 2b — spec #12 — rollup trigger, amended
2026-07-26; Phase 2c — spec #15 — backfilled attempts and drain idempotency, amended 2026-07-26;
Phase 4a — spec #24 — nullable metrics, span columns and the best floor, amended 2026-08-07; see all
three amendments below)

## Context

Phase 2 persists per-user progress: which chunks a user has completed, and their WPM/accuracy. The
CONTEXT.md glossary framed this vaguely as "completed chunks, WPM, accuracy" without saying whether that
is the *latest* attempt, the *best*, or a *history*. The choice is durable — Phase 2b writes it, Phase 4
builds stats and graphs on it — so it is settled here rather than improvised per feature. The project
owner's explicit steer was to favour the design that scales properly even at the cost of some
over-engineering now.

The engine already treats the [keystroke log](0004-typing-engine-model.md) as the single source of truth
from which every metric is a derived slice. This ADR extends that same principle to persistence.

## Decision

**An append-only attempt history is the source of truth; rolled-up tables serve cheap reads.**

- **`chunk_attempts`** — one immutable row per completed traversal of one chunk (first keystroke →
  completion), carrying `completed`, `gross_wpm`, `accuracy_raw`, `elapsed_ms`, `started_at`. `book_id`
  is denormalised alongside `chunk_id` so per-book queries need no join. This is the authority: every
  progress fact is derivable by replaying it.
- **`chunk_progress`** (rollup per user+chunk) and **`book_progress`** (rollup per user+book) — cached
  aggregates (`attempt_count`, `best_wpm`, `best_accuracy_raw`, `first_completed_at`, `chunks_completed`,
  …) for reads that must not scan the whole history.

**Rollups are maintained, never derived on read.** A Phase 2b `SECURITY DEFINER` trigger on
`chunk_attempts` updates the rollups on each insert. Maintaining (not deriving-on-read) means a book
progress bar or a picker's completion marks are a single indexed row read, not an aggregate over the
history. The rollups are a *cache*: always rebuildable by replaying `chunk_attempts`, never the authority.

**The table is `chunk_attempts`, not `typing_sessions`.** "Session" already carries three meanings in
this project — the glossary's typing stretch, Phase 1's in-memory `SessionState`, and the auth session. A
fourth meaning in a durable table name would be actively harmful. A **chunk attempt** is the precise unit:
one traversal of one chunk.

**RLS enforces append-only structurally.** `chunk_attempts` has `select` and `insert` policies scoped to
`auth.uid() = user_id` and **no update or delete policy** — so history cannot be rewritten by a client,
by construction rather than by convention. The rollups are `select`-only for clients; the 2b trigger
(definer) is their sole writer.

**Phasing:** Phase 2a creates the three tables and their RLS policies but writes nothing to them. The
writes and the rollup-maintaining trigger are Phase 2b, where the tests that verify the trigger live — a
trigger is behaviour, and 2a delivers shape and policy only.

## Consequences

- Full history is retained, so Phase 4 stats (progress over time, per-attempt trends) need no schema
  change — they are queries over `chunk_attempts`.
- The latest/best/first ambiguity is gone: "best" lives in the rollup, "history" in the attempts, and the
  two can never disagree because the rollup is derived from the attempts.
- Two writes per completion (append + rollup) instead of one upsert. Accepted: the trigger keeps it
  atomic, and completion is an infrequent, human-paced event.
- `best_*` semantics (e.g. best WPM only among completed attempts) are defined by the 2b trigger, not the
  schema; the ADR fixes the shape, 2b fixes the aggregation rules.
- **Accepted advisor findings** (spec #7 gates on zero errors and zero *undocumented* warnings):
  - _Performance, INFO — `unused_index` (0005) ×8._ Foreign-key columns carry covering indexes (advisor
    0001), which the performance advisor then reports as unused because the progress tables are empty and
    unqueried until 2b. A false positive on empty tables; the indexes are intentional and the INFO is
    consciously accepted, not acted on.
  - _Security, WARN — `auth_leaked_password_protection`._ Accepted permanently, because it cannot apply:
    the hosted project has **no password-based auth to protect**. `/auth/v1/settings` reports
    `google: true` with `email: false`, `phone: false`, and `anonymous_users: false` — Google OAuth is the
    only enabled provider, per ADR-0002, and email/password and magic-link auth are explicitly out of
    scope in spec #7. HaveIBeenPwned checking guards a password flow that does not exist here. If a
    password provider is ever enabled, this warning stops being inapplicable and must be actioned.
  - The security advisor reports **no errors** and no other warnings on the finished 2a schema.

## Amendment (2026-07-26, Phase 2b implementation — spec #12)

The shape above stands unchanged; this fills in the aggregation rules the Decision section deferred to
2b, as implemented by the `AFTER INSERT` trigger `public.apply_chunk_attempt_rollups()`
(`supabase/migrations/20260726002115_rollup_chunk_attempts.sql`), which is the rollups' sole writer.

- **`best_wpm` / `best_accuracy_raw`** are `greatest()` of **completed attempts only**. An incomplete
  attempt (`completed = false`) still increments `attempt_count` and bumps `last_attempt_at`, but never
  touches either `best_*` column — `greatest()` ignores `NULL`s, so a completion following any number of
  incomplete attempts seeds `best_*` correctly on its own, without a separate `coalesce`.
- **`first_completed_at`** is write-once: `coalesce(cp.first_completed_at, new.created_at)` on a
  completed attempt, so it is set on the first completion and never moved by any attempt after that,
  completed or not.
- **`chunks_completed`** on `book_progress` is implemented as a **count**, not an increment:
  `count(*)` over this user's `chunk_progress` rows for the book where `first_completed_at is not null`.
  This is a deliberate departure from the naive design — "`+1` only on this chunk's first completion,
  guarded by reading `chunk_progress.first_completed_at` before the upsert" — which cannot be made
  concurrency-safe: on a chunk's *first* completion there is no `chunk_progress` row yet, so a guarding
  `select ... for update` locks zero rows, and two concurrent first-completions of the same chunk can both
  observe `null` and both increment, permanently overcounting. Counting is race-free by construction
  instead: the value can never exceed the book's chunk count (`chunk_progress` is keyed on
  `(user_id, chunk_id)`, so a chunk contributes at most once regardless of how many attempts hit it), and
  any transient inconsistency self-heals on the very next attempt rather than drifting forever. This is
  **not** the "rollups derived on read" alternative this ADR already rejected below: the count is still
  maintained on write, once per completion, over at most one row per chunk in `chunk_progress` — a client
  reading a progress bar still reads a single indexed `book_progress` row, never the attempt history.
  - **Ordering consequence:** `chunk_progress` must be upserted **before** `book_progress` in the same
    trigger invocation, so the `book_progress` count reads `chunk_progress`'s *post-upsert* state for
    this attempt. This is the opposite of what a naive increment-based design would need — an increment
    would want the *pre-upsert* state to decide whether this is the chunk's first completion. Counting
    inverts that requirement, and the trigger's statement order is load-bearing for exactly this reason.
- **`created_at`** — the rollup row's own server-assigned `default now()` — is the **sole source** for
  every rollup timestamp the trigger writes (`last_attempt_at`, `last_active_at`, `first_completed_at`).
  The client-supplied `started_at` on `chunk_attempts` is never read by the trigger; it is informational
  only (see [ADR-0012](0012-client-trusted-progress-writes.md) for what else on the row is client-asserted
  versus server-verified). The same migration also **drops the table-level `INSERT` grant** 2a made on
  `chunk_attempts` and **re-grants `INSERT` per column** (`user_id`, `chunk_id`, `book_id`, `completed`,
  `gross_wpm`, `accuracy_raw`, `elapsed_ms`, `started_at`), omitting `created_at` and `id` so both always
  fall to their defaults. Without that column-level grant, a client could have supplied its own
  `created_at` and steered every rollup timestamp through it — the table-level grant covers every column,
  and a column-level `REVOKE` alone cannot narrow it while the table grant stands. This is what makes "the
  server clock is the sole source of rollup timestamps" a guarantee Postgres enforces, not merely a
  documented intention.
- **Advisor findings revisited:** the 2a Consequences section accepted the `unused_index` INFO findings as
  a false positive specific to empty, unqueried progress tables. 2b's trigger makes those tables
  non-empty and queried on every chunk completion (the `chunk_progress`/`book_progress` upserts and the
  `book_progress` count subquery all hit the indexed foreign-key columns), so that INFO is expected to
  start resolving itself as usage accrues rather than remaining a standing exception. Not re-verified
  against a live advisor run as part of this docs-only amendment.

## Amendment (2026-07-26, Phase 2c implementation — spec #15)

Phase 2c adds the **attempt buffer** (CONTEXT.md glossary): a completed passage that cannot be written
at the completion instant — a guest's, or a signed-in user's transiently failed write — is held in
`localStorage` and drained into `chunk_attempts` once a valid session exists. The shape above is
untouched: no new column, no new table, no policy change, and the 2b column-level `INSERT` grant is
exactly as it was. ([ADR-0012](0012-client-trusted-progress-writes.md)'s own Phase 2c amendment covers
the trust consequences.) Two consequences land on *this* ADR.

### A backfilled attempt's rollup timestamps mark the drain, not the typing

`started_at` stays the genuine first-keystroke moment. The buffer captures it at completion and the
drain replays it verbatim, so a backfilled row carries the timestamp the passage was *typed* at, not
the timestamp it was *written* at. `created_at` stays server-assigned and not client-suppliable at all,
because the 2b migration dropped the table-level `INSERT` grant and re-granted per column without it.
That pair is already the honest one, and it is deliberately left alone.

The consequence is therefore stated rather than engineered away. `created_at` is the **sole source**
for every rollup timestamp the trigger writes (the 2b amendment above), so for a backfilled attempt
`first_completed_at`, `last_attempt_at` and `last_active_at` all mark the **drain** moment. A passage
typed as a guest on Monday and drained on a Friday sign-in reads, in the rollups, as a Friday
completion. Offline retry has the same shape at a smaller scale: the gap is however long connectivity
was gone.

Acceptable today, because nothing displays those columns and resume only tests
`first_completed_at is not null` — a drain-stamped value satisfies that exactly as well as a
completion-stamped one. Recorded because it will not stay invisible.

**Forward constraint: Phase 4 statistics over time must read `chunk_attempts.started_at`, never a
rollup timestamp.** "Passages typed per day", "WPM over the last month", streaks, heat maps — every
time-series figure is a query over the attempt history, which is the only place the honest moment
lives. A chart built on `last_attempt_at` or `first_completed_at` would draw a spike on the day a user
reconnected or signed in, and would show nothing on the days they actually typed. This is not a
preference about which column is more convenient; it is the difference between a correct chart and a
wrong one.

Adding a client-suppliable `recorded_at`/`occurred_at` column, so the trigger could source rollup
timestamps from the client instead, was considered and **rejected**: it reopens precisely the hole the
2b column-level grant closed — a client that can steer one rollup timestamp can steer all of them — in
exchange for prettier values in columns nothing currently reads.

### The unique index, and what it does and does not protect

`chunk_attempts_user_chunk_started_key`, a unique index on `(user_id, chunk_id, started_at)`
(`supabase/migrations/20260726190351_attempt_buffer_idempotency.sql`), makes a repeated drain a no-op
at the database rather than by client-side care. All three columns are `not null`, so there is no
NULL-uniqueness caveat. A unique **index**, not a **constraint**: PostgREST only ever emits a column
list (`on_conflict=a,b,c`), never `ON CONFLICT ON CONSTRAINT`, so a named constraint buys nothing it
could use, while the index is the smaller object and can later be rebuilt `CONCURRENTLY`.

- **It protects** the duplicate this feature can actually create: the same buffered entry drained
  twice — two tabs, or a retry after an acknowledgement that never arrived. Two genuine attempts by
  the same user at the same chunk sharing a first-keystroke millisecond are not a real event; a real
  repeat attempt carries a different `started_at`, still inserts, and still fires the 2b rollup
  trigger.
- **It does not protect** against anything a client chooses to assert. `started_at` is client-supplied
  (ADR-0012), so a client that varies it can still append as many rows as it likes. This is an
  idempotency guarantee for an honest replay, not an integrity constraint.
- **It was already mostly redundant**, which is worth stating so it is not credited with more than it
  earned. The 2b trigger had made a duplicate attempt harmless to completion state on its own:
  `chunks_completed` is a `count(*)`, `first_completed_at` is write-once via `coalesce`, and both
  `best_*` columns are `greatest()`. A duplicate could only ever have inflated `attempt_count` and
  bumped `last_attempt_at`. The index closes that residue — and, the actual reason it exists, lets the
  drain treat "already there" as success instead of guessing.

**`ignoreDuplicates: true` on the drain's write is mandatory, not stylistic**, and Phase 2c verified
this empirically as the `authenticated` role rather than reasoning about it. PostgREST's
`Prefer: resolution=ignore-duplicates` emits `ON CONFLICT DO NOTHING`, which needs only the `INSERT`
privilege the 2b column-level grant already gives: three identical writes each returned 201 and left
exactly one row. The control case, `resolution=merge-duplicates` — a true upsert — fails **`42501`,
permission denied**, because it compiles to `ON CONFLICT DO UPDATE` and `chunk_attempts` deliberately
has no update policy and no update grant. The append-only guarantee this ADR calls *structural* is
therefore also what forbids a real upsert. **Any future write path to this table must use
`ON CONFLICT DO NOTHING` (or plain `INSERT`), or it will not run at all.**

**One redundancy observed and deliberately not acted on:** `chunk_attempts_user_chunk_idx`
(`user_id, chunk_id`) is now a strict prefix of the new index and could be dropped. Left in place
because spec #15's third database criterion is that nothing else on the progress tables changes;
recorded here so the next schema change picks it up rather than rediscovering it.

## Amendment (2026-08-07, Phase 4a implementation — spec #24)

**The Decision section above is contradicted until this amendment is read with it.** It states that
`chunk_attempts` carries "`completed`, `gross_wpm`, `accuracy_raw`, `elapsed_ms`, `started_at`" as
one immutable row per completed traversal. Two of those columns are now **nullable** and three
columns are **new**. This is not optional bookkeeping: without it the ADR is simply wrong about the
table it defines.

[ADR-0014](0014-mode-measurement-axis.md) settles *why* — `mode` is the measurement axis and
measurement is scoped to the **measured span**. This records what that did to the schema, in
`supabase/migrations/20260806190144_mode_and_measured_spans.sql`.

### Nullable metrics, and three columns that say what a row measured

`gross_wpm` and `accuracy_raw` **drop `not null`**. A Zen traversal genuinely has no WPM and no
accuracy — not "zero", not "unknown", but *not measured* — and writing 0 or a partial figure would
be a lie `best_wpm` and every future stats screen would then read as truth. The two existing CHECKs
(`gross_wpm >= 0`, `accuracy_raw between 0 and 1`) are deliberately left untouched: a CHECK evaluates
to NULL, and therefore passes, on a NULL input, so both keep constraining every non-NULL value
without an edit.

| Column | Meaning |
|---|---|
| `mode` | `normal` \| `zen`, `not null default 'normal'`, `CHECK (mode in ('normal','zen'))` |
| `measured_ms` | milliseconds of measured span in this traversal |
| `measured_chars` | characters typed within measured spans |

`mode` is `text` with a CHECK rather than an enum, so extending the axis is a one-line migration
instead of an `ALTER TYPE` while a typo'd client value still cannot land in the source of truth.
`elapsed_ms` keeps its meaning exactly — wall clock, first keystroke to completion — and is **not**
redefined; `measured_ms <= elapsed_ms` always, equal exactly when the traversal was wholly Normal.

That invariant is a **database CHECK**, not merely a tested assertion. The measured span is by
definition a subset of the wall clock, so a row violating it is an engine bug that should be refused
at the door rather than persisted and puzzled over later. It is safe against the write path's
rounding: `toRow` rounds both with `Math.round`, which is monotonic non-decreasing, so a pair
satisfying the invariant in floats still satisfies it as integers. If a rejection is ever observed in
practice the correct fix is the engine's arithmetic, never dropping the constraint.

All three columns are `not null` with a default, so the `ALTER` rewrites nothing and every
pre-existing row is immediately valid against the constraints — the defaults are exactly the
fully-Normal degenerate case. `measured_chars` being `not null` is what lets the rollup guard compare
it directly, with no `coalesce` and no NULL-swallows-the-predicate trap.

### The best guard, and what it does not guard

The 2b aggregation rules above stand, with **only the two `best_*` arms changed**. `attempt_count`
and `last_attempt_at` still move on every insert; `first_completed_at` is still set by any completed
attempt; the `book_progress` block is unchanged in meaning, so a Zen completion counts toward
`chunks_completed` identically to a Normal one. **Zen progress is progress.**

Each `best_*` arm now carries its own independent three-part guard: `completed`, **and** the incoming
metric is non-NULL, **and** `new.measured_chars >= 100`. Previously `completed` alone sufficed,
because a completed attempt always carried metrics — it no longer does. The non-NULL test is stated
explicitly even though `greatest()` would ignore a NULL anyway, so a future reader cannot re-derive
"completed implies measured" from the old shape. The guard is written out per column rather than
hoisted into one shared boolean: the two metrics are NULL together by construction today, and a
per-column guard cannot be broken by a future row where only one is set. `greatest()` still ignores a
NULL `cp.best_*`, so 2b's seeding behaviour survives untouched.

The literal `100` is the twin of `BEST_MEASURED_CHARS_FLOOR` (`src/lib/progress/client.ts`). **There
is no single source of truth across the TS/SQL boundary and this ADR does not pretend there is:** the
enforcing copy is the SQL literal, TypeScript never applies the guard, and the two are kept in
agreement by a comment in each naming the other and by the rollup's test importing the constant
rather than writing `100` a third time.

What the guard is *for* is recorded in [ADR-0014](0014-mode-measurement-axis.md) and must not be
inflated here: it is a **sanity floor** against a short measured span banking a personal best, and
**never an anti-cheat** — `measured_chars` is client-asserted exactly like `gross_wpm`
([ADR-0012](0012-client-trusted-progress-writes.md)).

### The backfill is true by construction, so no `best_*` was recomputed

Existing rows are backfilled as fully-Normal: `mode = 'normal'`, `measured_ms = elapsed_ms`,
`measured_chars` from the joined `chunks.char_count`. This restates what those rows already meant
rather than guessing at it — every row written before 4a came from an engine that had no notion of an
unmeasured stretch, always measured the whole passage, and only recorded a completed traversal
covering the chunk's full character count. **That is why existing `best_*` values stay valid and need
no recomputation.**

They also cannot move even in principle: `chunk_attempts_apply_rollups` is an `AFTER INSERT` trigger
and the backfill is an `UPDATE`, so it does not fire at all. The acceptance criterion "no `best_*`
value changed" is satisfied structurally rather than by care.

The same construction argument licenses the **attempt buffer** staying on `typefy:attempt-buffer:v1`
with the three fields optional *on read*. Bumping the key would silently discard every unsent guest
completion sitting in every existing browser — the loss spec #15 exists to prevent. **One accepted
cost, stated rather than engineered away:** a legacy entry has no character count to recover, so the
drain defaults it to `measured_chars = 0` and it therefore sets no `best_*`. Bounded to at most
`ATTEMPT_BUFFER_CAP` (50) entries per browser, only for users holding unsent attempts across the
upgrade, and only `best_*` is affected — `attempt_count`, `first_completed_at`, `chunks_completed`,
resume and continue reading all behave identically.

### The column grant is additive, and omitting it fails silently

2b replaced the table-level `INSERT` grant with a **column-level** one. A column-level grant does not
extend itself to columns added later, so the migration issues
`grant insert (mode, measured_ms, measured_chars) on public.chunk_attempts to authenticated`.

Without that line an authenticated client posting the three new columns is refused `42501`, which
`classifyWriteOutcome` correctly classifies as **permanent** — so the attempt is never buffered and
never retried. Every completion would be dropped, quietly, for signed-in users only. This is a
migration step, not an afterthought.

It is a bare `GRANT` with **no preceding `REVOKE`**: revoking `INSERT` on the table from
`authenticated` would drop the eight existing column grants with it and break every write. `id` and
`created_at` remain ungranted, exactly as before, so both still fall to their defaults and the server
clock remains the sole source of every rollup timestamp. `create or replace function` preserves
privileges, so 2b's `revoke execute … from public, anon, authenticated` still stands and is
deliberately not re-issued.

### `chunk_attempts_user_chunk_idx` — the debt is re-recorded, not dropped

The 2c amendment below observed that `chunk_attempts_user_chunk_idx` (`user_id, chunk_id`) is a
**strict prefix** of `chunk_attempts_user_chunk_started_key` and could be dropped, and asked that
"the next schema change picks it up rather than rediscovering it". This *is* the next schema change,
and it deliberately did **not** pick it up: spec #24's Out-of-scope list forbids changes to the
progress tables beyond the ones above, and quietly widening a migration past its spec is worse than
carrying a known redundancy for one more phase.

So the observation stands unchanged and is re-recorded here rather than allowed to expire silently:
the index is still redundant, still safe to drop, and the request is renewed for whichever schema
change is next permitted to touch these tables.

## Alternatives considered

- **Completion-only** (`chunk_progress(user_id, chunk_id, completed_at)`, nothing more) — satisfies book
  percentage and little else. Cheapest, but throws away WPM/accuracy history that Phase 4 wants, forcing a
  later rewrite. Rejected against the "design for scale" steer.
- **Best-per-chunk only** (rollup, no history) — one table, idempotent, satisfies the glossary literally.
  But "best" with no history is a lossy aggregate: no trend, no attempt count that survives a
  recomputation-rule change. Rejected for the same reason.
- **Rollups derived on read** (view/aggregate over `chunk_attempts`, no cached tables) — no cache to keep
  consistent, but every progress bar aggregates the full history. Fine at 11 chunks, bad at scale.
  Rejected: the whole point of the split is cheap reads.
