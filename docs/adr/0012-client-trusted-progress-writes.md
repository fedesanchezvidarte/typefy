# ADR-0012 — Client-trusted progress writes

**Status:** Accepted (Phase 2b — spec #12)

## Context

Phase 2b writes to the [`chunk_attempts`](0010-progress-data-model.md) table from the browser: on every
chunk completion, `recordChunkAttempt` (`src/lib/progress/client.ts`) inserts one row through
`getBrowserSupabase()` (`src/lib/supabase/browser.ts`) — a browser Supabase client authenticated by the
same session cookie `hooks.server.ts` validates on the server, per the SSR cookie sharing set up in
[ADR-0002](0002-supabase-backend.md). `TypingSession.svelte` calls it at the chunk-completion instant,
guarded by `if (userId === null) return` before the module carrying the client is even imported, so guests
never issue the request. One insert attempt, no retry, no queue: a failure is data the session summary
counts, never an exception that interrupts typing.

The insert carries `gross_wpm`, `accuracy_raw`, and `elapsed_ms` — the exact metrics the [Phase 2b rollup
trigger](0010-progress-data-model.md) folds into `best_wpm`/`best_accuracy_raw`. Nothing on the server
recomputes them from the keystroke log before they land. This is a deliberate trust boundary, and it needs
to be named as one rather than discovered by whoever reaches for a leaderboard later.

## Decision

**The numeric metrics on a `chunk_attempts` row are asserted by the browser and never revalidated
server-side.** `recordChunkAttempt` sends `gross_wpm`, `accuracy_raw`, and `elapsed_ms` as computed
client-side by the typing engine; no server action, edge function, or trigger replays the keystroke log to
check them. RLS's `with check ((select auth.uid()) = user_id)` (ADR-0010) verifies only that the row's
`user_id` matches the caller's JWT — that check happens in Postgres, not in route code, and it is not
forgeable. It says nothing about whether 240 WPM is plausible.

This is acceptable **because progress is strictly private**: every read is RLS-scoped to `auth.uid()`
(ADR-0010), and nothing in the product today compares users to each other — no leaderboard, no public
completion counter, no aggregate visible to anyone but the row's own owner. A user who fabricates their own
WPM only corrupts their own history; the blast radius is exactly one account, and that account already had
the ability to just not type correctly. The trust is bounded by the absence of any cross-user comparison,
not by an assumption that users won't try.

**What is and isn't trusted, precisely:**
- `user_id` — **not trusted**, and doesn't need to be: RLS rejects any row whose `user_id` fails the JWT
  check regardless of what the client sends.
- `gross_wpm`, `accuracy_raw`, `elapsed_ms` — **client-asserted**, accepted as-is.
- `created_at` — not client-suppliable at all; the 2b migration's column-level `INSERT` grant on
  `chunk_attempts` omits it, so it always falls to the row's own `default now()` (see ADR-0010's amendment
  for why that matters to the rollup trigger).

**Revisit trigger:** the first leaderboard, public completion counter, or any statistic that compares one
user's numbers against another's makes this ADR's premise false and forces server-side revalidation —
e.g. a server action or edge function that replays the stored keystroke log to recompute WPM/accuracy
before it can back a comparative feature. Do not bolt a comparative feature onto `chunk_attempts` as it
stands today without first reopening this decision.

## Consequences

- No extra round trip, no server-side replay cost, no keystroke log upload — the write path stays exactly
  the shape ADR-0010 already described (one insert, the trigger does the rest).
- A user can inflate their own stats. Accepted: it degrades only their own view of their own progress.
- The `sveltekit-patterns` skill needs a documented carve-out for this: it otherwise pushes all
  Supabase-derived business logic server-side, and this write path is the deliberate exception. Tracked
  separately from this ADR (skill edit handled outside this change).
- Any future feature that reads `chunk_attempts`/rollup values across users (leaderboard, public stats,
  matchmaking-style comparison) must treat this ADR's revisit trigger as a blocking dependency, not an
  afterthought.

## Alternatives considered

- **Server-side recomputation on every insert** (replay the keystroke log server-side, compare against the
  client's claimed metrics, reject or clamp on mismatch) — closes the trust gap completely, but requires
  uploading the full keystroke log on every chunk completion and a non-trivial replay implementation for a
  threat that, today, only harms the attacker's own private data. Rejected as premature: the cost is real
  and immediate, the risk it guards against does not exist yet.
- **Trust nothing, store only `completed` and derive nothing else** — sidesteps the question, but throws
  away the WPM/accuracy history ADR-0010 already committed to keeping. Rejected for the same reason
  ADR-0010 rejected completion-only tracking.
- **Sign the metrics client-side with a value derived from the keystroke log's timing** (e.g. a HMAC the
  server could later verify) — adds complexity without adding real protection, since the client also
  controls the keystroke log it would sign over. Rejected as security theatre.
