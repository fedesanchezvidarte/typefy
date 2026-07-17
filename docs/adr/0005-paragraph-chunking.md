# ADR-0005 — Paragraph-based chunking with a size target

**Status:** Accepted

## Context

A book has hundreds of thousands of characters; no one types it in one sitting. It must be split into
units consumable in mini sessions, and that unit defines the data model, progress saving, and what "% of
the text completed" means. Options: fixed-length chunks, paragraph chunks, or continuous scroll with a
cursor.

## Decision

Split each typeable text **by paragraphs, grouping up to a size target** (~400-600 characters), **never
cutting a sentence**. The chunk is the **atomic unit of progress**.

- Text % = completed chunks / total.
- Same pipeline for books and, later, custom text.

## Consequences

- Naturally short sessions (1-3 min) without breaking the reading experience.
- Trivial data model: `book → chunks[] → per_chunk_progress`.
- Pre-processing happens in offline ingestion ([ADR-0006](0006-books-chunks-data-model.md)), not at
  runtime.
- The paragraph grouper is pure logic → testable with Vitest.

## Alternatives considered

- **Fixed-length chunks** — Predictable sessions, but cut sentences at arbitrary points → bad reading
  experience.
- **Continuous scroll with a cursor** — Conceptually simple, but complicates per-session metrics and
  clean pause/resume.
