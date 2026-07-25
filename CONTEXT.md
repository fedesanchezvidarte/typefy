# Typefy — CONTEXT

A typing web app whose core engagement is **writing and "reading" long texts at the same time**. The
user types a text while seeing live feedback on hits and misses; progress can be saved and synced across
devices.

Portfolio project, free, following professional industry standards.

## Status

In active development. Phase 0 (spec #3) and Phase 1 (spec #5) are complete: the SvelteKit + TS
scaffold, Tailwind v4, Vitest/Playwright harnesses, Paraglide EN/ES (`/` = EN, `/es` = ES), CI and
Vercel deploy; and the typing engine over hardcoded fixture texts. Phase 2 is split into **2a**
(spec #7 — Supabase foundation, auth, and typeable text served from the database; fixtures leave the
runtime path, no progress persisted yet) and **2b** (progress sync). 2a's database foundation —
schema, RLS, and both books seeded on the local stack and the hosted project — is in place; auth and
the content-from-database routes are in progress.

Phased roadmap:

- **Phase 0** — ✅ Scaffolding + baseline i18n: SvelteKit+TS, Tailwind, Vitest/Playwright,
  ESLint/Prettier, Paraglide EN/ES wired from the start, empty deploy to Vercel + CI.
- **Phase 1** — Typing engine (TDD) over hardcoded text. The core of the product.
- **Phase 2** — Supabase + Auth + early progress sync, against seeded books. Split into **2a**
  (foundation, auth, typeable text from the database — spec #7) and **2b** (progress sync). Seeding
  both Phase 1 fixtures (EN + ES) keeps the UI-locale-vs-content-language independence verifiable.
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
  / total. Presented to users as a **passage**.
- **Passage** — The user-facing name for a chunk (`pasaje` in the ES UI). `chunk` stays the term in
  code, schema, engine and tests; the UI never says "chunk" — and never "page", which would be a false
  claim about the book's real pagination. Paraglide keys use `passage_*`.
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
- **Accuracy (raw)** — First-attempt correct characters ÷ the first-attempt characters actually judged
  (the positions reached so far), **not** ÷ the chunk's total length. The two agree once a chunk is
  complete but diverge mid-chunk: a total-length denominator would render live accuracy as ~5% at the
  first keystroke. The `corrected` state counts as a miss even though it is visually resolved.
  (Implemented in `src/lib/engine/metrics.ts`.)
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
- **Progress / sync** — Per-user progress persisted in Supabase under Row Level Security (each user
  sees only their own). The store is an append-only history of **chunk attempts** (the source of truth)
  plus rolled-up per-chunk and per-book tables for cheap reads
  ([ADR-0010](docs/adr/0010-progress-data-model.md)). Written from Phase 2b; the 2a schema creates the
  tables but leaves them empty.
- **Chunk attempt** — One traversal of one chunk from first keystroke to completion. The atomic unit of
  persisted progress: each completed attempt appends an immutable row (gross WPM, accuracy, elapsed) to
  the history. Distinct from **Session** (a typing stretch of one or more chunks) and from the engine's
  in-memory session state.
- **Profile** — A signed-in user's identity row (display name, avatar, optional locale preference),
  created automatically on first sign-in and readable/editable only by that user. A null `locale` means
  "no explicit preference", leaving the cookie > `Accept-Language` > EN detection to apply.
- **Palette** — One axis of the two-axis theming model (ADR-0011): a pure colour-token record (bg,
  sheet, fg, dim, muted, border, accent, error, errorTint, caret + light/dark scheme) that never
  assumes a typeface. Launch set: warm-light (default), cool-light, soft-dark, near-black. Defined in
  `src/lib/theme/palettes.ts`, painted by `src/routes/layout.css`.
- **Font family** — The other theming axis: type and only type (sans / serif / mono — IBM Plex,
  self-hosted), never assuming a background. Optically matched by the superfamily's shared metrics, so
  switching family never reflows the passage.
- **Sheet** — The typing surface's own page region: `sheet` background one step off `bg`, minimal
  border, generous padding. The passage renders on it **tonally**: pending = dim, correct/corrected =
  full foreground, incorrect = the only chromatic event (error + tint + wavy underline). No green.
- **Guest** — A visitor who is not signed in. Types fully (content is world-readable) but no progress is
  saved, and there is no anonymous account. Signing in is optional and only unlocks progress persistence.

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
- [ADR-0010](docs/adr/0010-progress-data-model.md) — Progress data model: append-only attempts + rollups
- [ADR-0011](docs/adr/0011-two-axis-theming.md) — Two-axis theming: palettes as data, fonts as data
