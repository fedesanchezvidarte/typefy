-- Covering indexes for the progress tables' foreign keys (Supabase advisor 0001).
--
-- Postgres does not auto-index foreign key columns. The user_id FKs are already covered
-- by each table's (user_id, ...) composite or primary key, but the book_id / chunk_id
-- FKs are not (they are not the leading column of any existing index). Without a covering
-- index, a cascade delete of a book or chunk, or a join on those columns, does a
-- sequential scan of the child table. These are the query paths 2b and any content
-- deletion will exercise.
create index chunk_attempts_book_id_idx on chunk_attempts (book_id);

create index chunk_attempts_chunk_id_idx on chunk_attempts (chunk_id);

create index chunk_progress_book_id_idx on chunk_progress (book_id);

create index chunk_progress_chunk_id_idx on chunk_progress (chunk_id);

create index book_progress_book_id_idx on book_progress (book_id);
