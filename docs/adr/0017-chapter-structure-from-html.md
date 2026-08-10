# ADR-0017 — Chapter structure derived from the HTML edition at ingestion

**Status:** Accepted (Phase 5c — spec #33)

## Context

Spec #34 (5d, the book detail screen) needs a chapter list to build its picker around. That list
has to exist, and be trustworthy, before any UI can be built on top of it — a chapter picker that
points a few pages off is worse than no picker. Two design questions precede any code: *when* is
chapter structure computed, and *where* does it come from.

**When.** Chapter structure is computed once, at ingestion, and stored — not re-derived at
runtime on every read. The typing path (`GET /api/books/[slug]/chunks`) is a hot path serving
windows of chunks; re-parsing HTML and re-aligning headings on every request would put a slow,
network-dependent operation behind a request that today is a plain indexed row read. Ingestion
already runs once per book and already produces a reviewable report (ADR from Phase 3a); adding
chapter derivation there costs nothing that isn't already paid, and the failure mode — a bad
alignment — is caught before publication rather than in front of a reader.

**Where.** The typing text comes from the plain-text edition, cleaned by `clean.ts` exactly as
before this spec — untouched, per the spec's explicit scope. That text has no structural markup
left in it by design (ADR-0013's typeable-character-set guarantee depends on stripping exactly
that kind of thing). The HTML edition, fetched separately and never written to `chunks`, is the
only source that still carries the book's own heading markup. So chapter structure has to be
derived from the HTML and then mapped back onto the plain-text chunks it never touches.

A single extraction strategy does not cover the catalog. An investigation of six sources (spec
#33's own table, see "Corrections to the spec's investigation" below) found the heading level and
class vary per book — `h2` for pride-and-prejudice, `h2.nobreak` for niebla, `h3` for
don-quijote — and one book, el-buscon, has no structural headings in its HTML at all. A single
selector, or HTML-only extraction, cannot serve all twelve catalog books. The design is
necessarily a **hybrid**: per-book selector-driven extraction where the HTML has structure, and a
manifest-declared fallback list of titles (aligned the same way, just sourced differently) where
it doesn't.

## Decision

### Two pure modules

- **`src/lib/ingest/headings.ts`** (`extractHeadings`) — a small, deliberately scoped regex-based
  reader, not a general HTML parser: `string` in, `{ level, className, title }[]` out. No
  dependency was added because none is warranted for "read the text of a handful of heading
  tags" across HTML that, having been checked directly against all four books that ship real
  headings, is regular enough for this. Selector matching is attribute-order- and
  attribute-count-agnostic (tag + class-token membership), not a literal string match — see the
  niebla correction below for why that distinction is load-bearing. Gutenberg's own
  `#pg-header-heading` / `#pg-footer-heading` boilerplate is always excluded.
- **`src/lib/ingest/chapters.ts`** (`alignChapters`) — the aligner: heading titles in, chunk
  indices out. Both are `lib-patterns` tier 1 pure (no network, filesystem, or clock) and TDD'd
  (16 and 11 tests respectively).

### Monotonic-cursor alignment, no paragraph-index tracking

`chunkParagraphs` (`src/lib/chunking/chunker.ts`) joins a chunk's paragraphs with a single `\n`
and only ever splits a paragraph across a chunk boundary via its `pushSentence` branch — which
never applies to a heading's own paragraph, since every real chapter heading in this catalog is
short enough to go in whole via `pushParagraph`. That means a heading's paragraph is structurally
guaranteed to appear as an exact, `\n`-delimited segment somewhere in the chunk array. The aligner
exploits this directly: flatten every chunk's `\n`-delimited segments into one ordered sequence,
fold each heading's title through the same `normalizeCharacters` pass the prose went through, and
walk the flattened sequence once with a cursor that only moves forward. No paragraph-index
bookkeeping is needed anywhere in the pipeline, and `chunker.ts` itself is untouched. A heading
matching no segment, matching ambiguously, or matching only behind the cursor (out-of-order) is a
hard alignment failure — reported by title, fatal for that book's ingest, per spec.

### Storage

`chapters` (migration `20260809180633_create_chapters.sql`): `book_id`, 0-based `index`, `title`,
`start_chunk_index`, unique on `(book_id, index)`, plus a separate `(book_id, start_chunk_index)`
index for the lookup 5d and the typing meta line need — the containing chapter for a given chunk,
via `ORDER BY start_chunk_index DESC LIMIT 1`. RLS mirrors `books`/`chunks` exactly: world-select
once the parent book is published, no client write path at all — only `service_role` (ingestion)
has insert/delete grants, and there is deliberately no update grant, because the write strategy
never updates a row in place.

**Write strategy: delete-then-reinsert wholesale, every ingest.** `writeBook()` always deletes a
book's existing `chapters` rows before conditionally reinserting the freshly aligned list. This is
simpler than a diff-and-patch and gives the same "no stale row survives" guarantee a shrinking
chapter list needs, at the cost of a full rewrite even when nothing changed — an acceptable cost
given ingestion is a batch, offline, once-per-release operation, not a hot path.

### The `firstHeadingImplicit` amendment

Beyond the spec's literal text: `alignChapters` accepts an opt-in `firstHeadingImplicit: boolean`
option. When true, a first heading (index 0 only) that matches **no** paragraph at all is not an
alignment failure — it is recorded at `startChunkIndex: 0`, and the cursor does not advance, since
nothing was actually consumed from the text.

**Root cause.** All four books shipping real chapter structure (pride-and-prejudice, don-quijote,
niebla, el-buscon) declare `cleaning.startAtMarker` to begin the typing text at the novel's first
prose sentence, skipping past that book's own opening heading line ("Chapter 1", "Capítulo I",
"I"). That heading therefore never survives into the cleaned text as a paragraph and can never
satisfy the spec's literal "exact match against a cleaned paragraph" rule — not because of a bug
in `clean.ts` (untouched, correctly out of scope), but as a structural, general consequence of
`startAtMarker` doing exactly what it should: skip straight to the opening sentence. Every book
with declared chapters hits this at position 0.

**Scope of the exception.** Opt-in per book, visible in the manifest diff, never a default. It
applies only at position 0. A later heading that fails to match still fails ingest normally,
named and fatal — the Vitest suite enforces this for every position but the first. This is an
amendment to the spec's stated alignment rule, not a weakening of it: the rule as stated
("a heading matching no paragraph fails ingest, naming the heading") assumed every heading's
paragraph survives cleaning, which holds everywhere except the one position every real book's
own cleaning configuration structurally excludes.

### The page-to-chapter attribution rule (recorded here for spec 5d)

Per the spec's own instruction to fix this now: a page belongs to the chapter its **first
character** falls in. Chapter page-ranges are therefore contiguous and non-overlapping; a page
spanning a chapter boundary is counted wholly to the chapter it starts in. This is a deliberate,
bounded inaccuracy — at most one page-fraction misattributed per chapter — chosen over fractional
weighting so that "how much of this chapter have I typed" stays a plain `count(*)` everywhere
progress is displayed, with no weighted-sum logic anywhere in the product.

## Consequences

- A reviewable, fail-loud pipeline: alignment failure stops that book's ingest before publication,
  named by heading, rather than shipping a silently-wrong chapter list. The committed ingestion
  report — now carrying a "## Chapters" section per book — is the review gate; a diff that changes
  a book's chapter list is visible in the PR.
- The extraction layer is a scoped regex reader, not a general HTML parser. This is a real,
  accepted limitation: it works because the real HTML across all four structured books was
  checked directly and found regular enough. A future book with markup irregular enough to defeat
  tag/class matching would need this revisited, not patched around.
- `firstHeadingImplicit` is a real, if narrow, weakening of "every heading must align" — confined
  to position 0, opt-in, and currently needed by all four books that ship structure. A future book
  might need the exception extended (e.g. a last-heading case) or reconsidered; it should not be
  extended silently.

## Alternatives considered

- **Re-deriving chapters at runtime.** Rejected — the spec states structure is computed once, at
  ingest, and the hot chunks-read path should not carry HTML-fetch-and-align latency.
- **Adding a general HTML parser dependency.** Rejected — no such dependency exists in this
  project, and the real HTML across all four structured books is regular enough for a narrowly
  scoped regex; a real dependency would be disproportionate to "read a handful of heading tags."
- **Ingesting the HTML edition itself as the typing source.** Already recorded in the spec's own
  "Non-goals / future" section and not re-litigated here: technically appealing in isolation, but
  it would replace the entire cleaning pipeline three phases have hardened and put the catalog
  behind an untested text path.

## Corrections to the spec's investigation

The spec's own investigation table is not fully accurate for two books. Recorded here so a future
reader who notices the discrepancy against the spec issue finds the explanation, not a fresh
investigation.

- **Niebla: 37 raw `h2.nobreak` headings in the live HTML, not the 36 the spec's table states.**
  Verified directly against Gutenberg's `pg49836-images.html` by three independent counting
  methods. One heading — the book's own epilogue, `POR MODO DE EPÍLOGO` — carries an extra
  `title="ORACIÓN FÚNEBRE POR MODO DE EPÍLOGO"` attribute alongside `class="nobreak"`. A selector
  match against the literal string `<h2 class="nobreak">` misses this element and undercounts by
  exactly one — almost certainly how the spec's "36" was produced. `extractHeadings`'s selector
  matching is attribute-order/attribute-count-agnostic (tag + class-token membership), so it
  correctly returns 37. After excluding `PRÓLOGO` / `POST-PRÓLOGO` (both precede
  `cleaning.startAtMarker`) and `ÍNDICE` (the table of contents, follows `cleaning.endMarker`) via
  `chapters.excludeTitles`, niebla ships with 34 real chapters (`I`–`XXXIII` plus the epilogue).
- **Don Quijote: the spec's acceptance criterion of 137 is the raw HTML extraction count, not the
  final ingested chapter count.** Verified: exactly 137 real `<h3>` elements exist, matching the
  spec's number literally at the extraction layer. Of those, 11 are front matter with no
  distinguishing `id` attribute at all (`TASA` ×2, `TESTIMONIO DE LAS ERRATAS`, `EL REY`, `AL
  DUQUE DE BÉJAR,`, `PRÓLOGO`, `AL LIBRO DE DON QUIJOTE DE LA MANCHA`, `FEE DE ERRATAS`,
  `APROBACIONES`, `PRÓLOGO AL LECTOR`, `DEDICATORIA, AL CONDE DE LEMOS`) and are excluded via
  `chapters.excludeTitles` — title-based, since this book's headings carry no `id` to key off,
  unlike a hypothetical id-based scheme an earlier draft assumed. The final ingested/aligned count
  is 126. "137" is honestly the extraction-layer number; the shipped chapter list is a further,
  deliberate, book-specific editorial narrowing on top of it — the same posture as niebla, just
  one that happens to match the spec's literal number at the extraction layer rather than
  diverging from it there.
