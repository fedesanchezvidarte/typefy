# Typefy — CONTEXT

A typing web app whose core engagement is **writing and "reading" long texts at the same time**. The
user types a text while seeing live feedback on hits and misses; progress can be saved and synced across
devices.

Portfolio project, free, following professional industry standards.

## Status

In active development. Phase 0 is complete (spec #3): SvelteKit + TS scaffold, Tailwind v4,
Vitest/Playwright harnesses, Paraglide EN/ES (`/` = EN, `/es` = ES), CI, and production deploy on
Vercel. Phase 1 (spec #5) delivers the typing engine over hardcoded fixture texts.

Phased roadmap:

- **Phase 0** — ✅ Scaffolding + baseline i18n: SvelteKit+TS, Tailwind, Vitest/Playwright,
  ESLint/Prettier, Paraglide EN/ES wired from the start, empty deploy to Vercel + CI.
- **Phase 1** — Typing engine (TDD) over hardcoded text. The core of the product.
- **Phase 2** — Supabase + Auth + early progress sync, against 1 manually seeded book.
- **Phase 3** — Ingestion pipeline + catalog of 10-20 books read from the database.
- **Phase 4** — Game modes + polish + E2E coverage.

## Glossary

Use these terms as defined here; do not drift to synonyms.

- **Typeable text** — Unit of content the user types. Central domain abstraction: today a **book** (or
  fragments/quotes), later custom text. The whole model is built on this abstraction, not specifically
  on "book".
- **Book** — Typeable text from a public-domain source (Project Gutenberg in English, Cervantes Virtual
  or another in Spanish). Has metadata (title, author, language, cover).
- **Chunk** — Atomic unit of a typeable text and of progress. A text is split into chunks **by paragraphs
  with a size target** (~400-600 characters, never cutting a sentence). Book progress = completed chunks
  / total.
- **Character state** — Each character in a chunk is in one of: `pending`, `correct`, `corrected`,
  `incorrect`.
- **Corrected (yellow)** — A character that was mistyped and then fixed with backspace. Visually
  resolved, but **counts as an error** in accuracy.
- **Completed chunk** — A chunk completes the instant no character is `pending` or `incorrect`: the
  `corrected` state satisfies completion (it is visually resolved) while still counting as a miss in
  accuracy. You can advance with visible errors (red), but not complete.
- **First-attempt record** — The outcome (hit/miss) of the first time a character position is judged.
  Immutable once set: backspacing and retyping never rewrite it. Drives Accuracy (raw).
- **Keystroke log** — Ordered record of every keystroke (typed character or backspace) with its
  timestamp. The single source of truth for metrics: every metric is computable over an arbitrary
  slice of the log (word / chunk / session).
- **WPM** — Words per minute, measured over the chunk's time. Gross WPM = (typed characters ÷ 5) ÷
  elapsed minutes; backspaces do not count as typed characters. Always displayed alongside accuracy.
- **Accuracy (raw)** — First-attempt correct characters / total characters. The `corrected` state counts
  as a miss even though it is visually resolved.
- **Normal mode** — Tracks WPM + accuracy, with live metrics (update granularity configurable by
  word / line / page; default: word).
- **Zen mode** — No WPM/accuracy tracking; only text completion %.
- **Session** — Short typing stretch (one or a few chunks). Long texts are consumed in mini sessions, not
  in one sitting.
- **Ingestion** — Offline process that downloads a public-domain text, cleans the source header/footer,
  normalizes, splits into paragraphs → chunks and seeds the database. Reusable to add new books without a
  redeploy. The paragraph-grouping chunker is built here (Phase 3), TDD from its day one (ADR-0009's
  "chunking TDD from day one" reads as day one of that module); Phase 1 fixture texts are chunked by
  hand.
- **Progress / sync** — Per-user progress state (completed chunks, WPM, accuracy). Persisted in the
  database and protected with Row Level Security; each user sees only their own.

## Decisions (ADRs)

- [ADR-0001](docs/adr/0001-sveltekit-typescript.md) — SvelteKit + TypeScript as the framework
- [ADR-0002](docs/adr/0002-supabase-backend.md) — Supabase for backend, auth and database
- [ADR-0003](docs/adr/0003-vercel-hosting.md) — Vercel for hosting
- [ADR-0004](docs/adr/0004-typing-engine-model.md) — Typing engine model
- [ADR-0005](docs/adr/0005-paragraph-chunking.md) — Paragraph-based chunking with a size target
- [ADR-0006](docs/adr/0006-books-chunks-data-model.md) — `books` + `chunks` data model and offline ingestion
- [ADR-0007](docs/adr/0007-paraglide-i18n.md) — Paraglide for EN/ES internationalization
- [ADR-0008](docs/adr/0008-tailwind-styling.md) — Tailwind CSS for styling
- [ADR-0009](docs/adr/0009-vitest-playwright-testing.md) — Vitest + Playwright, TDD on the engine
