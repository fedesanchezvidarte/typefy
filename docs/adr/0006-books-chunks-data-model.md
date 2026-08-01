# ADR-0006 — `books` + `chunks` data model and offline ingestion

**Status:** Accepted

## Context

The catalog starts with 10-20 public-domain books but must be able to grow to "as many books as
possible" without touching code. Raw source text (e.g. Project Gutenberg) comes with junk: legal
headers, mid-sentence line breaks, notes. We had to decide where the text lives (static repo vs database)
and how it gets in.

## Decision

**All text lives in Supabase**, in two separate tables:

- **`books`** — metadata (title, author, language, cover, chunk count). Small table; feeds the catalog.
- **`chunks`** — chunked text content ([ADR-0005](0005-paragraph-chunking.md)). Large table; loaded on
  demand only when that book is opened.

Populated by an **offline ingestion script** (`scripts/ingest.ts`): download the text → clean the
source header/footer → normalize → split into paragraphs → chunks → seed Supabase. Runtime only reads.
Covers can go to Supabase Storage.

## Consequences

- Adding a book = run the script, no redeploy. The catalog grows as data, not as code.
- A single path for books and, later, custom text (both are rows in `chunks`).
- Lightweight catalog (reads `books`) and heavy text fetched per book (reads `chunks`).
- The ingestion's text cleaner is pure logic → testable with Vitest.
- The schema must be designed well in Phase 2 (early sync against 1 manually seeded book), not improvised
  in Phase 3.

## Amendment (2026-08-01, Phase 3a implementation — spec #17)

Building the pipeline this ADR described changed four things about it.

### Ingestion writes directly; migrations are schema-only again

This ADR promised "adding a book = run the script, no redeploy". Phase 2a did not deliver that:
seeding went through `scripts/generate-seed.ts`, which emits a **committed migration** from
`src/lib/fixtures/`, so adding a book meant commit + `db push` + deploy. That was a reasonable
Phase 2 expedient for two hand-chunked excerpts; it does not survive twenty full-length books,
where the generated SQL is megabytes replayed on every `db reset` and in CI.

`scripts/ingest.ts` now connects with the **service-role key** and upserts directly. Migrations
carry schema only. The generated seed migration remains, but exclusively for the fixtures, which
are the deterministic content every `db reset` and E2E run needs.

The cost is that production content is no longer reproducible from the repository. Two committed
artefacts buy that back:

- **The manifest** (`scripts/catalog/books.json`) — the source of truth for which books exist and
  their metadata, licence and source URL. Ingestion never invents metadata: Gutenberg's header
  formats vary by decade and Spanish sources differ entirely, so an auto-parsed title is a wrong
  title written straight into the live catalog with no review step.
- **The dry-run reports** (`scripts/catalog/reports/<slug>.md`) — chunk statistics, the first and
  last two chunks in full, and any character outside the typeable set. Because they are in git,
  a later cleaner change shows its blast radius across every book **as a diff**, rather than as a
  surprise a user finds by typing into it.

### `published_at` gates visibility, in RLS

A book now exists in the database before it is fit to read. `books.published_at` is null until an
explicit `--publish` run, and the content SELECT policies require it to be non-null — for `anon`
**and** `authenticated`. Filtering in `src/lib/server/books.ts` would be bypassable, since any
client can query PostgREST directly with the publishable key. The `chunks` policy reaches through
to its book: narrowing `books` alone would leave chunks readable by a direct `book_id` query.

This is also what makes the non-transactional write acceptable. PostgREST cannot span statements,
so a book is written in several requests; a partial write is unpublished and therefore
unreachable, rather than broken in the catalog.

### Re-ingest upserts and never deletes

`chunk_attempts.chunk_id` and `chunk_progress.chunk_id` cascade on delete, so removing a chunk
destroys real users' history. Chunks therefore upsert on `(book_id, "index")` with ids never sent,
so they stay server-generated and **stable across a re-ingest**. A re-chunking that yields *fewer*
chunks is refused outright; `--allow-shrink` overrides it, and reports how many attempts across
how many users the cascade would take first.

A consequence to accept: a re-ingest that *grows* `chunk_count` drops a previously 100%-complete
book below 100%, because the rollups store completed counts against a live denominator. That is
correct — there genuinely is more book now — and no "finished" state exists to invalidate.

### RLS bypass is not privilege bypass

Found empirically, as `anon` and `authenticated` through real PostgREST rather than as the service
role: `service_role` skips row policies but still needs **table grants**, and this project has
automatic exposure of new tables disabled. Every ingestion write failed
`42501 permission denied for table books` until the grants were added.

They are scoped deliberately. No `DELETE` on `books` — deleting one cascades away every user's
attempts and rollups. `DELETE` on `chunks` only, because `--allow-shrink` is the one path that
removes them. And `SELECT` only on `chunk_attempts`, purely so the shrink guard can count what it
would destroy: ingestion must never be able to write, alter or delete progress, and a service-role
insert into `chunk_attempts` is still refused 403.

That grant fixed a real failure. Without it the count query errored, the error was swallowed, and
the guard announced "0 recorded attempts across 0 users" for a chunk that carried one — a safety
check failing toward *"deleting this is free"*, which is worse than no check at all.

## Alternatives considered

- **Text in static repo files** — Acceptable for 20 books, but hundreds of MB blow up the repo and the
  deploy; adding a book requires commit+redeploy; and custom text cannot live in the repo.
- **Runtime fetch from the source** — No stored pre-processing, but pays cleaning/chunking on every
  request and depends on the source being available. Bad fit.
