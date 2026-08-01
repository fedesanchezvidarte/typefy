# ADR-0012 — Client-trusted progress writes

**Status:** Accepted (Phase 2b — spec #12; amended 2026-07-26 for Phase 2c — spec #15, the attempt
buffer's widened trust surface, see below)

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

## Amendment (2026-07-26, Phase 2c implementation — spec #15)

The Context above describes the write path as "one insert attempt, no retry, no queue". Phase 2c's
**attempt buffer** changes that sentence, and widens the trust surface with it. The Decision stands
unchanged — the numeric metrics are still client-asserted and still never revalidated server-side —
and the revisit trigger is not tripped. What follows is what is *additionally* trusted now, and
where that trust is enforced.

### The attribution invariant lives in application code, not in RLS

The drain writes every buffered entry with `user_id` stamped from the **draining** session, never
read off the entry. A *guest-authored* entry (`userId: null`, typed with no session at all) is
therefore written under whoever signs in next on that browser — that is the feature. A
*signed-in-authored* entry must never be written under anyone but its own author, and the only thing
that guarantees that is a function: `isEligible` in `src/lib/progress/drain.ts`, which admits an
entry only when `entry.userId === null || entry.userId === <draining user>`, and skips a foreign
entry, leaving it in place.

**RLS cannot enforce this, and must not be credited with it.** The insert policy checks
`user_id = auth.uid()`. A drain that stamped user A's entry with user B's id would satisfy that check
perfectly: the row is well-formed and correctly owned, it is simply attributed to the wrong person.
And a guest-authored entry satisfies `user_id = auth.uid()` under **any** signed-in user, by
construction — that is exactly what makes guest backfill possible in the first place. So on a browser
two people share, the only thing standing between user B and user A's failed writes is a client-side
`if`.

This is **materially weaker than the guarantees sitting beside it in this ADR**, and it is recorded
as such rather than folded in as though it were equivalent. `user_id` forgery is stopped by Postgres
and is not forgeable at all. Attempt *attribution* is stopped by one function in a bundle the user
controls, over a store the user can edit. Someone editing their own `localStorage` can only move
their own buffered attempts between their own sessions, which stays inside the blast radius the
Decision already accepts; the invariant's real job is the honest case — two accounts on one browser,
where nothing else keeps their histories apart. It is unit-tested and was mutation-checked (the
eligibility test was broken deliberately and confirmed to fail). Do not "simplify" it away on the
belief that RLS covers it.

### An attempt can now be authored with no session at all

Two facts follow from the buffer, both new to this ADR:

- **Metrics can be asserted by a party who held no session when they typed.** A guest's `gross_wpm`,
  `accuracy_raw` and `elapsed_ms` are computed with nobody authenticated, held on disk, and later
  attributed to a real account by a later sign-in. The trust boundary the Decision draws at "the
  browser asserts the numbers" now extends backwards in time, past the sign-in, into a period with no
  identity attached to it.
- **Buffered entries sit on disk, plainly readable and editable, for up to 30 days.** One
  `localStorage` key, one JSON array, nothing signed, obfuscated or checksummed — and nothing should
  be, for the same reason the third alternative below is rejected as security theatre: the client
  controls both the store and the keyboard. The buffer validates entry *shape* on read (a malformed
  entry reads as absent, so it can never be offered to PostgREST) but never *plausibility*.

Both stay inside "a user can only cheat themselves" **because of** the attribution invariant above.
That is what makes this a widening of the existing surface rather than a change of kind.

### Two implementation facts that shape the invariant's edges

- **`drainOnce` joins concurrent callers regardless of `userId`.** The single-flight promise in
  `src/lib/progress/drain-once.ts` is keyed on nothing, so a drain already in flight for user A
  returns *A's* result to a caller that asked for B. This is benign, and the reason is precise: the
  running drain was invoked with A's id, so it can only ever have written A's own and guest-authored
  entries, and B's entries are protected by the invariant whether or not B's call ever ran. **No
  misattributed write is possible.** The only consequence is a possibly-wrong `invalidateAll()`
  decision — B's caller may reload data it did not need to, or skip a reload it wanted — which
  self-corrects on the next drain trigger or the next navigation. Keying the single flight was
  rejected as complexity that buys back a spurious reload.
- **A session expiring mid-session silently reclassifies later completions as guest-authored.**
  `TypingSession`'s `userId` prop is `$derived(page.data.user?.id ?? null)` in
  `src/routes/type/[slug]/+page.svelte`, so an `invalidateAll()` that finds the session gone
  re-renders it as `null`, and every completion after that is buffered as guest-authored rather than
  owned. Accepted deliberately: a guest-authored entry is not lost — it drains to whoever signs in
  next on this browser, which for an expired-then-renewed session is the same person. Freezing
  `userId` at mount would instead keep stamping a dead user id onto entries drainable under only that
  id. The looser attribution is the recoverable failure of the two, and it is bounded: guest-authored
  is the *only* classification this can ever reach, never another user's id.

### Why the queue is on disk rather than a retry in place

Worth recording because it is not obvious and it was observed rather than assumed: **Chromium caches
a failed dynamic import in the document's module map.** Once an `import()` of a URL has failed, every
later `import()` of that same URL in the same document fails immediately, without touching the
network, whether or not connectivity has returned. A session that goes offline *before* it ever
fetched the lazy write path therefore has no write path at all until the document is replaced — so an
in-place retry is impossible for that case, and the `online` trigger is a no-op for it too; the entry
lands on the next page load's mount drain instead. This is the load-bearing reason a completion that
cannot be written is **buffered** rather than **retried**: the entry has to outlive the document. The
offline E2E in `e2e/progress-buffer.e2e.ts` covers exactly this path and carries the detail at the
assertion.

### The revisit trigger is not tripped

The trigger this ADR sets is specific: *the first leaderboard, public completion counter, or any
statistic that compares one user's numbers against another's*. Nothing in Phase 2c is comparative.
Progress remains strictly private under RLS — every read is still scoped to `auth.uid()`, and the
buffer itself adds **no read path**, only a deferred write. The blast radius of a fabricated metric
is still exactly one account. The buffer changes *when* a metric is asserted and *by whom*, not *who
can see it*, and widening the write surface is not the condition the trigger names. A comparative
feature built on this data would be exactly as unsafe as it was before Phase 2c — no more, no less,
and still blocked behind the same reopening.

**Correction (2026-08-01, Phase 3b — spec #18).** The paragraph above originally read "the buffer adds
**no read path at all**". That blanket claim is no longer true and has been narrowed to the buffer
itself. Phase 3b added `GET /api/books/[slug]/progress`, which is the **first per-user progress read
outside a load function**. It changes nothing in this ADR's Decision or trust model: the user is
derived from `auth.uid()`, the read is RLS-scoped to that user, the response is `private, no-store`,
and it returns only this caller's own completed chunk ids within one **window**. Progress is still
strictly private and nothing is comparative, so the revisit trigger remains untripped — but the
sentence is corrected here rather than left to be discovered later as a contradiction.

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
