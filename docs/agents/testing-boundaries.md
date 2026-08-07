# Testing Boundaries

Where a test belongs, and how the suite proves timing-dependent behavior without a real clock.
Written after spec #26 (Phase 4c) closed the gap between `CONTEXT.md`'s promises and what the E2E
suite actually checked. See `.claude/skills/testing-patterns/SKILL.md` for the day-to-day patterns;
this file is about the boundary between layers and the coverage-manifest convention that keeps it
honest.

## The three layers

- **Vitest unit** — pure `src/lib/` logic: the typing engine, chunking, ingestion cleaning. No
  Supabase, no DOM, no browser. TDD-first per
  [ADR-0009](../adr/0009-vitest-playwright-testing.md): the failing test comes before the
  implementation, never after.
- **Vitest component** — Testing Library against a mocked Supabase client. For component-level
  rendering and interaction logic that doesn't need a real browser or a real backend — a chainable
  mock factory stands in for `SupabaseClient`.
- **Playwright E2E** — two shapes, both real:
  - **Browser E2E**: a real browser against the real local Supabase stack, for user-facing flows.
  - **Database-level E2E**: no page ever opened — assertions driven straight through `supabase-js`
    against the real local stack. This exists for behavior that is genuinely end-to-end (real RLS,
    real triggers, real schema) but has no meaningful browser interaction to drive: `rls.e2e.ts`,
    `resume-rpc.e2e.ts`, and now `catalog-integrity.e2e.ts` (spec #26, G1 — published book content
    stays within the typeable character set, checked via an anon client).

If a behavior can be proven without a browser, prove it without one — a database-level E2E spec
runs faster and fails closer to its actual cause than a browser spec exercising the same table.

## The coverage-manifest convention

`e2e/coverage-manifest.json` is a flat audit: one entry per CONTEXT.md glossary promise, each
`{ id, glossaryTerm, status, ... }`. A spec that introduces a new glossary promise — CONTEXT.md
gaining a new user-observable behavior — adds a manifest entry in the same PR:

- `"covered"`, with at least one `citations` entry (`{ file, testTitleContains }`) pointing at a
  real E2E spec and a real test title, or
- `"deferred"`, with a non-empty `reason` explaining why E2E isn't where that promise belongs.

Never left implicit. `scripts/check-e2e-coverage.js` is the enforcement mechanism, wired into CI as
the "E2E coverage floor" step right after "i18n key parity (EN/ES)". It checks citation existence
(the file exists under `e2e/`) and a plain substring match against the file's contents — not full
AST parsing, the same "good enough, catches drift" bar `check-i18n-parity.js` sets for itself. That
is enough to catch the one failure mode a comment-only audit can't: a citation that was true the day
it was written and went stale — a test renamed, a file moved, a `test.skip` swapped in — with
nobody noticing because nothing re-checked it.

## Deterministic-wait idioms

No arbitrary sleeps, ever. Every wait in the suite resolves against a real signal:

- **Held-request gate.** Route the relevant fetch through `page.route`, hold it open on a promise
  the test controls, assert the in-flight behavior, then release it. Used for prefetch and stall
  behavior in `e2e/windowed-reading.e2e.ts`.
- **`expect.poll` over a DB read.** For state that lands in Postgres asynchronously (buffered
  attempts draining, a write landing after reconnect), poll a `supabase-js` read rather than
  waiting a fixed duration.
- **Playwright's `page.clock`** for simulating elapsed time with zero real wall-clock cost.
  `page.clock.install()` then `page.clock.fastForward(...)` advances every `Date.now()` read live
  in the page — this only works because the engine stamps keystrokes and window events from
  in-page `Date.now()`, never from a value computed once at test setup. Reference example:
  `e2e/windowed-reading.e2e.ts`, "a long stall in awaiting does not decay the cumulative WPM once
  typing resumes" (spec #26, G4) — five simulated minutes of `awaiting` stall, real typing time
  unaffected, no real sleep anywhere in the test.
- **MutationObserver "never appeared" watches.** A plain post-hoc assertion can't distinguish "never
  happened" from "happened and left before I checked." `windowed-reading.e2e.ts`'s
  `watchForAwaiting`/`awaitingSightings` helpers install a `MutationObserver` before the first
  keystroke and count every time the awaited element enters the DOM, so a transient appearance
  can't slip past a final "not visible" check.

When a new spec needs to wait on something timing-related, reach for one of these four before
reaching for anything else. If none fits, that's worth raising rather than falling back to a sleep.
