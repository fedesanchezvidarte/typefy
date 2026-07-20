# Typefy

A typing web app whose core engagement is **writing and "reading" long texts at the same time**. You
type through real books, seeing live feedback on every keystroke, and your progress is saved and synced
across devices.

> **Status:** Phase 0 in progress — project scaffold, baseline EN/ES i18n, testing harnesses, CI and
> Vercel deploy. The stack and roadmap are locked in (see [`CONTEXT.md`](CONTEXT.md) and the
> [ADRs](docs/adr/)); the typing engine (Phase 1) is next.

## Concept

Most typing trainers throw random words at you. Typefy turns typing practice into reading a book: the
central unit is a **typeable text** (today a public-domain book, later custom text), split into
paragraph-sized **chunks** you complete one short session at a time. Finish enough chunks and you've
typed — and read — the whole book.

## Features (MVP scope)

- **Type through public-domain books** — English (Project Gutenberg) and Spanish (Cervantes Virtual and
  similar sources).
- **Live typing feedback** — per-character states: correct (green) and incorrect (red). Only current
  mistakes are highlighted; a fixed error renders like a correct character but still counts against
  accuracy. A chunk only completes when every mistake has been fixed.
- **Metrics** — WPM and raw accuracy, with live updates (by word / line / page).
- **Game modes** — **Normal** (tracks WPM + accuracy) and **Zen** (no tracking, just completion %).
- **Google login (optional)** — the app works without an account; signing in enables cross-device
  progress sync.
- **Bilingual UI** — English and Spanish, with browser-language detection and a persisted preference.

_Deferred beyond the MVP: custom text mode, accent strictness modes (hardcore vs relaxed), achievements,
and keyboard-layout selection._

## Tech stack

| Layer               | Choice                                                         |
| ------------------- | -------------------------------------------------------------- |
| Framework           | SvelteKit + TypeScript                                         |
| Backend / Auth / DB | Supabase (Postgres + Google OAuth + Row Level Security)        |
| Hosting             | Vercel                                                         |
| i18n                | Paraglide (EN/ES)                                              |
| Styling             | Tailwind CSS (+ Svelte scoped CSS for the engine & animations) |
| Testing             | Vitest (unit / TDD) + Playwright (E2E)                         |

Every choice is documented with its context, trade-offs and alternatives in the
[Architecture Decision Records](docs/adr/).

## Architecture at a glance

- **Data model** — `books` (lightweight metadata, feeds the catalog) and `chunks` (text content, loaded
  on demand per book), both in Supabase.
- **Ingestion** — an offline script (`scripts/ingest.ts`) downloads a public-domain text, strips source
  headers/footers, normalizes it, splits it into paragraph chunks, and seeds the database. Adding a book
  is a script run, not a redeploy.
- **Typing engine** — a hidden input + `keydown` listener rendering per-character spans (not a
  `<textarea>`). This is the core of the product and the most heavily tested part.

## Testing

Testing is treated as a first-class feature, not an afterthought. The typing engine, metrics, chunking,
and ingestion cleaner are pure logic built **test-first** with Vitest; Playwright covers end-to-end
typing flows (keydown, backspace, correction, accents). See
[ADR-0009](docs/adr/0009-vitest-playwright-testing.md).

## Roadmap

| Phase | Goal                                                          |
| ----- | ------------------------------------------------------------- |
| **0** | Scaffolding + baseline i18n, empty deploy to Vercel + CI      |
| **1** | Typing engine (TDD) over hardcoded text — the core            |
| **2** | Supabase + Auth + early progress sync against one seeded book |
| **3** | Ingestion pipeline + catalog of 10-20 books                   |
| **4** | Game modes + polish + E2E coverage                            |

## Development

Requires **Node 22** (see `engines` in `package.json`) and **npm**.

```bash
npm install
npm run dev
```

| Command              | Purpose                               |
| -------------------- | ------------------------------------- |
| `npm run dev`        | Start the dev server                  |
| `npm run build`      | Production build (`adapter-vercel`)   |
| `npm run preview`    | Preview the production build          |
| `npm run check`      | Type check with `svelte-check`        |
| `npm run lint`       | Prettier check + ESLint               |
| `npm run format`     | Format with Prettier                  |
| `npm run test:unit`  | Vitest (node + browser-mode projects) |
| `npm run test:e2e`   | Playwright end-to-end tests           |
| `npm run check:i18n` | EN/ES message key parity check        |

CI (GitHub Actions) runs the parity check, lint, type check, unit tests and E2E on every PR to
`main` and push to `main`, on Node 22. Deploys go out via Vercel on push to `main`, with preview
deployments per PR.

### i18n

The UI is bilingual (EN/ES) with Paraglide. The URL is authoritative: `/` serves English,
`/es` serves Spanish. On a first visit to an unprefixed URL the server negotiates
cookie > `Accept-Language` > English. The UI locale governs interface strings only — the
language of typeable text content is data and fully independent of the UI language.

## Project documentation

- [`CONTEXT.md`](CONTEXT.md) — project overview, domain glossary, and status
- [`docs/adr/`](docs/adr/) — architecture decision records
- [`CLAUDE.md`](CLAUDE.md) — agent workflow conventions (issue tracker, triage labels, domain docs)

## License

TBD.
