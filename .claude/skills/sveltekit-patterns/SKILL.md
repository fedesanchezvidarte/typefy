---
name: sveltekit-patterns
description: "SvelteKit conventions for Typefy: routes, load functions, form actions, server endpoints, and Supabase SSR integration. Use when writing or modifying anything under src/routes/ or hooks."
---

# SvelteKit Patterns Skill

> **Living document.** Written during bootstrapping from the agreed stack (ADR-0001, ADR-0002). Refine with concrete examples as routes land in Phase 0-2.

> **Scope.** This skill covers Typefy-specific conventions (routing layout, data flow, Supabase SSR, the typing view). For core Svelte 5 syntax — runes, snippets, events, effects — defer to the vendored official skills `svelte-core-bestpractices` and `svelte-code-writer` (which also exposes `npx @sveltejs/mcp` for docs lookup and autofixing). Don't guess at runes here.

## Routing layout

```
src/routes/
  +layout.svelte           → app shell (nav, theme)
  +layout.server.ts        → session/user load for all pages
  +page.svelte             → landing
  books/                   → catalog (Phase 3)
  type/[...]/              → the typing view (Phase 1: hardcoded text; Phase 2+: chunks from DB)
  auth/                    → Supabase auth callback routes (Phase 2)
```

(Adjust as real routes are created — then update this skill.)

## Data flow rules

- **Load functions** (`+page.server.ts` / `+layout.server.ts`) fetch data; components never fetch on mount for initial render.
- **Form actions** for mutations where a form fits; `+server.ts` JSON endpoints for programmatic calls (e.g. progress sync during a session).
- Routes are **thin**: parse/validate input, call a `src/lib/server/` service, shape the response. Business logic lives in `src/lib/` (see `lib-patterns`).
- Validate inputs at the boundary and return typed errors (`fail(400, ...)` in actions, proper status codes in endpoints).

## Supabase integration (ADR-0002)

- Use `@supabase/ssr`: client created per-request in `hooks.server.ts`, exposed via `event.locals` (typed in `src/app.d.ts`).
- Auth: Google OAuth via Supabase. Get the session server-side; **never trust client-provided user ids** — progress rows use the authenticated `user_id`.
- Env vars: `PUBLIC_SUPABASE_URL` + publishable key via `$env/static/public`; any secret (service role for scripts only) stays out of the app entirely.
- RLS is the real gate: routes may filter, but per-user isolation is enforced by policies, not by route code.

## Typing view specifics (ADR-0004)

- Input capture: hidden input + `keydown` listener — **not** a real `<textarea>`. The route/page wires DOM events to the pure engine and renders the resulting character states.
- Progress sync (Phase 2+): persist at chunk completion (and session end), not on every keystroke.

## i18n (ADR-0007)

- All user-facing strings go through Paraglide messages — EN and ES from day one, added in the same change.
- No hardcoded UI strings in routes or components; the i18n gate checks key parity.

## Anti-Patterns

- Business logic inside `+page.server.ts` or `+server.ts` instead of `src/lib/`.
- Client-side Supabase queries for data a load function should provide.
- Trusting a `user_id` from the request body.
- Adding an EN string without its ES counterpart.
- Using a `<textarea>` for the typing surface.
