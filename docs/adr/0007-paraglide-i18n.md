# ADR-0007 — Paraglide for EN/ES internationalization

**Status:** Accepted

## Context

The UI must be in English and Spanish **from day one** (book content is not translated). Writing the
message files from the start avoids debt. Additional requirement: the app opens in the browser's language
and respects a persisted manual change. Regional formats (numbers, dates) barely apply and are handled
with the native `Intl` API, independent of the library.

## Decision

Use **Paraglide JS** (inlang) for EN/ES i18n.

- Messages are **compiled** into tree-shakeable TypeScript functions → full type safety (missing key =
  compile error) and minimal runtime.
- Per-language routing (`/es`, `/en`).
- Language priority: **saved preference > browser language > default**. Persisted in a cookie (guest) and
  in the Supabase profile (logged in), to respect it across devices.
- Wired from **Phase 0**, even with little text.

## Consequences

- Missing translations are caught at build time, not in production (fits the owner's QA profile).
- Idiomatic approach in SvelteKit; per-language routing handled.
- Small learning cost, on the good-practices side.

## Alternatives considered

- **svelte-i18n** — Classic, ICU format, runtime-based; less type-safe and no longer recommended for new
  projects.
- **typesafe-i18n** — Type-safe too, but more verbose and with less traction than Paraglide.
