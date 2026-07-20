---
name: testing-patterns
description: "Testing patterns for Typefy: Vitest unit/component tests, TDD on the typing engine, Supabase mocking, and Playwright E2E. Use when writing or modifying any test, or when implementing engine logic (test-first)."
---

# Testing Patterns Skill

> **Living document.** Written during bootstrapping (ADR-0009). As helpers and real suites land, replace the placeholders with concrete factories and examples.

Testing is a **first-class portfolio feature** of this project (the owner is a QA Automation Engineer). Suites are professional-grade, not an afterthought.

## Test organization

```
src/lib/engine/*.test.ts       → co-located unit tests for pure engine modules
src/lib/chunking/*.test.ts     → chunking + ingestion cleaner tests
src/lib/server/*.test.ts       → service tests with mocked Supabase
tests/e2e/                     → Playwright specs
```

(Co-located `*.test.ts` for pure logic; confirm the final layout at Phase 0 and update this skill.)

## TDD on the engine (ADR-0009 — non-negotiable)

Red → green → refactor for the engine, metrics, chunking, and the ingestion cleaner:

1. Write the failing Vitest test that expresses the behavior (from the spec's acceptance criteria).
2. Write the minimum implementation to pass.
3. Refactor with the test green.

Never write engine logic ahead of its test. The delicate cases are the point — cover them explicitly:

- Accents and `ñ` (both hit and miss), dead keys, IME composition.
- Backspace over `correct`, `incorrect`, and `corrected` characters.
- The `corrected` rule: fixed characters render like `correct` ones (engine state stays `corrected`), still count as misses in raw accuracy.
- Completion: a chunk with any `pending` or `incorrect` character never completes; `corrected` satisfies completion.
- WPM/accuracy with injected timestamps — no real clocks in tests.
- Zen mode: completion works, metrics absent.

## Unit & service tests (Vitest)

- **Pure modules**: import and call directly — no mocks. Deterministic by design (`lib-patterns`).
- **Services**: mock the `SupabaseClient` they receive; a real DB call must never reach a unit test. Build a chainable mock factory in a shared test helper once services exist.
- **Components** (Testing Library): test behavior (what the user sees per engine state), not markup details. Don't test the trivial UI shell (ADR-0009).

## E2E tests (Playwright)

- Enter as soon as the first end-to-end typeable flow exists (Phase 1).
- Simulate **real typing**: `keyboard.press` sequences including mistakes, backspace, and correction — this is the product's core loop and the portfolio showpiece.
- Inspect the live page before writing locators — never guess selectors; prefer accessible roles/labels.
- Cover: type a chunk to completion, make-and-fix errors (yellow state visible), progress persistence after reload (Phase 2+), EN and ES locales.

## Quality standards

| Standard | Rule |
|---|---|
| Deterministic | No sleeps, no real clocks, no real Supabase, no order dependence |
| Fast | Unit tests in milliseconds; E2E in its own suite |
| Readable | A failing test name describes scenario + expected outcome |
| Isolated | Each test owns setup/teardown; no shared mutable state |
| Traceable | Each test maps to a spec acceptance criterion or documented behavior |

## Naming

```typescript
describe("processKeystroke", () => {
  it("marks a mistyped character incorrect and keeps the cursor advancing", () => {});
  it("turns an incorrect character corrected after backspace and retype", () => {});
  it("counts corrected characters as misses in raw accuracy", () => {});
});
```

## Anti-Patterns

- Writing engine logic before its failing test.
- Tautological tests that pass regardless of implementation.
- Skipping/commenting out a flaky test instead of fixing the root cause.
- Real network or DB calls in unit tests; sleep-based waits anywhere.
- Guessed Playwright selectors; brittle text-based locators for translated strings (use roles/test-ids).
