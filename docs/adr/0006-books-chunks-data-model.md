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

## Alternatives considered

- **Text in static repo files** — Acceptable for 20 books, but hundreds of MB blow up the repo and the
  deploy; adding a book requires commit+redeploy; and custom text cannot live in the repo.
- **Runtime fetch from the source** — No stored pre-processing, but pays cleaning/chunking on every
  request and depends on the source being available. Bad fit.
