# ADR-0001 — SvelteKit + TypeScript as the framework

**Status:** Accepted

## Context

Typefy is ~90% a client-side interactive app; SSR/SEO only helps on the landing and catalog. Technically
almost any framework works, so the decision weighs learning and portfolio signal more than technical
necessity.

The owner already has a Next.js + TS + Supabase + Vercel project in their portfolio, comes from Kotlin +
Jetpack Compose, and uses Vite at work as a QA Automation Engineer. Stated goal: learn a new paradigm in
depth **without spreading thin** ("bite off more than you can chew").

## Decision

Use **SvelteKit + TypeScript**.

## Consequences

- A single deep learning effort (Svelte) instead of a second project on an identical stack; shows range
  in the portfolio.
- Strong fit with the app type: high interactivity (per-character typing engine) and animations —
  language-native transitions + `svelte/motion`.
- Real knowledge transfer: Compose's reactivity (state/recomposition) is conceptually close to Svelte's
  runes (`$state`/`$derived`).
- Assumed trade-off: fewer examples and lower job-market traction than React; offset by AI assistance,
  which reduces exactly the syntax/examples cost.
- The typing engine lives in a client component; SvelteKit does not get in the way.

## Alternatives considered

- **Next.js + TS** — Industry standard and already mastered by the owner, but a second project on the
  same stack adds consistency, not range; and the goal was to learn something new.
- **Vite + React (SPA)** — Simple, but lower portfolio signal and no learning advantage over what's
  already known.
