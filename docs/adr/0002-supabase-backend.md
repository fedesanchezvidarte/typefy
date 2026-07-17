# ADR-0002 — Supabase for backend, auth and database

**Status:** Accepted

## Context

The MVP needs: Google login (optional, enables saving progress), a database for the catalog and per-user
progress, and data isolation between users. The owner already uses Supabase in another project. The
chosen framework is SvelteKit ([ADR-0001](0001-sveltekit-typescript.md)), where the new learning is
already concentrated.

## Decision

Use **Supabase**: Postgres + Auth (Google OAuth) + Row Level Security (RLS).

## Consequences

- Official SvelteKit library (`@supabase/ssr`); Google login in a few steps.
- RLS solves "each user sees only their own progress" in the database, not in app code.
- Being an already-known piece, it frees the learning focus for Svelte (avoids two new fronts).
- Generous free tier for a portfolio (~1,000-2,000 books in 500 MB with TOAST compression; bandwidth is
  not a bottleneck for text content).
- Free-tier gotcha: projects pause after ~7 days of inactivity → mitigated with a **Vercel cron** that
  keeps the database active (a pattern the owner already uses in another project).

## Alternatives considered

- **Raw Postgres + Auth.js** — More control and learning auth from the ground up, but reinvents what
  Supabase provides out of the box and scatters the focus.
- **PocketBase / Turso / other BaaS** — Elegant, but add another unfamiliar piece against the principle
  of not overreaching.
