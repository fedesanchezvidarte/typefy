# ADR-0020 — Chapter progress aggregated in a pure module over paginated indices

**Status:** Accepted (Phase 5d — spec #34)

## Context

The book detail screen renders, for every chapter, its page range and how much of it this user has
typed. [ADR-0017](0017-chapter-structure-from-html.md) already fixed the domain rule — *a page
belongs to the chapter its first character falls in*, so chapter page-ranges are contiguous,
non-overlapping, and progress stays a plain count with no weighted sum anywhere in the product. What
5d had to decide is **where that fold executes**: in SQL, or in TypeScript over rows the server
reads.

There is a real precedent pulling toward SQL. `first_incomplete_chunk_index` is a `SECURITY DEFINER`
function precisely because the resume computation needs a book's whole chunk list while the client
is only ever sent a **window** of it (ADR-0006's Phase 3b amendment). A `chapter_progress(p_book_id
uuid)` function returning one row per chapter would be one round trip and structurally immune to
PostgREST's row cap.

Against that: `supabase/config.toml` sets `max_rows = 1000`, and don-quijote runs to roughly 2,000
pages across 126 chapters. Any read of a user's completed pages has to survive that cap.

## Decision

**The fold is a pure TypeScript module. The database returns raw completed indices, paginated.**

Shipped as designed in the Feature Brief, unchanged through Phase 3 review.

### `getCompletedChunkIndexes` — `src/lib/server/progress.ts`

```ts
client
	.from('chunk_progress')
	.select('chunks(index)')
	.eq('user_id', userId)
	.eq('book_id', bookId)
	.not('first_completed_at', 'is', null)
	.order('chunk_id')
	.range(offset, offset + COMPLETED_PAGE_SIZE - 1);
```

- **Indices, not ids.** `getCompletedChunkIds` returns chunk uuids, which say nothing about
  position; bucketing by chapter needs `chunks.index`. Mapping uuids to indices would mean a second
  read of the whole `chunks` table — the embedded `chunks(index)` gets it in one, over the FK
  PostgREST already knows about.
- **`first_completed_at is not null`, never row existence.** The rollup trigger writes a row on
  every attempt; row-existence would count abandoned passages as completed. This is the invariant
  ADR-0006's Phase 3b amendment named, and this function is now a third site bound by it.
- **`COMPLETED_PAGE_SIZE = 1000`, and pagination is not optional.** An unpaginated read would
  **silently** return 1,000 rows — no error anywhere — and every chapter past the truncation point
  would render as untouched. This is the exact failure class `scripts/ingest.ts`'s
  `readExistingContent` already defends against, and this mirrors its `.range()` loop. The page size
  must not exceed `max_rows`: a larger page would be silently truncated *to* the cap, and the
  short-page loop test would then end pagination early — the very bug the loop exists to prevent.
- **A partial-read error throws**, matching this file's doctrine. A truncated read must never be
  reported as progress: a wrong progress bar is worse than an error.
- **A row whose embedded chunk is absent is skipped**, not emitted as a hole. No index is knowable
  for it, and a `0` would be attributed to chapter one.

### The indices come back in `chunk_id` order and are deliberately NOT sorted

`.range()` is only a real partition over a total order, and `chunk_progress` has **no index column
of its own** to order by. `chunk_id` is a component of its primary key and is stable, so it is what
the query orders on — which means **the returned indices are in no meaningful order**.

This is recorded in three places (the function's docstring, `buildChapterProgress`'s docstring, and
the route load) with the same instruction: *do not "tidy up" by sorting here.* A sort would hide the
contract rather than honour it, and would let a future merge-walk implementation appear to work.

### `buildChapterProgress` — `src/lib/library/chapter-progress.ts`

A `lib-patterns` tier-1 pure module — no Supabase, no clock, no locale — that is the executable form
of ADR-0017's attribution rule:

- Chapters are copied and sorted by `startChunkIndex` defensively; an embedded resource's row order
  is not a contract.
- Chapter *i* owns `[start_i, start_{i+1})`; the last runs to `chunkCount`, clamped so a chapter list
  running past `chunkCount` yields an empty range rather than a negative page count.
- **Each completed index is bucketed by binary search over the chapter starts**, never by a merge
  walk. A lookup — unlike a walk — cannot be broken by unsorted input, and don-quijote is 126
  chapters against ~2,000 indices, so the binary search is also the cheaper shape.
- Duplicates count once (`new Set`). An index outside every chapter — negative, at or beyond
  `chunkCount`, or in **front matter preceding the first chapter** — is ignored rather than folded
  into the nearest chapter.
- `firstPage` / `lastPage` are 1-based and inclusive: page numbers, not chunk indices. This module is
  the only place the two vocabularies meet.

### The guest path is the same code path

The route's `if (!user)` early return issues **zero progress queries** — an acceptance criterion,
not an optimisation, and the posture `/type` and `/type/[slug]` already take. It then calls
`buildChapterProgress(chapters, chunkCount, [])`, which yields the full chapter list with real page
ranges and `pagesCompleted: 0` throughout. There is no signed-in branch inside the pure module at
all; the component decides whether to render the numerals.

## Consequences

### Why not a `SECURITY DEFINER` RPC, despite the precedent

Three reasons, none of them "SQL is hard":

1. **The attribution rule is a domain rule.** In a pure module it is Vitest-testable against
   arbitrary chapter shapes — boundary-spanning pages, a single chapter, an empty chapter, a chapter
   starting at index 0, front matter, shuffled input — none of which needs a database. In SQL it is
   only reachable from E2E, which is the wrong instrument for a rule this project intends to hold
   exactly.
2. **The `first_incomplete_chunk_index` precedent does not transfer.** That function earns its RPC
   status because the typing path is **hot** and the client is only ever sent a *window*, so it
   structurally cannot compute the answer. Neither is true here: the detail screen is a cold,
   once-per-visit navigation, and the server legitimately holds the whole chapter list already.
3. **A new `SECURITY DEFINER` function means a second copy of the publication-gating rule**, plus
   the `revoke`/`grant` hardening dance. ADR-0006's Phase 3b amendment records that duplication as a
   *residual risk knowingly accepted* for resume — the rule now lives in both an RLS policy and a
   function body, and a future edit to one silently reopens the hole. Buying one round trip on a cold
   path is not worth a second instance of that risk.

### The truncation hazard is contained, not eliminated

Pagination handles it correctly today, and the loop is unit-tested against a short page, an exact
multiple, and a multi-page read. But the cost is linear in a user's completed pages: a fully
completed don-quijote is two round trips and ~2,000 rows folded in memory on every detail-screen
visit.

### Named trigger to revisit

Move the fold into a `SECURITY DEFINER` RPC when **either** of these becomes true:

- a book's completed set **routinely exceeds ~3,000 pages**, or
- the `/books/[slug]` load **shows up in profiling**.

Recorded here as a consequence rather than left as folklore, and repeated in
`getCompletedChunkIndexes`' docstring so the next reader of the query finds it without reading this
file.

## Alternatives considered

- **A `chapter_progress(p_book_id uuid)` `SECURITY DEFINER` RPC** aggregating in SQL. One round
  trip, immune to `max_rows`, and genuinely the better shape at scale. Rejected for this phase on
  the three grounds above; the trigger for reversing that decision is named rather than implied.
- **Reusing `getCompletedChunkIds` and mapping uuids to indices.** Rejected — it needs a second read
  of the whole `chunks` table to learn what the embedded `chunks(index)` returns for free.
- **An unpaginated read.** Rejected: it fails silently at 1,000 rows, under-reporting every chapter
  past the cap with nothing to notice it by. Exactly the failure `getBookBySlug` was deleted rather
  than deprecated over (ADR-0006, Phase 3b).
- **Sorting the indices in the service** so the fold could merge-walk. Rejected — the sort is real
  work that buys nothing (the binary search is already fast enough at these sizes) and it would
  conceal the ordering contract that `.range()` pagination actually depends on.
- **Computing chapter progress on the client** from the completed set the typing screen already
  holds. Rejected — the typing screen holds a *window's* completed ids, not the book's, and the
  detail screen is reached without ever visiting it.
