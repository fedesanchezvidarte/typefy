-- Phase 2a — content data model: books + chunks (spec #7, ADR-0006).
--
-- These two tables replace the hardcoded fixtures in src/lib/fixtures/ as the source
-- of typeable text. The full ADR-0006 shape is created now (some columns stay unused
-- until Phase 3's catalog/ingestion) so the schema is designed once, not improvised.
--
-- Security model: content is world-readable (guests type without signing in) but never
-- client-writable. RLS is enabled with a SELECT-only policy for anon + authenticated;
-- rows are inserted solely by migrations and the service role. Because the project has
-- "expose new tables" disabled, table-level SELECT is granted explicitly.

-- ---------------------------------------------------------------------------
-- books — lightweight metadata, one row per typeable text. Maps to TypeableText.
-- ---------------------------------------------------------------------------
create table books (
	id uuid primary key default gen_random_uuid(),
	-- Stable, human-readable identifier used as the /type/[slug] URL segment.
	slug text not null unique,
	title text not null,
	author text not null,
	-- Content language, independent of the UI locale. Checked, not an enum, so adding
	-- a language later is a one-line constraint change rather than an ALTER TYPE dance.
	language text not null check (language in ('en', 'es')),
	-- Denormalised count of this book's chunks; progress % = completed / chunk_count.
	chunk_count integer not null default 0 check (chunk_count >= 0),
	-- ADR-0006 metadata. Populated/served only from Phase 3 on (no Storage in 2a).
	cover_url text,
	source_url text,
	license text,
	created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- chunks — atomic unit of typeable text and of progress. Maps to Chunk
-- (chunks.book_id is Chunk.textId, as Phase 1's types anticipated).
-- ---------------------------------------------------------------------------
create table chunks (
	id uuid primary key default gen_random_uuid(),
	book_id uuid not null references books (id) on delete cascade,
	-- 0-based position within the book. Quoted because `index` is a SQL keyword.
	"index" integer not null check ("index" >= 0),
	content text not null,
	char_count integer not null check (char_count > 0),
	created_at timestamptz not null default now(),
	-- One chunk per position per book; also the natural ordering key for loads.
	unique (book_id, "index")
);

-- ---------------------------------------------------------------------------
-- Row Level Security: content is readable by everyone, writable by no client.
-- ---------------------------------------------------------------------------
alter table books enable row level security;

alter table chunks enable row level security;

-- World-readable: guests must be able to load and type content (spec #7).
-- No insert/update/delete policies exist, so RLS denies all client writes by default.
create policy "Books are readable by everyone" on books for select to anon, authenticated using (true);

create policy "Chunks are readable by everyone" on chunks for select to anon, authenticated using (true);

-- Table-level SELECT grant (required: automatic exposure of new tables is disabled).
grant select on books to anon, authenticated;

grant select on chunks to anon, authenticated;
