-- Phase 5d — book detail metadata (spec #34).
--
-- The detail screen shows two facts the catalog has never carried: when the work was first
-- published, and what it is about. Both are metadata *about* the book, not text to be typed,
-- so they live on `books` alongside title/author/cover rather than in a new table.
--
-- Both columns are written exclusively by ingestion (scripts/ingest.ts), never by the app at
-- runtime — the same posture as every other column on this table. Deliberately no DML here:
-- `year` and `summary` are populated by an ingest run, never seeded by a migration. Seeding
-- them would create exactly the class of local/hosted data divergence issue #35 records.
--
-- No RLS change: both columns ride the existing publication-gating policy from
-- 20260731120000 unchanged, and column-level grants are not in use on `books`.
--
-- No index: neither column is filtered, sorted, nor joined on. The detail screen reads them
-- from a row already located by slug, and the library grid does not show either.

alter table books
	add column year integer,
	add column summary jsonb not null default '{}'::jsonb;

comment on column books.year is
	'The work''s first publication year, from Open Library — never the Project Gutenberg release date and never a particular edition''s date. Negative for BCE. Null is a legal state, not a defect: a book with no declared Open Library work, or a lookup that failed during ingestion, simply has no year and the screen omits the fact.';

comment on column books.summary is
	'Locale-keyed map of blurbs, display-only and never typed. The ''default'' key holds Open Library''s description, whose language is UNVERIFIED — it is whatever Open Library recorded, usually but not reliably English. Every other key is a BCP-47 locale (''en'', ''es'') supplied as a manifest override, and an override always wins over ''default'' for that locale. Empty object means no summary; the screen omits the section rather than showing a placeholder. Never machine-translated.';

-- `year` is nullable, so this CHECK evaluates to NULL — and therefore passes — for a book
-- without one. The bounds are wide, immutable literals rather than anything derived from
-- now(): a CHECK must give the same answer forever, and one that tightens as time passes
-- would start rejecting rows a future pg_dump/restore replays. This is a typo catch (a
-- Gutenberg id or an ISBN landing in the column), not a claim about publishing history.
alter table books
	add constraint books_year_plausible check (year is null or (year between -3000 and 2200));

-- jsonb accepts scalars and arrays as valid documents, so `not null default '{}'` alone does
-- not make the column a map. Without this, a `summary` of `"a string"` or `[1,2]` would be
-- stored happily and every locale lookup downstream would silently resolve to nothing.
alter table books
	add constraint books_summary_is_object check (jsonb_typeof(summary) = 'object');
