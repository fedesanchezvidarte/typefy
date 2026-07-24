# ADR-0010 — Progress data model: append-only attempts + rollups

**Status:** Accepted (Phase 2a — spec #7; tables created in 2a, written in 2b)

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
- **Accepted advisor noise:** foreign-key columns carry covering indexes (Supabase advisor 0001), which
  the performance advisor then reports as *unused* (0005) because the tables are empty and unqueried until
  2b. This is a false positive on empty tables; the indexes are intentional and the INFO is consciously
  accepted, not acted on. The security advisor reports zero issues on the finished 2a schema.

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
