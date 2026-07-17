---
name: lib-patterns
description: "Patterns for Typefy core logic in src/lib/ — the pure typing engine, metrics, chunking, and Supabase-aware services. Use when writing or modifying anything under src/lib/."
---

# Lib Patterns Skill

> **Living document.** The codebase is in the bootstrapping phase; paths below are the agreed layout. As real modules land (Phase 1+), refine this skill with concrete examples instead of letting it drift.

## Layout

```
src/lib/
  engine/          → pure typing engine (ADR-0004): state machine, metrics
  chunking/        → paragraph chunking with size target (ADR-0005); shared with scripts/ingest.ts
  server/          → server-only services (Supabase access); SvelteKit blocks client imports
  types.ts         → shared domain types
  database.types.ts→ generated Supabase types (never hand-edit)
```

## The two-tier rule

1. **Pure modules** (`engine/`, `chunking/`): plain TypeScript. No DOM, no Supabase, no SvelteKit imports (`$app/*`, `$env/*`). Deterministic: same input → same output; time is injected, never read from `Date.now()` inside the logic.
2. **Services** (`server/`): receive a `SupabaseClient` as the **first parameter** — they never create their own client. They orchestrate pure modules + persistence and are mocked in unit tests.

Routes call services; services call pure modules; pure modules call nothing above them.

## Engine conventions (ADR-0004)

- Character states: `'pending' | 'correct' | 'corrected' | 'incorrect'` — use these exact names, mirroring the glossary.
- The state machine is **event-driven**: it consumes typed events (`keypress`, `backspace`) and returns new state. Rendering (spans, colors) lives in the UI layer, never in the engine.
- A chunk completes only when **every** character is `correct`. `corrected` (yellow) is visually resolved but still blocks nothing — it just counts as a miss in raw accuracy.
- **Accuracy (raw)** = first-attempt correct / total. **WPM** over the chunk's time span (injected timestamps).
- Watch the delicate cases from day one: accents, `ñ`, dead keys, IME input, backspace across corrected characters.
- Zen mode: the engine still tracks character states (completion needs them) but WPM/accuracy computation is skipped/ignored.

## TDD (ADR-0009 — non-negotiable for engine code)

Engine, metrics, chunking, and the ingestion cleaner are built test-first: write the failing Vitest test, make it pass, refactor. Never write engine logic ahead of its test. See the `testing-patterns` skill.

## General conventions

- Named exports only; no default exports.
- One module = one responsibility; prefer deep modules with small interfaces over many shallow helpers.
- Errors: pure modules throw typed errors or return discriminated unions — never `console.log` and continue. Services translate DB errors into typed results for routes to handle.
- Use glossary vocabulary in names: `chunk`, `characterState`, `session` — not `segment`, `letterStatus`, `run`.

## Anti-Patterns

- DOM or Supabase imports inside `engine/` or `chunking/`.
- Services creating their own Supabase client instead of receiving one.
- Reading the clock inside metric computation (kills determinism and testability).
- Hard-wiring "book" where "typeable text" is the abstraction.
- Writing engine code without a failing test first.
