-- Phase 2a — progress data model (spec #7 + its ADR).
--
-- Designed now, WRITTEN in 2b. This migration creates the tables and their RLS
-- policies only; nothing inserts into them yet, and the trigger that maintains the
-- rollups is 2b's (a trigger is behaviour, and 2b holds the tests that verify it).
--
-- Shape: an append-only history is the single source of truth, with two rollup tables
-- for cheap reads. The rollups are always rederivable by replaying chunk_attempts;
-- they are a cache, never the authority.
--
--   chunk_attempts  — append-only: one row per completed traversal of one chunk.
--   chunk_progress  — rollup per (user, chunk).
--   book_progress   — rollup per (user, book).

-- ---------------------------------------------------------------------------
-- chunk_attempts — the source of truth. Append-only: enforced by RLS granting
-- INSERT + SELECT but NO update and NO delete policy (and no update/delete grant),
-- so history can never be rewritten by a client.
-- book_id is denormalised so per-book queries need no join through chunks.
-- ---------------------------------------------------------------------------
create table chunk_attempts (
	id uuid primary key default gen_random_uuid(),
	user_id uuid not null references auth.users (id) on delete cascade,
	chunk_id uuid not null references chunks (id) on delete cascade,
	book_id uuid not null references books (id) on delete cascade,
	completed boolean not null,
	gross_wpm numeric not null check (gross_wpm >= 0),
	accuracy_raw numeric not null check (accuracy_raw >= 0 and accuracy_raw <= 1),
	elapsed_ms integer not null check (elapsed_ms >= 0),
	started_at timestamptz not null,
	created_at timestamptz not null default now()
);

-- Reading a user's history, and the 2b rollup logic, both scan by (user, book) / (user, chunk).
create index chunk_attempts_user_book_idx on chunk_attempts (user_id, book_id);

create index chunk_attempts_user_chunk_idx on chunk_attempts (user_id, chunk_id);

-- ---------------------------------------------------------------------------
-- chunk_progress — rollup per (user, chunk). Maintained by 2b's trigger, read cheaply.
-- ---------------------------------------------------------------------------
create table chunk_progress (
	user_id uuid not null references auth.users (id) on delete cascade,
	chunk_id uuid not null references chunks (id) on delete cascade,
	book_id uuid not null references books (id) on delete cascade,
	first_completed_at timestamptz,
	attempt_count integer not null default 0 check (attempt_count >= 0),
	best_wpm numeric check (best_wpm >= 0),
	best_accuracy_raw numeric check (best_accuracy_raw >= 0 and best_accuracy_raw <= 1),
	last_attempt_at timestamptz,
	primary key (user_id, chunk_id)
);

create index chunk_progress_user_book_idx on chunk_progress (user_id, book_id);

-- ---------------------------------------------------------------------------
-- book_progress — rollup per (user, book). Book completion % = chunks_completed / chunk_count.
-- ---------------------------------------------------------------------------
create table book_progress (
	user_id uuid not null references auth.users (id) on delete cascade,
	book_id uuid not null references books (id) on delete cascade,
	chunks_completed integer not null default 0 check (chunks_completed >= 0),
	last_active_at timestamptz,
	primary key (user_id, book_id)
);

-- ---------------------------------------------------------------------------
-- RLS: a user reads only their own progress. Rollups have no client write policy at
-- all — 2b's SECURITY DEFINER trigger maintains them. chunk_attempts is insert+select
-- only, which is how append-only is enforced structurally rather than by convention.
-- ---------------------------------------------------------------------------
alter table chunk_attempts enable row level security;

alter table chunk_progress enable row level security;

alter table book_progress enable row level security;

create policy "Users can view their own attempts" on chunk_attempts for select to authenticated using (
	(
		select auth.uid ()
	) = user_id
);

create policy "Users can record their own attempts" on chunk_attempts for insert to authenticated
with
	check (
		(
			select auth.uid ()
		) = user_id
	);

create policy "Users can view their own chunk progress" on chunk_progress for select to authenticated using (
	(
		select auth.uid ()
	) = user_id
);

create policy "Users can view their own book progress" on book_progress for select to authenticated using (
	(
		select auth.uid ()
	) = user_id
);

-- Grants match the policies: attempts are insert+select; rollups are select-only for
-- clients (the 2b definer trigger writes them). anon gets no access to any of these.
grant select, insert on chunk_attempts to authenticated;

grant select on chunk_progress to authenticated;

grant select on book_progress to authenticated;
