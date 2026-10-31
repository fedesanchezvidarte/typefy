# Typefy

A typing web app where you **type your way through real books**. Every keystroke gets live feedback,
and your progress is saved and synced across devices, so finishing a book means you've both typed and
read it.

**Live app:** [typefy.vercel.app](https://typefy.vercel.app)

> **Status:** Phases 0–5 shipped: typing engine, Supabase backend and auth, progress sync, ingestion
> pipeline with a 12-book catalog, game modes, E2E coverage, and the page and chapter model. Now in
> polish. See [`CONTEXT.md`](CONTEXT.md) for the detailed status and domain glossary.

## Concept

Most typing trainers throw random words at you. Typefy turns typing practice into reading a book. A
public-domain book is split into screen-sized **pages** that keep the source's paragraph breaks. You
type one page at a time, pick up where you left off, and can jump to any chapter.

## Features

- **Type through public-domain books.** A catalog of 12 books (6 English, 6 Spanish) with search,
  sort and a language filter. Each book has a detail screen with its chapters, year and summary.
- **Live typing feedback.** Tonal, not chromatic: pending text is dimmed, correct text fills in at full
  strength, and an active mistake is the only colour on the page. A page completes only when every
  mistake is fixed, and a fixed mistake still counts against accuracy.
- **Book-like typing screen.** The page sits still while you type, with a teleprompter-style scroll
  near the bottom ([ADR-0016](docs/adr/0016-teleprompter-scroll.md)).
- **Metrics and modes.** **Normal** mode tracks WPM and accuracy. **Zen** mode tracks only completion.
- **Theming.** Four colour palettes and three reading fonts, switchable independently
  ([ADR-0011](docs/adr/0011-two-axis-theming.md)). Every palette meets WCAG AA contrast.
- **Optional Google login.** The app works without an account. Signing in syncs progress across
  devices, including completions made as a guest before signing in.
- **Bilingual UI.** English and Spanish, independent of the language of the book you're typing.

_Not yet built: custom text mode, accent strictness modes, achievements, and keyboard-layout selection._

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

- **Data model.** `books` (catalog metadata), `chunks` (page text, loaded in windows on demand) and
  `chapters` (structure derived at ingestion), all in Supabase with Row Level Security.
- **Ingestion.** An offline script (`scripts/ingest.ts`) downloads a public-domain text, strips source
  headers and footers, normalizes it to a typeable character set, splits it into pages, derives
  chapters, and seeds the database. Adding a book is a script run, not a redeploy.
- **Typing engine.** A hidden input rendering per-character spans, not a `<textarea>`. Text is read
  from `beforeinput`/`input` events, so dead-key and IME composition yield the final composed
  character ([ADR-0004](docs/adr/0004-typing-engine-model.md)). This is the core of the product and the
  most heavily tested part.

## Testing

Testing is treated as a first-class feature:

- **Unit (Vitest).** The typing engine, metrics, chunking and ingestion are pure logic built
  test-first.
- **End-to-end (Playwright).** Typing flows, progress sync, Row Level Security, accessibility and
  catalog integrity.
- **Coverage gate.** A CI check keeps every promise in the [`CONTEXT.md`](CONTEXT.md) glossary cited
  against a real E2E test.
- **Repo guards.** CI also checks EN/ES message parity and that applied database migrations are never
  edited.

See [ADR-0009](docs/adr/0009-vitest-playwright-testing.md) for the testing strategy.

## Roadmap

| Phase | Goal                                                                 | Status |
| ----- | -------------------------------------------------------------------- | ------ |
| **0** | Scaffolding + baseline i18n, empty deploy to Vercel + CI             | ✅     |
| **1** | Typing engine (TDD) over hardcoded text                              | ✅     |
| **2** | Supabase + Auth + progress sync against seeded books                 | ✅     |
| **3** | Ingestion pipeline + catalog of 12 books                             | ✅     |
| **4** | Game modes + polish + E2E coverage                                   | ✅     |
| **5** | Page model, chapters, book detail screen and book-like typing screen | ✅     |

## Development

Requires **Node 22** and **npm**.

```bash
npm install
npm run dev
```

The full guide covers every command, the local Supabase stack in Docker, Google OAuth, schema
migrations and troubleshooting: [`docs/development.md`](docs/development.md).

## Project documentation

- [`CONTEXT.md`](CONTEXT.md): project overview, domain glossary, and status
- [`docs/adr/`](docs/adr/): architecture decision records
- [`docs/development.md`](docs/development.md): local setup and workflow
- [`CLAUDE.md`](CLAUDE.md): agent workflow conventions (issue tracker, triage labels, domain docs)

## License

TBD.
