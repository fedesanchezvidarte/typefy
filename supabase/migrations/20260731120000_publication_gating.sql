-- Phase 3a — publication gating for typeable text (spec #17, ADR-0006).
--
-- Phase 3 grows the catalog from hand-chunked fixtures to real full-length books, ingested
-- offline by scripts/ingest.ts. A book therefore exists in the database before it is fit to
-- be read: half-ingested, awaiting a reviewed dry-run report, or (from 3b on) waiting for a
-- read path that can serve it. `published_at` is the gate.
--
-- Visibility is enforced in RLS, not in a query. Filtering in src/lib/server/books.ts would
-- be bypassable — any client can query PostgREST directly with the publishable key — so an
-- unpublished book must be UNREADABLE, not merely unlisted.
--
-- The service role bypasses RLS, which is what lets ingestion read and write unpublished rows.

-- ---------------------------------------------------------------------------
-- books.published_at — null until ingestion's explicit publish step.
-- ---------------------------------------------------------------------------
alter table books
add column published_at timestamptz;

comment on column books.published_at is 'When this book became visible to clients. Null = unpublished: readable only by the service role (ingestion). Set by scripts/ingest.ts --publish, never by a client.';

-- Every book seeded before this migration is already live and reviewed, so publish it in the
-- same transaction. Without this the narrowed policies below would empty the catalog the
-- instant they apply — the column is nullable with no default, so existing rows carry null.
update books
set
	published_at = now()
where
	published_at is null;

-- ---------------------------------------------------------------------------
-- Content policies, narrowed. Table-level SELECT grants are unchanged (already
-- granted to anon + authenticated in 20260722161957); only the predicate narrows.
-- Still no insert/update/delete policy on either table: content stays client-unwritable.
-- ---------------------------------------------------------------------------
drop policy "Books are readable by everyone" on books;

drop policy "Chunks are readable by everyone" on chunks;

create policy "Published books are readable by everyone" on books for select to anon, authenticated using (published_at is not null);

-- The chunk predicate reaches through to its book: a chunk is readable exactly when its book
-- is published. Narrowing `books` alone would leave chunks readable by a direct book_id query.
-- No new index needed — `unique (book_id, "index")` already indexes book_id as its leading
-- column, which is what this subquery probes.
create policy "Chunks of published books are readable by everyone" on chunks for select to anon, authenticated using (
	exists (
		select 1
		from books as b
		where
			b.id = chunks.book_id
			and b.published_at is not null
	)
);

-- ---------------------------------------------------------------------------
-- Ingestion grants. RLS bypass is NOT a privilege bypass: `service_role` skips row
-- policies but still needs table-level grants, and this project has automatic exposure
-- of new tables disabled — so 20260722161957 granted SELECT to anon + authenticated and
-- nothing to service_role. Without these, scripts/ingest.ts fails every write with
-- `42501 permission denied for table books` (verified against real PostgREST).
--
-- Deliberately scoped:
--   - No DELETE on books. Nothing in Phase 3 deletes a book, and deleting one cascades
--     every user's chunk_attempts and rollups away.
--   - DELETE on chunks only, because `ingest --allow-shrink` is the one path that removes
--     chunks; the script itself is what refuses to use it without an explicit flag.
-- ---------------------------------------------------------------------------
grant select, insert, update on books to service_role;

grant select, insert, update, delete on chunks to service_role;
