-- Phase 5c — chapter structure (spec #33).
--
-- A navigational overlay on a book's chunks: a title and a start chunk index, derived at
-- ingestion from the source's HTML edition (or, for a book with no HTML structure, from
-- hand-declared titles in the manifest) and aligned back to the cleaned text. Chapters never
-- constrain chunk boundaries; a page may span a chapter boundary by design.
--
-- Rewritten wholly per book on every ingest — scripts/ingest.ts deletes and reinserts a book's
-- rows every time, so a shrinking chapter list never leaves a stale row behind. Nothing
-- references chapters.id, so the delete cascades nothing.
--
-- Security mirrors books/chunks exactly: readable by everyone once the parent book is
-- published, writable by no client — only service_role (ingestion) writes.

create table chapters (
	id uuid primary key default gen_random_uuid(),
	book_id uuid not null references books (id) on delete cascade,
	-- 0-based, in reading order within the book.
	"index" integer not null check ("index" >= 0),
	title text not null,
	-- 0-based, matching chunks."index". The chunk whose first character opens this chapter.
	start_chunk_index integer not null check (start_chunk_index >= 0),
	created_at timestamptz not null default now(),
	unique (book_id, "index")
);

-- Answers "which chapter contains chunk N": the greatest start_chunk_index <= N for a book.
-- The (book_id, "index") unique constraint's index doesn't serve this — its second column is
-- the chapter's own sequence number, not start_chunk_index — so this is a genuinely separate
-- index, matching WHERE book_id = ? AND start_chunk_index <= ? ORDER BY start_chunk_index DESC
-- LIMIT 1.
create index chapters_book_start_chunk_idx on chapters (book_id, start_chunk_index);

alter table chapters enable row level security;

create policy "Chapters of published books are readable by everyone" on chapters for select to anon, authenticated using (
	exists (
		select 1
		from books as b
		where
			b.id = chapters.book_id
			and b.published_at is not null
	)
);

-- Table-level SELECT grant (automatic exposure of new tables is disabled on this project).
grant select on chapters to anon, authenticated;

-- Ingestion writes with the service-role key, which bypasses RLS but still needs table-level
-- grants (same reasoning as the books/chunks grants in 20260731120000). No UPDATE: ingestion
-- always deletes + reinserts a book's chapters, never updates one in place.
grant select, insert, delete on chapters to service_role;
