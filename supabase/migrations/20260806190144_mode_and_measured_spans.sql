-- Phase 4a — mode as the measurement axis, and span-scoped metrics (spec #24, ADR-0010
-- amendment).
--
-- Until now every chunk_attempts row was written by an engine that measured the whole
-- passage, so `gross_wpm` / `accuracy_raw` could be `not null` and "what did this number
-- measure?" was answerable from the row's mere existence. Zen mode makes that false: a
-- passage the user asked not to be measured must write no metrics at all, and a passage
-- with a mid-way switch measured only part of itself. This migration makes the row carry
-- its own answer — what mode it was typed in, and how much of it was actually measured —
-- rather than leaving it assumed from the row's type.
--
-- Four steps, in order: columns, constraints, backfill, rollup rewrite; then the grant.

-- ---------------------------------------------------------------------------
-- 1. Columns.
--
-- The two metric columns become nullable because a Zen traversal genuinely has no WPM
-- and no accuracy — not "zero", not "unknown", but *not measured*. Writing 0 or a
-- partial figure would be a lie that best_wpm and every future stats screen would then
-- read as truth.
--
-- The two existing CHECKs (`gross_wpm >= 0`, `accuracy_raw between 0 and 1`) are
-- deliberately left alone: a CHECK evaluates to NULL — and therefore passes — on a NULL
-- input, so they keep constraining every non-NULL value without an edit.
--
-- `mode` is a text column rather than an enum: extending the axis is then a one-line
-- migration instead of an ALTER TYPE, while the CHECK below still stops a typo'd client
-- value from landing in the source-of-truth table.
--
-- All three columns are `not null` with a default, so the ALTER rewrites nothing (Postgres
-- stores the default in the catalog) and every pre-existing row is immediately valid
-- against the constraints added next — the defaults are exactly the fully-Normal
-- degenerate case, refined by the backfill in step 3.
-- ---------------------------------------------------------------------------
alter table public.chunk_attempts
	alter column gross_wpm drop not null,
	alter column accuracy_raw drop not null,
	add column mode text not null default 'normal',
	add column measured_ms integer not null default 0,
	add column measured_chars integer not null default 0;

comment on column public.chunk_attempts.mode is
	'Measurement axis: ''normal'' (measured) or ''zen'' (not measured). Presentation is a separate axis and must never become a third value here.';

comment on column public.chunk_attempts.measured_ms is
	'Milliseconds of measured span in this traversal. Equals elapsed_ms exactly when the whole traversal was Normal.';

comment on column public.chunk_attempts.measured_chars is
	'Characters typed within measured spans. The best_* guard floor is compared against this.';

-- ---------------------------------------------------------------------------
-- 2. Constraints.
--
-- `measured_ms <= elapsed_ms` is enforced here rather than merely asserted in a test:
-- elapsed_ms keeps its meaning (wall clock, first keystroke → completion) and the measured
-- span is by definition a subset of it, so a row violating this is an engine bug that
-- should be refused at the door rather than persisted and puzzled over later. It is safe
-- against the client's rounding — the write path rounds both, and round() is monotonic
-- non-decreasing, so `measured <= elapsed` in floats survives into integers.
--
-- `measured_chars` being `not null` is what lets the rollup guard below compare it
-- directly, with no coalesce and no NULL-swallows-the-predicate trap.
-- ---------------------------------------------------------------------------
alter table public.chunk_attempts
	add constraint chunk_attempts_mode_check check (mode in ('normal', 'zen')),
	add constraint chunk_attempts_measured_ms_check check (measured_ms >= 0 and measured_ms <= elapsed_ms),
	add constraint chunk_attempts_measured_chars_check check (measured_chars >= 0);

-- ---------------------------------------------------------------------------
-- 3. Backfill: every pre-existing row is fully-Normal.
--
-- This is true by construction, not by assumption. Every row written before 4a came from
-- an engine that had no notion of an unmeasured stretch: it always measured the whole
-- passage, and a completed traversal always covered the chunk's full character count. So
-- `measured_ms = elapsed_ms` and `measured_chars = chunks.char_count` restate what those
-- rows already meant, which is why existing best_* values stay valid and need no
-- recomputation.
--
-- No best_* value can move here even in principle: `chunk_attempts_apply_rollups` is an
-- AFTER **INSERT** trigger, and this is an UPDATE, so the trigger does not fire at all.
-- The acceptance criterion "no best_* value changed" is therefore satisfied structurally
-- rather than by care.
--
-- The constraints in step 2 are already in force at this point and the backfill cannot
-- violate them: elapsed_ms >= 0 is itself constrained, so measured_ms = elapsed_ms passes,
-- and char_count is a positive integer on every chunk.
-- ---------------------------------------------------------------------------
update public.chunk_attempts as ca
set
	mode = 'normal',
	measured_ms = ca.elapsed_ms,
	measured_chars = c.char_count
from public.chunks as c
where c.id = ca.chunk_id;

-- ---------------------------------------------------------------------------
-- 4. Rollup rewrite — NULL-safe and guard-aware.
--
-- Replaces the body created in 20260726002115. Everything load-bearing about that
-- function is preserved deliberately:
--   * the same SECURITY DEFINER + `set search_path = ''` + fully-qualified-names
--     convention as handle_new_user() / touch_updated_at();
--   * the same two statements in the same order — chunk_progress FIRST, because the
--     book_progress count below reads this table's post-upsert state. They cannot be
--     swapped;
--   * `attempt_count` and `last_attempt_at` still move on EVERY insert. A Zen attempt is
--     still an attempt;
--   * `first_completed_at` is still set by any completed attempt. **Zen progress is
--     progress** — completion, resume, book percentages and continue-reading behave
--     identically in both modes, and a user who reads a whole book in Zen has read a
--     whole book;
--   * the book_progress block is unchanged in meaning: chunks_completed is still COUNTED
--     from chunk_progress rather than accumulated, so re-reading a book shows 100% and
--     never 300%, and a Zen completion counts exactly like a Normal one.
--
-- What changes is only the two best_* arms. Previously `completed` alone was a sufficient
-- test, because a completed attempt always carried metrics. It no longer does, and two
-- further conditions now join it:
--
--   * `new.<metric> is not null` — a Zen row carries no figure, and greatest() would
--     happily leave the old best in place, but stating the test explicitly is what stops a
--     future reader from re-deriving "completed implies measured" from the old shape;
--   * `new.measured_chars >= 100` — the best guard. A measured span shorter than 100
--     characters (≈20 words) is stored but never sets a personal best. Chunks are 400-600
--     characters (ADR-0005), so a genuine passage clears this comfortably; what the floor
--     stops is a 20-character Normal sprint at the tail of an otherwise-Zen passage
--     banking an unbeatable rate. The literal 100 is the twin of the TypeScript constant
--     BEST_MEASURED_CHARS_FLOOR (src/lib/progress/client.ts) — change one and you must change the
--     other. It is a sanity floor, never an anti-cheat: measured_chars is client-asserted
--     exactly like gross_wpm (ADR-0012).
--
-- The guard is written out per column rather than hoisted into one shared boolean. The two
-- metrics are NULL together by construction today; an independent guard per column simply
-- cannot be broken by a future row where only one of them is set.
--
-- greatest() still ignores a NULL `cp.best_*`, so the original seeding behaviour — a first
-- completion after a run of incomplete attempts seeds best_* correctly with no coalesce —
-- survives untouched.
--
-- `create or replace function` preserves the object's privileges, so the
-- `revoke execute … from public, anon, authenticated` issued in 20260726002115 (and in
-- 20260722185955 for the earlier pair) still stands and is deliberately NOT re-issued
-- here. Trigger execution never checked the session role's EXECUTE privilege anyway.
-- ---------------------------------------------------------------------------
create or replace function public.apply_chunk_attempt_rollups() returns trigger language plpgsql security definer
set
	search_path = '' as $$
begin
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
	-- the table rather than a running total that could drift. It also cannot exceed
	-- the book's chunk count, since chunk_progress is keyed on (user_id, chunk_id).
	-- Still MAINTAINED on write (once per completion), not derived on read: a client
	-- reading a progress bar still reads one indexed book_progress row.
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
	return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Grant extension — ADDITIVE, and a silent-failure trap if missed.
--
-- 20260726002115 replaced the table-level INSERT grant with a column-level one so that
-- `id` and `created_at` fall to their defaults and a client cannot steer the rollup
-- timestamps. A column-level grant does not extend itself to columns added later, so
-- without this line an authenticated client posting the three new columns is refused with
-- 42501 — which the write path correctly classifies as *permanent*, meaning the attempt is
-- never buffered and never retried. Every completion would be dropped, quietly, for
-- signed-in users only.
--
-- This is deliberately a bare GRANT with **no preceding REVOKE**: revoking INSERT on the
-- table from `authenticated` would drop the eight existing column grants along with it and
-- break every write. `id` and `created_at` remain ungranted, exactly as before.
-- ---------------------------------------------------------------------------
grant insert (mode, measured_ms, measured_chars) on public.chunk_attempts to authenticated;
