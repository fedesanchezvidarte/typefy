# ADR-0010 — Progress data model: append-only attempts + rollups

**Status:** Accepted (Phase 2a — spec #7 — tables created; Phase 2b — spec #12 — rollup trigger, amended
2026-07-26, see below)

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
