# ADR-0009 — Vitest + Playwright, TDD on the engine

**Status:** Accepted

## Context

The owner is a QA Automation Engineer: testing is the project's differentiator in the portfolio, not an
extra. The typing engine, metrics computation, chunking and the ingestion cleaner are pure logic with
subtle cases (accents, `ñ`, backspace, correction→yellow).

## Decision

- **Vitest** + Testing Library for unit/component. **TDD from day one on the typing engine** and its
  associated logic (per-character state machine, WPM/accuracy, chunking, ingestion cleaner).
- **Playwright** for E2E, entering as soon as the first end-to-end typeable flow exists.
- Do not test the trivial UI shell at the start.
- Testing is treated as a **first-class portfolio feature**.

## Consequences

- Subtle bugs (accents/`ñ`/dead keys) are caught early.
- Playwright simulates real typing (keydown, backspace, correction) and is a marketable skill in the
  owner's field.
- Official integration of both with SvelteKit ([ADR-0001](0001-sveltekit-typescript.md)).

## Alternatives considered

- **Engine first, tests once it stabilizes** — Rejected: loses the portfolio value and exposes the engine
  to regressions in its most delicate part.
