# ADR-0018 — Per-locale book summaries as a jsonb map with an unverified `default`

**Status:** Accepted (Phase 5d — spec #34)

## Context

The book detail screen (`/books/[slug]`) shows a blurb: what this book is about. Spec #34 sources it
from Open Library at ingestion, and allows the **manifest** to override it per locale. One of its
acceptance criteria fixes the axis the override runs on:

> A Spanish book with a per-locale summary override shows the Spanish summary under the **ES locale**.

That sentence is the whole design problem. **The override is keyed on the UI locale, not on the
book's content language** — and those are two independent axes this project has kept independent
since Phase 0 (`Language` vs `Locale`, CONTEXT.md). The same Spanish book must be able to show Open
Library's (English) description at `/books/el-buscon` and a hand-written Spanish one at
`/es/books/el-buscon`. A book has one content language; a reader has one locale; the pair is what
selects a blurb.

The second constraint comes from Open Library itself. It serves **one** description per work, in
whatever language happens to have been recorded — in practice almost always English, but *almost*.
Nothing in the payload states the language.

## Decision

**One `jsonb` column holding a locale-keyed map, with a dedicated `default` key for the
language-unverified fallback. Not a single resolved column, and not both.**

```jsonc
// books.summary
{
	"default": "Open Library's description, language unverified",
	"es": "The manifest's hand-written Spanish summary"
}
```

### Schema, as shipped

`supabase/migrations/20260810081926_book_detail_metadata.sql`:

```sql
alter table books
	add column year integer,
	add column summary jsonb not null default '{}'::jsonb;

alter table books
	add constraint books_summary_is_object check (jsonb_typeof(summary) = 'object');
```

- **`not null default '{}'`** so no caller ever has to branch on `null` *and* on `{}` for the same
  "this book has no summary" state. A book with no summary is the column's own default.
- **`jsonb_typeof(summary) = 'object'`** because `jsonb` accepts scalars and arrays as valid
  documents. Without the check, a `summary` of `"a string"` or `[1,2]` would be stored happily and
  every locale lookup downstream would silently resolve to nothing. This constraint is the only
  shape guarantee that exists at the database boundary, which is why it is not optional.
- **No RLS change, deliberately.** These are columns on `books`, which already carries the
  publication-gating world-`select` policy from `20260731120000` and has no client write path at
  all. Putting the facts on `books` rather than in a side table is precisely what makes this a
  non-event for security review: there is nothing to add and nothing to re-derive.
- **No index.** Neither column is filtered, sorted nor joined on anywhere in this feature — checked,
  not assumed, the same posture `20260801105912` recorded for itself.

### Resolution lives in exactly one function

`resolveSummary(summary, locale)` (`src/lib/library/summary.ts`), a `lib-patterns` tier-1 pure
module: `summary[locale] ?? summary.default ?? null`. The locale is an explicit argument rather than
a `getLocale()` call, so nothing in it imports Paraglide or SvelteKit — the same posture `sort.ts`
and `language-filter.ts` take, and the reason it lives in `src/lib/library/` beside them rather than
in the Supabase-facing service.

It is called **server-side, in the route load** (`src/routes/books/[slug]/+page.server.ts`), so the
first paint is already the right language and there is no hydration flash where an English blurb is
replaced by a Spanish one. It also keeps the narrowing off the client entirely: `BookFacts.svelte`
receives `string | null` and never sees the map.

## Consequences

### The accepted cost: `Json`, and a single narrowing point

`books.summary` being `jsonb` means the generated types hand back `Json`. The shape is **unenforced
at the type boundary**, and no amount of TypeScript changes that. This was accepted, not solved,
and it is contained rather than distributed:

- `toDetail` in `src/lib/server/books.ts` casts once, with a comment saying the cast is unverified
  by design and instructing the next reader **not** to add a second validator there.
- `resolveSummary` accepts a raw `Json` for exactly that reason and is the only place a stored value
  becomes a rendered string.

**`resolveSummary` never throws, and that is the contract rather than leniency.** A non-object, an
array, a non-string value, and an empty-or-whitespace string all resolve as *absent* — and absent
means "keep looking", so an unusable locale value still falls through to `default`. A malformed row
must render a screen with no summary panel, not a 500. The result is trimmed, so nothing downstream
has to know an ingested blurb can carry trailing whitespace.

### `default` says only what is true

Open Library's description is filed under `default`, never under `"en"`. Filing it under `"en"`
would assert a language nobody verified, and would additionally make an English book's own blurb
invisible under the ES locale for no reason. `default` states exactly the truth: *this is the
fallback, its language is unverified, and any locale key overrides it.*

### Adding a locale is a manifest edit

A third UI locale needs no migration, no `database.types.ts` regeneration and no ingest change —
only a new key in `scripts/catalog/books.json` and the Paraglide locale itself. The manifest's
validation (`src/lib/ingest/manifest.ts`) rejects an unknown locale key rather than dropping it, so
a typo'd `"sp"` is a manifest problem at parse time instead of a book whose Spanish summary
mysteriously never appears.

### The screen omits, it does not placeholder

`null` means the summary section is not rendered at all — no empty panel, no "no summary available"
line. A book without a blurb is a normal state.

## Alternatives considered

- **A single resolved `summary text` column.** Rejected on the acceptance criterion itself: one row
  cannot serve two locales, so ingestion would have to pick one language and be wrong for the other
  half of the audience. It collapses the UI-locale axis into the content-language axis, which is the
  exact confusion this project keeps `Language` and `Locale` separate to prevent.
- **`summary_en` / `summary_es` text columns.** Works today, and is properly typed — the real
  attraction. Rejected because it makes "add a locale" a migration plus a type regeneration plus an
  ingest change, for a project whose locale set is a UI concern expected to grow. The typing win is
  also smaller than it looks: `resolveSummary`'s fallback logic would still have to exist.
- **Both — a resolved column *and* the map.** Rejected on the spec's own grounds. The spec refuses
  to display a print edition's page count next to ours because *the app never shows two conflicting
  numbers for the same book*; storing the same fact twice, one copy locale-blind, is that same
  failure one layer down. When they disagree there is no way to tell which one a reader is looking
  at.
- **Storing Open Library's description under `"en"`.** Rejected — see "`default` says only what is
  true" above.

## Follow-up

No catalog book currently declares a `summary` override (`scripts/catalog/books.json`, Phase 7 run:
every report reads `Summary overrides | None`), and the fixture books carry none either. The
override path is exercised by `src/lib/library/summary.spec.ts` and by the manifest validation
tests, **not by any shipped data**. The first hand-written Spanish blurb is a manifest edit and an
ingest run with no code change — which is the point of the design, but it does mean the live catalog
currently only exercises the `default` branch.
