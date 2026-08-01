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

## Amendment (2026-08-01, Phase 3b implementation — spec #18)

This ADR said "heavy text fetched per book", and Phase 2a implemented that literally: one query
returning a book with every one of its chunks embedded. Publishing real full-length books is what
made the sentence untenable, and building the replacement changed five things about this decision.

### Text is delivered in windows, through a public endpoint

A **window** is a contiguous run of chunks addressed by absolute index — ten of them, ~5 KB. The
typing screen's load reads the book's metadata and only the window starting at the resume index;
windows 2..n arrive through `GET /api/books/[slug]/chunks?from=&limit=` while the user types. The
window is deliberately **not grid-aligned**: `from` is wherever the session starts, which removes an
entire class of off-by-one arithmetic and makes "`?passage=900` opens the window containing passage
900" true for free.

Two concrete failures forced this, not tidiness. A full-length novel is roughly **1 MB of text on
every open** of the typing screen, paid before the first keystroke and paid again on every revisit.
Worse, the embedded-chunks query is subject to **PostgREST's row limit**, which truncates silently —
so a long book would not have failed, it would have *ended mid-way*, presenting as a finished book to
a user who had typed two thirds of it. That failure mode is the reason `getBookBySlug` is **deleted
rather than deprecated** (see below): a bug that presents as correct data is not one to leave
importable.

`getChunkWindow(client, book, from, limit)` replaces it. It does not know what a window *is* — the
bounds are arguments, the policy lives in `src/lib/reading/window.ts` — which is what keeps one clamp
shared between the SSR window and the prefetched ones, so they can never disagree about how much a
window is.

### The caching contract, and why not `immutable`

A 200 from the chunks endpoint carries
`Cache-Control: public, max-age=0, s-maxage=300, stale-while-revalidate=86400` and a **strong** ETag
over the range identity plus each chunk's id and content. It sets **no `Vary` of its own**.

`immutable` was rejected, and the reason is this ADR's own Phase 3a amendment: **a re-ingest upserts
in place**. Chunk ids are stable across a re-ingest precisely so progress survives — which means the
*content* at a stable id can legitimately change when a cleaner fix or a corrected typo is
re-ingested. `immutable` tells caches never to revalidate, so a corrected typo would be stranded
behind every intermediate cache until the max-age expired, on a passage the user cannot complete
without typing the typo. `s-maxage` + `stale-while-revalidate` keeps the CDN absorbing the load while
`max-age=0` keeps the browser revalidating, and the ETag — being a genuine content hash — catches the
correction on the first revalidation after it. The revalidation is the point; `immutable` would have
removed it.

### Content and per-user progress are split across two endpoints

The window response is **public and shared-cacheable**; the per-user completed chunk ids live behind a
separate `GET /api/books/[slug]/progress`, which is `private, no-store` and is called only when signed
in. The chunks handler **consults no session at all** — it never calls `safeGetSession()` or any auth
helper.

The requirement was that no user's progress is ever served to another user from a shared cache. Split,
that holds **structurally**: the cacheable body is a pure function of `(slug, from, limit)` and the
chunk rows, so there is no per-user byte in it to leak. It is not a property a proxy has to honour.

A fused response would have needed `Vary: Cookie` for correctness, and `Vary: Cookie` fails three ways
at once here: Supabase's auth cookie is *chunked*, so the cache key is effectively unique per session
and the public cache does nothing anyway; any intermediary that normalises, truncates or ignores
`Vary` converts a cache hit into a progress leak; and the guarantee would then rest on CDN behaviour
this project does not control. Separately, an ETag over a fused body is **not a content hash** — two
users typing the same range would get different validators, so revalidation would never hit, and
revalidation is exactly what `s-maxage` over `immutable` was chosen to preserve. The alternative exit,
marking the whole endpoint `private`, makes every guest pay for signed-in privacy on a path that is
~99% identical bytes for everyone.

Two further consequences that are load-bearing rather than incidental. The chunks handler must not
touch an auth helper because a token refresh would attach `Set-Cookie` to a `public, s-maxage`
response — the classic cache-poisoning shape. And a failed progress fetch is *cosmetic*: some
completion markers are missing until the next load, self-correcting. Fused, a progress hiccup would
have failed the whole window and stalled the session in `awaiting`.

The `/type/[slug]` SSR load stays uncached and must not be made cacheable: it is user-dependent by
construction, and it carries the first window's chunks *and* that window's completed ids inline, so
the first passage costs zero extra requests and the split above applies only to windows 2..n.

### `books.featured` closes a gap 3a left open

Phase 3a's manifest already validated "at most one featured book per language", but 3a's migration
never added the column, so the flag had nowhere to land. `books.featured` is that column, with a
**partial** unique index `books_featured_per_language_idx on books (language) where featured`. Partial
is the whole trick: a plain `unique (language)` would allow exactly one book per language in the
entire catalog, which is the opposite of what Phase 3 is building. The index is what lets the hero
query use `.maybeSingle()` honestly — the database, not a convention, guarantees at most one row.

### Residual risk: the publication rule now lives in two places

Resume moved into the `first_incomplete_chunk_index` SQL function, which is `SECURITY DEFINER` —
necessarily, because it must read a book's whole chunk list while the caller is only ever sent a
window of it. `SECURITY DEFINER` **bypasses RLS**, so the function does not inherit the
`published_at is not null` predicate the publication-gating migration put on `books`/`chunks`. Without
an explicit copy of that predicate in the function body, an unpublished book's resume index would be
computable — and not only through the route: PostgREST publishes the function at
`/rest/v1/rpc/first_incomplete_chunk_index`, callable by any `authenticated` holder of the publishable
key, so the route's own 404 is not a defence at all.

The body therefore carries its own `exists (… published_at is not null)`. **The residual, recorded
rather than hidden: this ADR's publication rule is now expressed twice** — once as an RLS policy, once
inside a function body — and a future change to the rule that updates only the policy silently reopens
the hole. This was surfaced to the user and knowingly accepted, with a database test asserting the RPC
returns 0 for an unpublished book as `authenticated` as the thing that actually catches a careless
future edit. Cross-references in the function comment and the policy comment help a reader; only the
test helps an editor.

`security invoker` would have removed the duplication entirely by inheriting the policy, and it would
have been correct — `chunks` is readable under RLS for a published book and `chunk_progress` is
already `auth.uid()`-scoped. It was rejected because the `chunks` policy runs a **correlated** `exists`
against `books` *per row*: on a 2,000-chunk book the invoker form turns one ordered index scan into up
to 2,000 book lookups, on the resume path — the exact hot path this feature exists to make cheap.

One invariant this creates and which nothing in the type system protects: the function and
`getCompletedChunkIds` (`src/lib/server/progress.ts`) must both define "completed" as
**`first_completed_at is not null`, never the existence of a `chunk_progress` row**. The rollup trigger
writes a row on *every* attempt, so row-existence would resume a user past passages they abandoned.
Both sites carry the rule as a comment; a test that attempts a passage without completing it and
asserts both paths still call it incomplete is what keeps them agreeing.
[ADR-0010](0010-progress-data-model.md) is otherwise untouched by this phase.

## Alternatives considered

- **Text in static repo files** — Acceptable for 20 books, but hundreds of MB blow up the repo and the
  deploy; adding a book requires commit+redeploy; and custom text cannot live in the repo.
- **Runtime fetch from the source** — No stored pre-processing, but pays cleaning/chunking on every
  request and depends on the source being available. Bad fit.
