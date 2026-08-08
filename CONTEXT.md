# Typefy — CONTEXT

A typing web app whose core engagement is **writing and "reading" long texts at the same time**. The
user types a text while seeing live feedback on hits and misses; progress can be saved and synced across
devices.

Portfolio project, free, following professional industry standards.

## Status

In active development. Phase 0 (spec #3) and Phase 1 (spec #5) are complete: the SvelteKit + TS
scaffold, Tailwind v4, Vitest/Playwright harnesses, Paraglide EN/ES (`/` = EN, `/es` = ES), CI and
Vercel deploy; and the typing engine over hardcoded fixture texts. Phase 2 is split into **2a**
(spec #7 — Supabase foundation, auth, and typeable text served from the database), **2b**
(spec #12 — progress sync) and **2c** (spec #15 — local attempt buffer), and all three are complete:
the database foundation, auth, and content-from-database routes shipped in 2a; 2b closes the loop —
completed passages are written to Supabase, resumed on return, and shown as book-lifetime completion
on the library card and the typing screen; 2c stops losing the two completions 2b dropped — a
guest's and a transiently failed write's are held in the local **attempt buffer** and drained into
`chunk_attempts` once a valid session exists.

Phase 3 is complete. **3a** (spec #17) built the offline **ingestion** pipeline, the book
**manifest**, the committed **ingestion reports**, the **typeable character set**
([ADR-0013](docs/adr/0013-typeable-character-set.md)) and **publication gating** — plus a
deliberately short three-chunk fixture book for the edges 3b needed. **3b** (spec #18) replaced the
whole-book read that kept 3a's two full-length books **unpublished**: text is now delivered in
**windows** through a public chunks endpoint, resume is computed in the database, the engine gained
an **awaiting** state, and the landing hero reads a **featured book**. **3c** (spec #19) closed the
phase: the catalog reaches its target 12 books (6 `en` / 6 `es`), six of them carrying supplied
**cover** art in the `covers` Storage bucket and the rest rendering the generated typographic
cover; the library gained a server-side **language filter** and a **continue reading** section for
signed-in users.

Phase 4 is split into **4a** (spec #24 — mode as the measurement axis), **4b** (spec #25 — polish:
palette contrast, catalog search and sort, accessibility sweep) and **4c** (spec #26 — E2E coverage
audited against this glossary, with a CI floor). **4a** is complete and opens the phase: **mode** is
now a first-class concept the engine, the schema and the persistence layer all carry, measurement is
scoped to the **measured span** rather than to one whole passage, and **Zen mode** finally means what
this glossary has promised since Phase 0 — a Zen passage derives, displays and persists no WPM and no
accuracy. **4b** is also complete: every foreground token across all four palettes now clears WCAG AA
against both `bg` and `sheet`, closing #21; the library gained server-resolved **search** and
**sort**, composing with the **language filter**; and an accessibility sweep across all four screens
removed the `color-contrast` axe carve-out for good. Phase 4 is now complete: **4c** (spec #26)
audited this glossary against the E2E suite and closed the five gaps the audit found — **G1** a
database-level regression guard that published book content stays within the **typeable character
set**, **G2** a sub-100-character measured span typed for real never sets a **personal best**, **G3**
"Zen progress is progress" proven through the library card and a reload rather than only at the
trigger level, **G4** a long `awaiting` stall no longer decays cumulative WPM, and **G6** a
`cover_url` that fails to load falls back to the generated cover — plus a CI **coverage-manifest**
gate that keeps every glossary promise honestly cited against a real E2E test going forward.

Phase 5 is in progress. **5a** (spec #30 — header, landing and library polish) narrows the font
axis to **reading font**, scoped to book text only (the typing screen's passage and the landing
hero's passage) rather than the whole app, and swaps its three faces from IBM Plex to
Roboto/Roboto Serif/Roboto Mono, dropping the optical-matching/no-reflow guarantee that swap can
no longer make (ADR-0011's Phase 5a amendment); the header gains an icon-based pencil panel
(reading font / palette / interface language) and an account menu, the landing headline and
library sub-copy are trimmed, and a `/profile` stub route lands. Implementation and this glossary
update are done; **QA sign-off for spec #30 had not yet landed in the issue as of this writing** —
treat this Phase 5a entry as pending confirmation until that lands.

Phased roadmap:

- **Phase 0** — ✅ Scaffolding + baseline i18n: SvelteKit+TS, Tailwind, Vitest/Playwright,
  ESLint/Prettier, Paraglide EN/ES wired from the start, empty deploy to Vercel + CI.
- **Phase 1** — ✅ Typing engine (TDD) over hardcoded text. The core of the product.
- **Phase 2** — ✅ Supabase + Auth + progress sync, against seeded books. Split into **2a**
  (foundation, auth, typeable text from the database — spec #7), **2b** (progress sync — spec #12)
  and **2c** (local attempt buffer: guest backfill on sign-in + offline retry — spec #15, which
  closes #13). Seeding both Phase 1 fixtures (EN + ES) keeps the UI-locale-vs-content-language
  independence verifiable.
- **Phase 3** — ✅ Ingestion pipeline + catalog read from the database. Split into **3a**
  (spec #17 — the offline pipeline, the book manifest and publication gating), **3b** (spec #18 —
  windowed chunk reads, the chunks endpoint, and publishing the first real books) and **3c**
  (spec #19 — the catalog reaches 12 books, 6 `en` / 6 `es`, six with supplied **cover** art in
  Storage; the library gained a **language filter** and a **continue reading** section). The order
  was load-bearing: 3b rewrote how the typing screen fetches its text and could not be honestly
  tested without the real long books 3a put in the database.
- **Phase 4** — ✅ Modes + polish + E2E coverage. Split into **4a** (✅ spec #24 — **mode** as the
  measurement axis: honest Zen, span-scoped metrics, nullable metrics and span columns on
  `chunk_attempts`, the 100-character best floor), **4b** (✅ spec #25 — polish: all four palettes
  re-derived to clear WCAG AA, closing #21; server-resolved catalog **search** and **sort** composing
  with the **language filter**; an accessibility sweep across all four screens with the
  `color-contrast` axe carve-out removed) and **4c** (✅ spec #26 — an E2E gap audit against this
  glossary closing five gaps, plus a CI coverage-manifest floor). The order is load-bearing the same
  way Phase 3's was: 4b polishes and 4c covers a typing screen whose measurement axis 4a defines, so
  both would have to be redone against it otherwise.
- **Phase 5** — ✅ Header, landing and library polish. **5a** (✅ spec #30 — narrows **Font family**
  to **Reading font**, scoped to book text only, with an IBM Plex → Roboto family swap and the
  optical-matching/no-reflow guarantee dropped for that axis; header pencil panel and account
  menu; landing headline and library copy trimmed; `/profile` stub route).

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
- **Window** — A contiguous run of **chunks** addressed by absolute index: the unit a typeable text is
  delivered in since Phase 3b (spec #18). Ten chunks (~5 KB) per window; the typing screen
  server-renders the first one from the resume index and fetches the rest from
  `GET /api/books/[slug]/chunks?from=&limit=`. Windows are **not grid-aligned** — `from` is wherever
  the session starts, not the origin of a fixed block containing it — which is what makes
  `?passage=N` beyond the first window open the window containing N, with no alignment arithmetic
  anywhere. Every window echoes the book's authoritative chunk count alongside its chunks, so a
  session holding a stale bound after a re-ingest reconciles instead of waiting for a passage that
  will never exist. Defined in `src/lib/reading/window.ts`
  ([ADR-0006](docs/adr/0006-books-chunks-data-model.md)).
- **Prefetch** — The background fetch of the next **window**, issued once the active passage is
  within `PREFETCH_THRESHOLD` (3) chunks of the loaded end and the text holds more than is loaded.
  **Single-flight**: one request at a time, and a later trigger joins the one in flight rather than
  issuing a duplicate. It **never blocks typing** — it runs while the user types the passages already
  in hand, and a failure costs nothing but a retry on the next completion. Three passages is roughly
  a minute of typing: enough cover for a slow request, short enough that a session never holds
  windows it will not reach.
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
- **WPM** — Words per minute. Gross WPM = (typed characters ÷ 5) ÷ elapsed minutes; backspaces do not
  count as typed characters. Two distinct measurements, over different spans of the keystroke log:
  the **per-attempt** figure, computed over one chunk's log and persisted to `chunk_attempts.gross_wpm`
  at completion ([ADR-0010](docs/adr/0010-progress-data-model.md)); and the **running cumulative**
  figure, computed over the session's concatenated keystroke log across passage boundaries
  (`runningMetrics`) and shown live on the typing screen. `sessionSummary.averageWpm` is the running
  cumulative figure, not the mean of per-attempt values. Always displayed alongside accuracy.
- **Accuracy (raw)** — First-attempt correct characters ÷ the first-attempt characters actually judged
  (the positions reached so far), **not** ÷ the chunk's total length. The two agree once a chunk is
  complete but diverge mid-chunk: a total-length denominator would render live accuracy as ~5% at the
  first keystroke. The `corrected` state counts as a miss even though it is visually resolved.
  (Implemented in `src/lib/engine/metrics.ts`.)
- **Mode** — The **measurement** axis, and only that. It answers exactly one question — *is this
  stretch of typing being measured?* — with exactly two values, **Normal mode** and **Zen mode**.
  It is not a presentation: a future page-view is a **separate axis** added beside it, never a third
  value inside it, the same discipline [ADR-0011](docs/adr/0011-two-axis-theming.md) applies to
  palette and typeface ([ADR-0014](docs/adr/0014-mode-measurement-axis.md)). Persisted in one cookie
  (`typefy-mode`, `src/lib/mode/mode.ts`), written client-side by the toggle on the typing screen and
  read server-side in that route's load, following the contract the theming cookies already
  establish: no cookie means no explicit choice and the default applies. **Guests and signed-in users
  behave identically** — no profile column, no precedence rule. Since Phase 4a (spec #24) the engine,
  `chunk_attempts` and the rollups all carry it.
- **Normal mode** — The **mode** axis's default value: typing that **is** measured. WPM and accuracy
  are derived from the **keystroke log**, shown live on the typing screen (refreshed at each word
  boundary) and persisted on the **chunk attempt**. A traversal typed wholly in Normal is the only
  one that writes figures, and its `measured_ms` equals its `elapsed_ms`.
- **Zen mode** — The **mode** axis's other value: typing that is **not** measured. The engine still
  records the **keystroke log** — it costs nothing, and keeping it is what makes switching back
  mid-passage work at all — but for a Zen stretch **nothing is derived, displayed or persisted**: no
  WPM, no accuracy, on the meta line or in the database. Zen time is discounted from elapsed by the
  same mechanism `awaiting` time already is, and the two are kept **disjoint** so no millisecond is
  ever discounted twice ([ADR-0004](docs/adr/0004-typing-engine-model.md)'s Phase 4a amendment).
  Switching is free at any moment — mid-word, mid-passage, between passages — and measurement stops
  and resumes on the switch in both directions. **Zen progress is progress**: completion, resume,
  book percentages and continue reading behave identically in both modes, and a user who reads a
  whole book in Zen has read a whole book. A session containing *any* Zen time shows no WPM and no
  accuracy tile on its summary — **absent, not blanked**, since a tile advertising the number Zen
  refused is worse than no tile. Until Phase 4a (spec #24) this entry was a promise the code never
  kept: Zen was a per-visit toggle that hid figures the engine went on computing and wrote anyway.
- **Measured span** — A contiguous stretch of typing performed in **Normal mode**, and the unit
  measurement is scoped to since Phase 4a (spec #24). A traversal or a **session** may contain
  several, separated by Zen stretches; every figure is computed over the measured spans only, with
  Zen characters and **first-attempt records** excluded from the counts and Zen time from elapsed.
  **Two levels of honesty, deliberately different.** The live and session figures cover every
  measured span, so someone who types half a session in Zen and switches back sees a real figure for
  the half that was measured. A persisted **chunk attempt** instead requires a *whole clean
  traversal*: any Zen time in that passage and the row carries no figures at all. Each row records
  its span either way, in `measured_ms` (≤ `elapsed_ms`, equal exactly when the traversal was wholly
  Normal) and `measured_chars`, so "what did this number measure?" is answerable from the row rather
  than assumed from its type. A measured span shorter than `BEST_MEASURED_CHARS_FLOOR` — **100
  characters**, ≈20 words, `src/lib/progress/client.ts`, enforced by the rollup trigger — is stored
  and counted like any other but never sets a `best_*`. Chunks are 400-600 characters
  ([ADR-0005](docs/adr/0005-paragraph-chunking.md)), so a genuine passage clears the floor
  comfortably; what it stops is a short sprint at the tail of an otherwise-Zen passage banking an
  unbeatable rate. It is a **sanity floor, never an anti-cheat** — `measured_chars` is client-asserted
  exactly like `gross_wpm` ([ADR-0012](docs/adr/0012-client-trusted-progress-writes.md)).
- **Session** — Short typing stretch (one or a few chunks). Long texts are consumed in mini sessions, not
  in one sitting. Since Phase 3b (spec #18) a session is in exactly one of three named states:
  `active` (a passage is loaded and typeable), **`awaiting`** (the next passage's **window** has not
  arrived yet) and `finished`. `awaiting` is the engine's first state the user **cannot leave by
  typing** — only a delivered window leaves it — and the time spent in it is discounted from the
  session's cumulative WPM, because it is dead time the delivery layer owes rather than the typist
  ([ADR-0004](docs/adr/0004-typing-engine-model.md)).
- **Ingestion** — Offline process that downloads a public-domain text, cleans it, normalizes it to
  the **typeable character set**, splits it into paragraphs → chunks and writes it to the database.
  Lives in `scripts/ingest.ts` (the only part that touches the network, the filesystem or the
  database) over pure modules in `src/lib/ingest/` and `src/lib/chunking/`. Run with
  `npm run ingest -- --target local|prod`; adding a book needs no redeploy. Since Phase 3a
  (spec #17) it writes **directly** with the service-role key rather than emitting a migration,
  and it is driven by the **manifest** rather than by arguments. Two rules shape it: a re-ingest
  **upserts and never deletes** (chunk ids stay stable, so progress survives), and a book is
  written **unpublished** — publishing is a separate, deliberate step after its **ingestion
  report** has been read. Phase 1 fixture texts remain chunked by hand.
- **Manifest** — `scripts/catalog/books.json`, committed: the source of truth for which books the
  catalog contains and their metadata, `sourceUrl`, licence and per-book cleaning overrides.
  Ingestion reads it and never invents metadata — Gutenberg's header formats vary by decade, so an
  auto-parsed title is a wrong title written straight into the live catalog with no review step.
  With ingestion writing directly to the database, the manifest is what still lets the repository
  say what the catalog *is*.
- **Ingestion report** — `scripts/catalog/reports/<slug>.md`, committed and generated by
  `ingest --dry-run`: chunk count and size statistics, the first and last two chunks in full, and
  every character outside the typeable set. It replaces the content diff that direct-to-database
  writes removed, and because it is in git, a later cleaner change shows its blast radius across
  every book as a diff rather than as a surprise a user finds by typing into it. **No book is
  published on a report nobody read.**
- **Published** — A book with a non-null `books.published_at`. Unpublished books are invisible to
  every client — enforced in RLS for `anon` and `authenticated` alike, not filtered in a query,
  since any client can reach PostgREST directly with the publishable key. The `chunks` policy
  reaches through to its book, so an unpublished book's chunks are unreadable even by a direct
  `book_id` query. The service role bypasses RLS, which is how ingestion writes a book before
  anyone can read it.
- **Featured book** — The **book** the landing hero types, flagged by `books.featured` and written
  from the **manifest** by ingestion, never by a client. **At most one per content language**,
  enforced by the partial unique index `books_featured_per_language_idx` — the database, not a
  convention, is what lets the hero read it with a single-row query. The hero loads that book's
  **first chunk only** and reports a chunk count of 1: it is a one-passage typeable text drawn from a
  book, not a book with the rest missing. Added in Phase 3b (spec #18), closing the gap 3a left when
  the manifest gained the flag but the schema had nowhere to put it.
- **Cover** — A book's frame art: either *supplied* art, validated and uploaded by ingestion into the
  public-read, client-unwritable `covers` Storage bucket and recorded in `books.cover_url`, or the
  *generated* typographic cover (`GeneratedCover.svelte`) composed from the book's own title and
  author. Both render in the same `aspect-2/3` frame on `BookCard`; a mixed shelf — some books with
  supplied art, most without — is the intended end state, not a gap. Ingestion validates (format,
  ~2:3 aspect ratio, byte size) and never transforms — no image-processing dependency in a script
  whose value is that its logic is pure and testable. A cover's licence is a recorded per-image
  judgement (`coverLicense`, `coverSource` in the **manifest**), never inferred from the text's own
  licence — Gutenberg's *text* is public domain, its scanned art frequently is not. A `cover_url`
  that fails to load degrades to the generated cover; the database still holds the dead URL, which
  is an operator problem, not a rendering one. Added in Phase 3c (spec #19).
- **Language filter** — `?lang=en|es|all` on `/type`, resolved server-side in the load and never
  client-only, so the first paint is already correct. Defaults to the **UI locale**'s matching
  content language (EN UI → `en`, ES UI → `es`); an unrecognised value falls back to that default
  **silently**, in the same spirit as `?passage=N` — a stale or hand-edited link still opens the
  page, never a 400. This does not weaken the locale-independence rule: content language and UI
  locale remain two different things that happen to share vocabulary, the filter is a guess held in
  the URL rather than a stored preference, and `all` is always reachable. Added in Phase 3c
  (spec #19). Since Phase 4b (spec #25) it shares the library page with two more controls that hold
  the exact same posture — URL-held, resolved server-side in the same load, never client-only:
  **search** (`?q=`, matching **title** or **author**, case- and accent-insensitively, by substring)
  and **sort** (`?sort=default|title|length`; `title` collates locale-aware via `Intl.Collator`,
  `length` orders ascending by chunk count; `default` is the explicit name for `listBooks`' own
  order, not an absence). Both fall back **silently** on the same terms as `?lang`: an empty or
  whitespace-only `?q` means no search, not zero results, and an unrecognised `?sort` behaves exactly
  like the absent case rather than erroring. All three **compose** — changing one preserves the other
  two, and back/forward restores all three together, since none of it is anything but query params.
  `libraryHref` (`src/lib/library/url.ts`) is the single function every control's link is built from,
  which is what keeps changing one from silently dropping another. A search with no match renders an
  informative empty state naming what was searched, not a blank grid, and **continue reading** narrows
  with the active filter and search exactly as it already did with the filter alone, since all three
  draw from the same already-resolved `books` list.
- **Continue reading** — The library's section above the grid, signed-in users only: the 3
  **in-progress books** (`chunks_completed > 0` and `< chunk_count`) most recently active by
  `book_progress.last_active_at`, descending, drawn from the already language-filtered list so the
  section can never contradict the grid below it. A guest issues no progress query at all and the
  section renders nothing — not an empty state, no section. Fewer than 3 in-progress books renders
  fewer cards. **Completed books are excluded**: there is no "finished" state and a completed book
  still resumes at passage 0 (*Resume*), but offering a 100%-complete book as "continue" would be a
  false claim. The same book can legitimately appear twice on the page — once in this section, once
  in the grid — since both render the identical `BookCard`. **Ordering caveat**: `last_active_at` is
  set from the completing attempt row's `created_at`, so for a passage completed offline and held in
  the **attempt buffer**, it marks the *drain* moment, not the typing moment (2c amendment,
  ADR-0010). The section's ordering is therefore "most recently **persisted**", which can differ
  from "most recently typed" — accepted, not worth a schema change, and recorded here so it is not
  rediscovered as a bug later. Added in Phase 3c (spec #19).
- **Typeable character set** — The characters stored text may contain: printable ASCII, the
  newline, and `á é í ó ú ü ñ Á É Í Ó Ú Ü Ñ ¿ ¡` — what an English or Spanish keyboard produces.
  Ingestion folds everything else into it (curly quotes → `"`, dashes → `-`, `…` → `...`, exotic
  spaces → space, other Latin diacritics → their base letter, `œ` → `oe`), and **refuses** to write
  a book containing something it cannot fold. The engine's comparison stays exact
  ([ADR-0013](docs/adr/0013-typeable-character-set.md)): a chunk completes only when no character
  is `pending` or `incorrect`, so one unreachable glyph would make a passage impossible to finish
  and silently wall off the rest of the book. Stored text is therefore not byte-faithful to its
  source; `books.source_url` is the fidelity story.
- **Progress / sync** — Per-user progress persisted in Supabase under Row Level Security (each user
  sees only their own). The store is an append-only history of **chunk attempts** (the source of truth)
  plus rolled-up per-chunk and per-book tables for cheap reads
  ([ADR-0010](docs/adr/0010-progress-data-model.md)). Live since Phase 2b (spec #12): completing a
  passage inserts one `chunk_attempts` row from the browser under RLS
  ([ADR-0012](docs/adr/0012-client-trusted-progress-writes.md)), and a `SECURITY DEFINER` trigger folds
  it into the `chunk_progress` and `book_progress` rollups on write. Resume and the completion
  percentages shown on the library card and the typing screen read the maintained rollups directly,
  never the attempt history. Since Phase 2c (spec #15) the completion instant is no longer the only
  chance to persist: a completion that cannot be written then — a guest's, or a transiently failed
  write's — is held in the **attempt buffer** and drained into the same table later. So a persisted
  attempt keeps the genuine first-keystroke `started_at` but may carry rollup timestamps that mark
  the *drain* moment rather than the typing moment (ADR-0010's Phase 2c amendment). Since Phase 4a
  (spec #24) **`best_wpm` and `best_accuracy_raw` have a floor**: an attempt sets neither unless it
  completed, carries non-NULL metrics, and its **measured span** reaches
  `BEST_MEASURED_CHARS_FLOOR` (100 characters). Everything else about a rollup is mode-blind —
  `attempt_count` and `last_attempt_at` move on every insert, `first_completed_at` on any completed
  attempt, and `chunks_completed` counts a Zen completion exactly like a Normal one.
- **Chunk attempt** — One traversal of one chunk from first keystroke to completion. The atomic unit of
  persisted progress: each completed attempt appends an immutable row (gross WPM, accuracy, elapsed) to
  the history. Distinct from **Session** (a typing stretch of one or more chunks) and from the engine's
  in-memory session state. Since Phase 4a (spec #24) the row also records **what it measured** —
  its **mode**, `measured_ms` and `measured_chars` — and **gross WPM and accuracy are nullable**.
  They are NULL under the *whole-clean-traversal rule*: a row carries figures only if the entire
  traversal was typed in Normal, so any Zen time at all — even an instantaneous toggle that accrued
  no milliseconds — writes `mode = 'zen'` with both metrics NULL while the span columns still record
  what was measured. A partial figure filed as *that passage's* result is the thing the rule refuses,
  because `chunk_attempts` is what `best_*` and every future stats screen read. `elapsed_ms` keeps its
  meaning unchanged — wall clock, first keystroke to completion — and is not redefined.
- **Attempt buffer** — A capped, local (per-browser) store of completed **chunk attempts** awaiting
  persistence, drained into `chunk_attempts` once a valid session exists. Two things fill it: a
  guest's completion (no session to write under) and a signed-in user's **transient** write failure
  (no connectivity to write over, or a lazy write path that could not even be fetched). A
  **permanent** failure — an RLS refusal, a dead `chunk_id`, a malformed row — is never buffered,
  because retrying a refused row cannot succeed. Three things empty it: the root layout's mount,
  the browser's `online` event, and the next successful in-session write. **Attribution**: a
  *guest-authored* entry attributes to whoever signs in next on that browser; a
  *signed-in-authored* entry attributes only to its own user, and any other user's drain skips it
  and leaves it in place. Signing out drops the signed-in-authored entries and keeps the
  guest-authored ones. `localStorage`, one versioned key, cap 50 with oldest-first eviction, 30-day
  TTL; every operation is total and silent, so a buffer failure can never interrupt typing. Lives in
  `src/lib/progress/buffer.ts` (pure and Supabase-free, so a guest still fetches no Supabase code)
  and `src/lib/progress/drain.ts`, which is where the attribution invariant is enforced
  ([ADR-0012](docs/adr/0012-client-trusted-progress-writes.md)'s Phase 2c amendment).
- **Resume** — Opening a book starts the session at the **first incomplete passage**: the lowest chunk
  index with no completed attempt on record for this user (gaps count — passages 1 and 3 done, 2 not,
  resumes at 2). Since Phase 3b (spec #18) that index is computed **in the database**, by the
  `first_incomplete_chunk_index` SQL function — not by scanning a client-side chunk array, which is
  exactly the array **windowed** reads no longer produce. The function is `SECURITY DEFINER` so it can
  read a book's whole chunk list while the caller is only ever sent a **window** of it; it derives the
  user from `auth.uid()` rather than taking one as an argument, and it answers only for **published**
  books. Every unknowable case collapses to the same 0 — fully complete, no progress, unknown book,
  unpublished book — which is honest precisely because there is no "finished" state.
  A `?passage=N` query param overrides the computed index, 1-based to match the number
  the meta line displays; anything invalid — non-numeric, zero, negative, fractional, or beyond the
  book's chunk count — silently falls back to the computed index rather than erroring. A fully
  completed book resumes at the first passage (index 0) — there is no "finished" state. Guests always
  resume at the first passage, since nothing is persisted for them to resume from.
- **Profile** — A signed-in user's identity row (display name, avatar, optional locale preference),
  created automatically on first sign-in and readable/editable only by that user. A null `locale` means
  "no explicit preference", leaving the cookie > `Accept-Language` > EN detection to apply.
- **Palette** — One axis of the two-axis theming model (ADR-0011): a pure colour-token record (bg,
  sheet, fg, dim, muted, border, accent, error, errorTint, caret + light/dark scheme) that never
  assumes a typeface. Launch set: warm-light (default), cool-light, soft-dark, near-black. Defined in
  `src/lib/theme/palettes.ts`, painted by `src/routes/layout.css`.
- **Font family** — Superseded in effect by **Reading font** (Phase 5a, spec #30): the axis now
  applies only to book text, not interface chrome. Kept as a redirect entry because ADR-0011 and
  earlier phase-roadmap prose still say "Font family."
- **Reading font** — The font-family axis, narrowed by Phase 5a (spec #30) to the two places a
  user reads or types a book's own text: the typing screen's passage and the landing hero's
  passage. Interface chrome (header, library, all UI text) is fixed to Roboto and does not vary
  with this choice. Three faces at launch — Roboto (default), Roboto Serif, Roboto Mono — self-
  hosted via Fontsource. Persisted in `typefy-font` / `data-font`, the same cookie and attribute
  name the axis has carried since Phase 0 (spec #9) — only the display scope narrowed, not the
  wire format. Unlike the original **Font family** entry, the three faces no longer share an
  optical-matching guarantee: switching may reflow the passage (ADR-0011's Phase 5a amendment).
- **Sheet** — The typing surface's own page region: `sheet` background one step off `bg`, minimal
  border, generous padding. The passage renders on it **tonally**: pending = dim, correct/corrected =
  full foreground, incorrect = the only chromatic event (error + tint + wavy underline). No green.
- **Guest** — A visitor who is not signed in. Types fully (content is world-readable), holds no
  session, and has no anonymous account: nothing is written to Supabase for them and nothing is read
  back, so they still resume at the first passage and still see a session-relative completion figure
  rather than a book-lifetime one. Signing in is optional and unlocks progress persistence — but
  since Phase 2c (spec #15) a guest's completed passages are no longer discarded. Each one is
  enqueued in the local **attempt buffer** as *guest-authored*, and drained into `chunk_attempts`
  under whoever signs in next on that browser, which is why the session summary's sign-in prompt can
  truthfully name the passages signing in will save. Buffering does not weaken the guest guarantee:
  the buffer is a synchronous `localStorage` write from a Supabase-free module, so a guest still
  issues no Supabase request and still fetches neither `@supabase/ssr` nor `@supabase/supabase-js`.

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
- [ADR-0012](docs/adr/0012-client-trusted-progress-writes.md) — Client-trusted progress writes
- [ADR-0013](docs/adr/0013-typeable-character-set.md) — Typeable character set and source normalization
- [ADR-0014](docs/adr/0014-mode-measurement-axis.md) — Mode as the measurement axis
