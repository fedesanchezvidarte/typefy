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

## Amendment (2026-08-09, Phase 5b implementation — spec #32)

The size target changed from a single ~400-600 character range to a **dual budget**:
`MAX_CHARS` (1600) **and** `MAX_LINES` (24 estimated rendered lines), whichever binds first
closes the chunk. A paragraph's cost is `max(1, ceil(length / CHARS_PER_LINE))` rendered lines,
with `CHARS_PER_LINE = 66`; the floor of 1 is why a run of short dialogue paragraphs fills a page
by line count long before it fills one by character count. `MAX_LINES * CHARS_PER_LINE` is 1584,
so on dense prose — paragraphs that fill their last line rather than wasting it — both budgets
bind at roughly the same point; on dialogue the line budget binds far earlier. The **never-cut-a-
sentence rule is unchanged**: the dual budget only changes when a chunk closes, not how a
paragraph is split. Constants live in `src/lib/chunking/measure.ts`.

**The determinism rule, stated explicitly because it is load-bearing:** the line estimate is
computed against a **fixed nominal measure** — `CHARS_PER_LINE = 66` as a pure number — and
**never against a DOM measurement**. Chunk boundaries are the progress key
([ADR-0006](0006-books-chunks-data-model.md)) and must be **byte-identical on every device**,
regardless of viewport width, zoom level, or font rendering. A DOM-measured budget would make the
same book chunk differently on a phone and a desktop, which would make `chunk_id` — and every row
that references it — device-dependent. [ADR-0015](0015-ch-measure-chunking-contract.md) records
the other half of this seam: how the typing surface's own CSS measure is kept from silently
diverging from `CHARS_PER_LINE`.

The renamed unit — a chunk presented as a **page** — is recorded in CONTEXT.md's Glossary, not
here: this ADR is about how a chunk is *sized*, not what it is *called*.
