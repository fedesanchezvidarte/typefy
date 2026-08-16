-- Phase 5g — resetting a book's progress (spec #51).
--
-- The FIRST destructive path in this schema. Everything before it is insert-only: the
-- rollups have no client write policy or grant at all, and chunk_attempts is append-only
-- by construction (INSERT + SELECT, no UPDATE/DELETE policy, no UPDATE/DELETE grant).
--
-- The design problem this migration solves is stated in 20260722162825:
--
--   "an append-only history is the single source of truth, with two rollup tables for
--    cheap reads. The rollups are always rederivable by replaying chunk_attempts; they
--    are a cache, never the authority."
--
-- Deleting chunk_progress while keeping chunk_attempts would leave the rollups NO LONGER
-- DERIVABLE from the history: a replay would restore every completion, and the cache and
-- the authority would permanently disagree. Deleting the history instead would destroy
-- every WPM and accuracy figure the user ever produced on that book.
--
-- So a reset RECORDS ITSELF, and the invariant is restated rather than broken:
--
--   the rollups are derivable by replaying the chunk_attempts whose started_at is later
--   than that book's most recent reset_at.

-- ---------------------------------------------------------------------------
-- progress_resets — authority, not cache.
--
-- It is the only record that a completion which really happened should stop counting, so
-- it gets the properties the other authoritative table has rather than the properties of
-- the rollups. Deliberately NOT a column on book_progress: that would put the
-- authoritative record inside a table documented as "a cache, never the authority", and
-- inside the very row a reset deletes.
--
-- APPEND-ONLY, and no unique key on (user_id, book_id): one row per reset EVENT. A second
-- reset needs no special case because every consumer reads max(reset_at), which makes the
-- composition rule uniform.
-- ---------------------------------------------------------------------------
create table progress_resets (
	id uuid primary key default gen_random_uuid(),
	user_id uuid not null references auth.users (id) on delete cascade,
	book_id uuid not null references books (id) on delete cascade,
	-- Server clock, never the client's — the same rule the rollup trigger applies to
	-- created_at. A client-supplied boundary would let a user re-date their own resets.
	reset_at timestamptz not null default now()
);

-- Every read of this table is the same lookup: "the latest reset for this user and book".
-- It also covers both FK columns (advisor 0001).
create index progress_resets_user_book_idx on progress_resets (user_id, book_id);

alter table progress_resets enable row level security;

create policy "Users can view their own resets" on progress_resets for select to authenticated using (
	(
		select auth.uid ()
	) = user_id
);

-- No INSERT policy and no INSERT grant: the RPC below is a SECURITY DEFINER function and
-- writes this table as its owner. Clients never insert here directly, so there is no path
-- by which one could record a reset it did not perform.
grant select on progress_resets to authenticated;

-- ---------------------------------------------------------------------------
-- The rollup trigger becomes RESET-AWARE.
--
-- chunk_attempts CAN ARRIVE LATE. The attempt buffer replays completions that failed to
-- write (offline, 5xx, a token mid-refresh) on mount, on reconnect, and after any
-- successful write. So a page completed BEFORE a reset can be inserted AFTER it, and the
-- trigger as it stood would faithfully recreate its chunk_progress row and re-mark the
-- page completed.
--
-- The timestamps make that worse rather than better: every rollup timestamp derives from
-- new.created_at (server clock at insert), so a drained attempt looks to the rollups like
-- it happened at drain time.
--
-- Hence the guard below. The attempt is STILL INSERTED into chunk_attempts — history is
-- append-only and the traversal really happened — but both rollup upserts are skipped.
--
-- Three things about it, stated rather than discovered later:
--
--   * It reads new.started_at where this function uses created_at for every timestamp it
--     WRITES. A deliberate exception: the question being asked is "when was this typed",
--     not "when did this land", and only started_at answers it.
--   * started_at is CLIENT-SUPPLIED and therefore spoofable. The only thing a user can do
--     with that is misrepresent their own progress.
--   * A client with a badly skewed clock can produce a started_at before a reset it
--     actually followed, losing rollup credit for that page. Accepted: the attempt is
--     still in history and the page is re-completable by typing it.
--
-- Doing this server-side is what makes it hold ACROSS DEVICES. No client-side buffer purge
-- could: a reset performed on a phone cannot clear a laptop's queue.
--
-- The whole function is replaced rather than patched, because `create or replace` is the
-- only way to change a function body and this file must carry the version that runs.
--
-- **This body is 20260806190144's, with the guard added and NOTHING else changed.** That
-- matters more than it looks: the 4a version is the third of this function, not the
-- second, and it gates `best_*` on a non-NULL metric AND `measured_chars >= 100` (spec #24
-- — a Zen traversal carries NULL figures, and the 100-character floor keeps a trivial tail
-- from setting a personal best). Re-issuing 20260726002115's body with a guard bolted on
-- would have silently reverted both rules while every migration still applied cleanly.
-- ---------------------------------------------------------------------------
create or replace function public.apply_chunk_attempt_rollups() returns trigger language plpgsql security definer
set
	search_path = '' as $$
begin
	-- The reset boundary, and the only thing this migration adds to the function. Skips
	-- BOTH rollup upserts while still returning `new`, so the INSERT into chunk_attempts
	-- proceeds untouched.
	--
	-- STRICTLY earlier — `>`, never `>=`, and the direction of the tie-break is chosen
	-- rather than incidental. The two ways this rule can be wrong are not symmetrical:
	--
	--   * A FALSE SKIP — fresh typing after a reset silently fails to count — is confusing,
	--     invisible, and persists for as long as the cause does.
	--   * A FALSE COUNT — one pre-reset page re-marks itself completed — is minor, visible,
	--     and fixed by resetting again.
	--
	-- So a tie counts. This matters more than an exact-equality edge case suggests, because
	-- `started_at` is the CLIENT's clock and `reset_at` is the SERVER's: a browser running a
	-- few seconds behind would otherwise have its first post-reset pages discarded, and a
	-- badly skewed one would lose every page until real time caught up. Favouring the
	-- typist bounds that failure to the benign direction.
	if exists (
		select 1
		from public.progress_resets as pr
		where pr.user_id = new.user_id
			and pr.book_id = new.book_id
			and pr.reset_at > new.started_at
	) then
		return new;
	end if;

	-- ---------------------------------------------------------------------
	-- chunk_progress, per (user, chunk). Runs FIRST: book_progress below counts
	-- this table's post-upsert state, so this row must already reflect the new
	-- attempt. The two statements are ordered and cannot be swapped.
	--   attempt_count      +1 on EVERY insert, completed or not, Zen included
	--   last_attempt_at    = new.created_at on every insert
	--   best_*             greatest(), COMPLETED attempts with a non-NULL metric and
	--                      at least BEST_MEASURED_CHARS_FLOOR measured characters
	--   first_completed_at written once on the first completion, never moved, Zen included
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
		case when new.completed and new.gross_wpm is not null and new.measured_chars >= 100 then new.gross_wpm end,
		case when new.completed and new.accuracy_raw is not null and new.measured_chars >= 100 then new.accuracy_raw end,
		case when new.completed then new.created_at end
	)
	on conflict (user_id, chunk_id) do update
	set
		attempt_count = cp.attempt_count + 1,
		last_attempt_at = new.created_at,
		-- greatest() ignores NULLs in Postgres, so a first qualifying completion after a run
		-- of incomplete, Zen or below-floor attempts seeds best_* correctly without a coalesce.
		best_wpm = case
			when new.completed and new.gross_wpm is not null and new.measured_chars >= 100
				then greatest(cp.best_wpm, new.gross_wpm)
			else cp.best_wpm
		end,
		best_accuracy_raw = case
			when new.completed and new.accuracy_raw is not null and new.measured_chars >= 100
				then greatest(cp.best_accuracy_raw, new.accuracy_raw)
			else cp.best_accuracy_raw
		end,
		first_completed_at = case
			when new.completed then coalesce(cp.first_completed_at, new.created_at)
			else cp.first_completed_at
		end,
		book_id = new.book_id;

	-- ---------------------------------------------------------------------
	-- book_progress, per (user, book). Unchanged from 20260726002115.
	--   last_active_at    = new.created_at on every insert
	--   chunks_completed  = how many of this user's chunks in this book have ever
	--                      been completed — COUNTED, not accumulated.
	--
	-- Counting distinct chunk_progress rows is what makes re-reading safe: three
	-- passes over a book show 100%, never 300%, because the value is a property of
	-- the table rather than a running total that could drift. It is also what makes a
	-- RESET self-healing: with the chunk_progress rows deleted, the first attempt after
	-- a reset recreates this row counting 1, not the pre-reset total.
	--
	-- Mode does not appear here, and that is the point: a Zen completion sets
	-- first_completed_at above and is therefore counted here identically to a Normal one.
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
	return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- reset_book_progress — the sole writer of the delete path.
--
-- SECURITY DEFINER is what lets the rollups stay CLIENT-UNWRITABLE. The alternative —
-- delete/update policies and grants on chunk_progress and book_progress — would hand every
-- client a permanent DELETE grant on a progress table in order to enable one button, and
-- let a bug anywhere in the app silently drop progress rows.
--
-- auth.uid() is read INSIDE the function, so the caller cannot name a user. The only
-- parameter is which book.
--
-- Both rollup rows are DELETED, not zeroed. After a reset the cache's correct content for
-- this book is nothing — exactly the state of a user who never opened it. A zeroed
-- book_progress row would invent a third state ("touched, then un-touched") that no other
-- code path can produce and every reader would have to tolerate. It also discards
-- last_active_at, which is the right loss: that column records when the user last TYPED,
-- and a reset is not typing.
--
-- Unconditional and idempotent in effect: resetting a book with no progress records the
-- marker and deletes nothing, rather than branching. One transaction, so a reader can
-- never observe the marker without the deletions or the deletions without the marker.
-- ---------------------------------------------------------------------------
create function public.reset_book_progress (p_book_id uuid) returns void language plpgsql security definer
set
	search_path = '' as $$
declare
	v_user_id uuid := (select auth.uid());
begin
	if v_user_id is null then
		-- Belt and braces: execute is revoked from anon below, so this is unreachable
		-- through PostgREST. It exists so that a future caller in another context cannot
		-- delete every row whose user_id happens to be null-compared.
		raise exception 'reset_book_progress requires an authenticated user';
	end if;

	-- The marker FIRST. If anything below failed, a reset row with the rollups intact is
	-- recoverable by resetting again; rollups deleted with no marker recorded is the state
	-- that breaks the derivability invariant, and it is the one this order cannot produce.
	insert into public.progress_resets (user_id, book_id)
	values (v_user_id, p_book_id);

	delete from public.chunk_progress as cp
	where cp.user_id = v_user_id
		and cp.book_id = p_book_id;

	delete from public.book_progress as bp
	where bp.user_id = v_user_id
		and bp.book_id = p_book_id;
end;
$$;

comment on function public.reset_book_progress (uuid) is 'Clears auth.uid()''s progress rollups for one book and records the reset in progress_resets. chunk_attempts is never touched — history is preserved and the rollups stay derivable from the attempts whose started_at follows the reset (CONTEXT.md, Progress reset).';

-- Same hardening as 20260722185955 / 20260726002115 / 20260801105912: Postgres grants
-- EXECUTE to PUBLIC on new functions by default, so close that first, then open it to
-- `authenticated` only. A guest has no progress to reset, and `anon` reaching a destructive
-- function should be a refusal rather than a coincidence of auth.uid() being null.
revoke execute on function public.reset_book_progress (uuid)
from
	public,
	anon,
	authenticated;

grant execute on function public.reset_book_progress (uuid) to authenticated;
