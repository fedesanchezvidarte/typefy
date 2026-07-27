-- Phase 2c — attempt-buffer idempotency (spec #15, ADR-0010 amendment).
--
-- Makes a repeated drain a no-op at the database rather than by care. The drain writes
-- through PostgREST's `resolution=ignore-duplicates`, which emits ON CONFLICT DO NOTHING
-- — a construct that needs only the INSERT privilege the 2b column-level grant already
-- gives, never UPDATE (which chunk_attempts deliberately has no policy and no grant for).
--
-- A unique INDEX, not a unique CONSTRAINT: PostgREST only ever emits a column list
-- (`on_conflict=a,b,c`), never `ON CONFLICT ON CONSTRAINT`, so a named constraint buys
-- nothing it could use; the index is the smaller object, can later be rebuilt
-- CONCURRENTLY, and leaves no constraint that a future partial variant would have to be
-- dropped to change. Column-list inference works against either.
--
-- All three columns are `not null`, so there is no NULL-uniqueness caveat and no need for
-- `nulls not distinct`. Two genuine attempts by the same user at the same chunk sharing a
-- first-keystroke millisecond are not a real event: a real repeat attempt carries a
-- different started_at, still inserts, and still fires the 2b rollup trigger.
create unique index if not exists chunk_attempts_user_chunk_started_key on public.chunk_attempts (
	user_id,
	chunk_id,
	started_at
);

-- Observed, deliberately not acted on: chunk_attempts_user_chunk_idx (user_id, chunk_id)
-- is now a strict prefix of the index above and therefore redundant. Dropping it is out of
-- scope for spec #15, whose third database criterion is that nothing else changes.
