# ADR-0019 — Ingest-time Open Library metadata: declared work id, non-fatal failure, always-write

**Status:** Accepted (Phase 5d — spec #34)

## Context

The book detail screen shows two facts the catalog has never carried: **when the work was first
published**, and **what it is about**. Neither can be parsed out of the Project Gutenberg text —
Gutenberg's headers vary by decade and carry the *e-text release* date, not the work's. So the facts
come from a third party, Open Library, and three questions had to be answered before any code:
*how is a work addressed*, *what happens when the lookup fails*, and *what is written when it does*.

The first question is not academic. Searching Open Library for **El Buscón** returns editions dated
1927, 1961 and 1979 alongside the work's real 1626. A search-based lookup would put one of those in
the catalog with **nothing to notice it by** — a confidently wrong year renders exactly as
convincingly as a right one, and there is no downstream review step that would catch it.

## Decision

### Lookup is by a manifest-declared work id, never by search

`BookManifestEntry.openLibraryWork` holds an Open Library **work** id — `/works/OL144961W` — and
`parseManifest` validates it against `/^\/works\/OL\d+W$/`. That regex is what actually enforces the
rule: **there is no field a search term fits in**. Not an edition id (`/books/OL…M`, which carries
an edition date rather than the work's first publication year), not a URL, not a title.

The check is a *shape* check only, so `parseManifest` stays pure (tier 1). Whether a well-formed id
actually resolves is the script's problem, and a wrong-but-well-formed id is a non-fatal 404 there.

Every id in `scripts/catalog/books.json` was opened by hand and checked against the right title and
author before being declared.

### Two requests, both keyed on the same declared id

`first_publish_year` **does not live on the work document.** The work document
(`/works/OL…W.json`) carries `description`; the year exists only on a *search* document. So the
ingest issues a second request, `search.json?q=key:/works/OL…W&fields=key,first_publish_year&limit=1`
— a lookup of one known id, not a title search, which is the distinction the "never by search" rule
actually cares about. The two payloads are merged and handed to `parseOpenLibraryWork` as one.

The work document's own `first_publish_date` field is **deliberately ignored**: it is some edition's
date ("1853" for Pride and Prejudice, "1896" for Don Quijote). Using it would be the same
confidently-wrong-year failure arriving through a different door.

Caching mirrors `readSource` / `readChaptersHtml` exactly: same `.cache/sources` directory, same
`--refresh` flag, keyed on the **slug**, and only a fully successful pair is cached so a 404 or a
timeout is retried next run rather than frozen in. One consequence to remember: **changing a book's
`openLibraryWork` needs `--refresh`**, or the old work's payload is reused. Same caveat the source
and chapters caches already carry — one rule, not three.

The fetch runs inside `prepare()`, alongside `prepareChapters` — i.e. **before any credential is
read** — extending the ordering discipline `readCover` already states: nothing privileged is in
memory while a third-party host is being talked to. A 10-second timeout applies; Open Library is a
courtesy dependency and does not get to hang a run.

### Failure is non-fatal — the asymmetry with chapters is the design

`prepareChapters`' failure is turned **fatal** in `main()`, because a subtly wrong chapter list is
worse than none. A missing blurb is not. The spec states it plainly: *text and chapters are the
product; a blurb is not.*

So every one of these yields `{ year: null, description: null, failure: '<reason>' }` and ingestion
continues:

- a network error or a timeout;
- a non-200, including a 404 for a wrong work id (whose message names the manifest explicitly);
- unparseable JSON;
- valid JSON carrying neither a usable `first_publish_year` nor a usable `description`.

A **partial** failure travels with the usable half: if the description arrives and the year lookup
does not, the description is kept and the failure is still reported — so the report says the year
lookup failed rather than showing a blank year that reads as "this work has no year".

A book with **no** `openLibraryWork` is not a failure at all. It renders as `None declared` in the
report, and most of the catalog may legitimately sit there.

Every failure is printed live during the run **and** written into the committed
`scripts/catalog/reports/<slug>.md` under a new `## Metadata` section. That is the only durable
record that a non-fatal lookup stopped working, and it is what makes the regression show up as a
**diff in a pull request** rather than as a year that quietly went blank.

### The manifest `year` override, and its precedence rule

Added during implementation, beyond the Feature Brief's design. `BookManifestEntry.year` is an
optional hand-declared first publication year, and it **wins**:

```ts
year: entry.year ?? fetched.year;
```

The doctrine it turns on is the one the whole ingest pipeline already runs on: **Open Library is a
convenience; the manifest is the source of truth.** It is the same rule the per-locale `summary`
overrides follow, applied to the other field.

**The evidence that forced it.** Open Library's `first_publish_year` is the earliest edition it has
*catalogued* — which is not the same fact as first publication, and in this catalog it disagrees
with the accepted date three times:

| Book | Open Library reports | Accepted first publication |
|---|---|---|
| don-quijote | 1600 | 1605 (part one) |
| marianela | 1883 | 1878 |
| dr-jekyll-and-mr-hyde | 1875 | 1886 |

Both numbers are carried separately through `PreparedMetadata` (`manifestYear` and
`openLibraryYear`) precisely so the report can attribute each and **flag the disagreement**:

> The sources disagree: the manifest declares 1605, Open Library reports 1600.
> The manifest wins, so 1605 is what gets written. Open Library reports the
> earliest edition it has CATALOGUED, which is not the same fact as first publication —
> confirm the declared year is still the better one before publishing.

An override that later becomes redundant is therefore visible rather than permanent.

Two books — **niebla** and **trafalgar** — deliberately declare **no** `openLibraryWork` and get
their years (1914 and 1873) from the override alone. Their Open Library descriptions are not
summaries: niebla's is a physical-extent note (`ix, 178 pages ; 20 cm`) and trafalgar's is a series
note (`Episodios Nacionales / Serie 1 - Volume 1`). A summary that is not a summary is worse than no
summary, and there is no way to take the year without taking the description — trafalgar's
`first_publish_year` (1884) is an edition date anyway. `year` is valid with or without
`openLibraryWork`: a book deliberately given no work id still deserves its year.

Manifest validation mirrors the `books_year_plausible` CHECK exactly (whole number, −3000 to 2200),
so a Gutenberg id or an ISBN in that field is caught in the manifest rather than as a constraint
violation halfway through a write.

### Always write — including to `null` and `{}`

`writeBook` writes `year` and `summary` on **every** ingest, whatever the lookup produced. This is
the posture `writeCover` already takes with `cover_url` (ADR-0006's Phase 3c amendment) and for the
same reason: removing `summary.es` from the manifest and re-ingesting must **clear** it, or a
summary the maintainer deleted lingers in the catalog forever. The manifest is the source of truth
for what the catalog is, **including for absences**.

Manifest overrides are merged **last**, so a locale key always wins over `default`:

```ts
summary: {
	...(prepared.metadata.description ? { default: prepared.metadata.description } : {}),
	...entry.summary
}
```

## Consequences

### The wipe-on-outage trap, stated rather than hidden

If Open Library is **down** during a re-ingest, the always-write rule wipes a previously good `year`
and `default` summary. This is accepted, on three grounds:

1. The alternative — preserving a value nobody can currently reproduce — makes the catalog depend on
   **ingestion history** rather than on the manifest, which is exactly what the manifest doctrine
   exists to prevent. A field whose current value cannot be derived from the committed inputs is a
   field nobody can reason about.
2. The loss is **fully recoverable by re-running one command**. Nothing is destroyed that a
   successful run does not restore.
3. The report's `## Metadata` blockquote makes it **visible in the PR diff** rather than silent.
   A year turning blank is a reviewable line, not a discovery.

**Manifest-declared values are unaffected either way** — they are local and never depend on the
network. A declared `year` therefore survives an outage; that is the always-write posture working in
the maintainer's favour, and one more reason the override earns its place.

### Two network calls per book, on an offline path

Ingestion is a batch, once-per-release operation, so two requests where one would do is not a cost
worth engineering around. The cache means a `--dry-run` after the first run costs nothing.

### Descriptions carry typography the typing text may not

Open Library blurbs contain curly quotes, em dashes and ellipses, and `findDisallowed` is
**deliberately not run over them**. See [ADR-0013](0013-typeable-character-set.md)'s scope
amendment: the typeable character set governs text a user must *type*, and a summary is never typed.

Footnote stripping (`stripFootnotes` in `src/lib/ingest/open-library.ts`) is conservative and
pattern-bounded: only trailing lines that are *entirely* a markdown link definition or an
attribution reference are dropped, and the walk stops at the first line that is not one. A blurb
matching nothing is returned whole. A leftover footnote is ugly; a truncated blurb is wrong, and
there is no review step downstream that would tell the difference.

## Alternatives considered

- **Search by title and author.** Rejected on the El Buscón evidence above: three plausible wrong
  years, no signal to distinguish them, and a wrong year that renders exactly like a right one.
- **Use the work document's `first_publish_date`** instead of a second request. Rejected — it is an
  edition date ("1853" for Pride and Prejudice), i.e. the same failure the id rule exists to prevent.
- **Make a failed lookup fatal**, matching chapter alignment. Rejected: it would let a third party's
  outage block publishing a book whose text and chapters are perfect. The two failures are not
  comparable, and the report plus the non-null-able schema already make the absence visible.
- **Preserve the previous value when a lookup fails** (a conditional write). Rejected as the
  wipe-on-outage discussion above sets out — it trades a recoverable, visible loss for an
  irreproducible catalog.
- **Hand-write every year and summary in the manifest and skip Open Library entirely.** Defensible,
  and the override field is a partial admission of it. Rejected as the default because it does not
  scale to "as many books as possible" (ADR-0006), and because the disagreement report only exists
  *because* there are two sources to compare.
- **Fetch at runtime rather than at ingestion.** Never seriously considered: it puts a third-party
  request on a page load, and this project's whole content model is offline-prepared, reviewed, then
  read (ADR-0006).
