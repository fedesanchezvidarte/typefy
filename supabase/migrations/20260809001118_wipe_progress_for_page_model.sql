-- Phase 5b — wipe all progress ahead of the catalog re-chunk (spec #32, ADR-0010).
--
-- WHY THIS EXISTS. Phase 5b replaces the ~500-character passage with a screen-sized
-- page, which means every catalog book is re-chunked. Ingestion upserts chunks on
-- (book_id, "index"), so chunk_ids are STABLE across a re-cut: the rows survive, but
-- the text stored under each id is replaced. Every progress row would therefore keep
-- pointing at a chunk whose content it never described — a best_wpm earned on one
-- passage, silently re-attributed to a different one. Wrong bests are worse than no
-- bests, so all progress is discarded rather than migrated. There is no mapping from
-- old boundaries to new ones to migrate it with.
--
-- CONTEXT.md's Ingestion entry claims a re-ingest is safe because "chunk ids stay
-- stable, so progress survives". Stable ids keep the rows VALID, not MEANINGFUL; the
-- sentence is corrected in Phase 9. This migration is the practical consequence.
--
-- SCOPE. Data only — no schema change. The brief considered storing an estimated line
-- count on `chunks` and rejected it: nothing would read it, and a column no query reads
-- is a column that goes stale in silence.
--
-- SEQUENCING. This must land BEFORE the 12-book re-ingest, so that ingestion's
-- --allow-shrink and --allow-recut guards both report zero attempts at risk on every
-- book instead of asking for the same judgement call twelve times.
--
-- WHY `delete`, NOT `truncate`.
--   * 34 rows total at the time of writing (15 chunk_attempts, 15 chunk_progress,
--     4 book_progress). `truncate` buys nothing at this size.
--   * `truncate` needs table ownership and interacts badly with the SECURITY DEFINER
--     rollup function; `delete` needs neither.
--   * A data migration has no `if not exists` analogue. `delete` is idempotent by
--     nature: it re-runs harmlessly on a local `db reset`, where the seed migration
--     seeds books/chunks and never progress, so this is a three-way no-op there.
--
-- ORDER. Readability only, not correctness: the foreign keys on these three tables run
-- to auth.users, books and chunks — never between the three. chunk_attempts goes first
-- because it is the source of truth and the other two are rollups derived from it.
--
-- THE ROLLUP TRIGGER IS NOT INVOLVED. chunk_attempts_apply_rollups
-- (20260726002115_rollup_chunk_attempts.sql) is AFTER INSERT FOR EACH ROW — verified
-- against pg_trigger.tgtype = 5 (ROW | INSERT) on the linked project. Deleting attempts
-- fires nothing, so nothing recomputes or repopulates the rollups behind this migration,
-- and no session_replication_role / ALTER TABLE ... DISABLE TRIGGER dance is needed.
-- The flip side is that the rollup tables do NOT empty themselves when their source
-- does: both must be deleted explicitly, which is what the two statements below do.

-- No explicit begin/commit: the Supabase CLI already wraps each migration file in a
-- transaction, and an inner `begin` only emits a "transaction already in progress"
-- warning while the matching `commit` closes the outer transaction early.

delete from public.chunk_attempts;

delete from public.chunk_progress;

delete from public.book_progress;
