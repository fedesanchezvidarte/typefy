# ADR-0003 — Vercel for hosting

**Status:** Accepted

## Context

SvelteKit ([ADR-0001](0001-sveltekit-typescript.md)) uses **adapters** depending on the deploy target, so
the hosting choice is not indifferent. The owner already uses Vercel in another project and has a
workflow based on GitHub Issues/PRs.

## Decision

Deploy on **Vercel** with `adapter-vercel`.

## Consequences

- Zero friction: already-known platform, deploy on git push.
- Preview deployments per PR, which fit the existing Issues/PRs workflow.
- SvelteKit + Supabase + Vercel combination is well supported.
- Supabase and Vercel are separate services (database in one, hosting in the other): two dashboards,
  standard setup.
- A **Vercel cron** will be added to avoid the Supabase free-tier inactivity pause (see
  [ADR-0002](0002-supabase-backend.md)).

## Alternatives considered

- **Cloudflare Pages** — More generous free tier and edge by default, but the workers runtime adds quirks
  and another new thing to learn.
- **Netlify** — Equivalent to Vercel, with no clear advantage.
