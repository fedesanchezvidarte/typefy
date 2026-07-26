-- Phase 2b — rollup maintenance (spec #12, ADR-0010).
--
-- AFTER INSERT on chunk_attempts: fold the new immutable attempt into the two rollup
-- tables. This function is their SOLE writer — neither table has a client write policy
-- or grant. All rollup timestamps derive from new.created_at (the server clock,
-- `default now()`), never from the client-supplied started_at.
--
-- SECURITY DEFINER + empty search_path: fully-qualified names only, per the same
-- convention as handle_new_user() / touch_updated_at().

create function public.apply_chunk_attempt_rollups() returns trigger language plpgsql security definer
set
	search_path = '' as $$
begin
	-- ---------------------------------------------------------------------
	-- chunk_progress, per (user, chunk). Runs FIRST: book_progress below counts
	-- this table's post-upsert state, so this row must already reflect the new
	-- attempt. The two statements are ordered and cannot be swapped.
	--   attempt_count      +1 on EVERY insert, completed or not
	--   last_attempt_at    = new.created_at on every insert
	--   best_*             greatest(), COMPLETED attempts only
	--   first_completed_at written once on the first completion, never moved
	-- ---------------------------------------------------------------------
	insert into public.chunk_progress as cp (
		user_id,
		chunk_id,
		book_id,
		attempt_count,
		last_attempt_at,
		best_wpm,
		best_accuracy_raw,
		first_completed_at
	)
	values (
		new.user_id,
		new.chunk_id,
		new.book_id,
		1,
		new.created_at,
		case when new.completed then new.gross_wpm end,
		case when new.completed then new.accuracy_raw end,
		case when new.completed then new.created_at end
	)
	on conflict (user_id, chunk_id) do update
	set
		attempt_count = cp.attempt_count + 1,
		last_attempt_at = new.created_at,
		-- greatest() ignores NULLs in Postgres, so a first completion after a run of
		-- incomplete attempts seeds best_* correctly without a coalesce.
		best_wpm = case when new.completed then greatest(cp.best_wpm, new.gross_wpm) else cp.best_wpm end,
		best_accuracy_raw = case
			when new.completed then greatest(cp.best_accuracy_raw, new.accuracy_raw)
			else cp.best_accuracy_raw
		end,
		first_completed_at = case
			when new.completed then coalesce(cp.first_completed_at, new.created_at)
			else cp.first_completed_at
		end,
		book_id = new.book_id;

	-- ---------------------------------------------------------------------
	-- book_progress, per (user, book).
	--   last_active_at    = new.created_at on every insert
	--   chunks_completed  = how many of this user's chunks in this book have ever
	--                      been completed — COUNTED, not accumulated.
	--
	-- Counting distinct chunk_progress rows is what makes re-reading safe: three
	-- passes over a book show 100%, never 300%, because the value is a property of
	-- the table rather than a running total that could drift. It also cannot exceed
	-- the book's chunk count, since chunk_progress is keyed on (user_id, chunk_id).
	-- Still MAINTAINED on write (once per completion), not derived on read: a client
	-- reading a progress bar still reads one indexed book_progress row.
	-- ---------------------------------------------------------------------
	insert into public.book_progress as bp (user_id, book_id, chunks_completed, last_active_at)
	values (
		new.user_id,
		new.book_id,
		(
			select count(*)
			from public.chunk_progress as cp
			where cp.user_id = new.user_id
				and cp.book_id = new.book_id
				and cp.first_completed_at is not null
		),
		new.created_at
	)
	on conflict (user_id, book_id) do update
	set
		chunks_completed = excluded.chunks_completed,
		last_active_at = excluded.last_active_at;

	-- AFTER trigger: the return value is ignored.
	return null;
end;
$$;

create trigger chunk_attempts_apply_rollups
after insert on public.chunk_attempts for each row
execute function public.apply_chunk_attempt_rollups();

-- Same hardening as 20260722185955 applied to the pair created in 2a: close the REST
-- RPC surface Postgres opens by default. Trigger execution is unaffected — it does not
-- check the session role's EXECUTE privilege.
revoke execute on function public.apply_chunk_attempt_rollups()
from
	public,
	anon,
	authenticated;

-- ---------------------------------------------------------------------------
-- Make the "rollup timestamps come from the server clock" rule true rather than
-- merely intended. The trigger above never reads the client-supplied started_at
-- — but every rollup timestamp it writes is new.created_at, and 2a granted
-- INSERT at TABLE level, which covers every column including created_at. A
-- client could therefore post created_at = '1999-01-01' and steer
-- first_completed_at / last_attempt_at / last_active_at.
--
-- A column-level REVOKE cannot fix this: Postgres ignores it while the
-- table-level grant stands. The table grant is dropped and re-granted per
-- column instead, omitting created_at (and id) so both fall to their defaults.
-- SELECT is untouched — clients still read their own attempts in full.
-- ---------------------------------------------------------------------------
revoke insert on public.chunk_attempts
from
	authenticated;

grant insert (
	user_id,
	chunk_id,
	book_id,
	completed,
	gross_wpm,
	accuracy_raw,
	elapsed_ms,
	started_at
) on public.chunk_attempts to authenticated;
