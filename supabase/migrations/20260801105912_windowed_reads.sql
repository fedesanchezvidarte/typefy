-- Phase 3b — windowed reads: the featured flag and resume-in-SQL (spec #18 §2, §7, §10).
--
-- The typing screen stops loading whole books. A window of chunks is server-rendered from a
-- resume index, and later windows arrive through a public endpoint. Two consequences reach the
-- database:
--
--   1. The landing hero needs to know WHICH book to type. 3a's manifest already validates
--      "at most one featured book per language", but 3a's migration never added the column, so
--      the flag had nowhere to land.
--   2. Resume can no longer be computed in the client. src/lib/progress/resume.ts's
--      firstIncompleteIndex scanned a client-side array of every chunk in the book — exactly the
--      array windowed reads no longer produce. The computation moves into SQL, where it reads
--      the whole book without sending it.
--
-- No new index is created, deliberately; the reasoning is recorded at the end of this file.

-- ---------------------------------------------------------------------------
-- books.featured — which book the landing hero types (spec #18 §7, §10).
-- ---------------------------------------------------------------------------
alter table books
add column featured boolean not null default false;

comment on column books.featured is 'True for the one book the landing hero types in this language. At most one per language, enforced by books_featured_per_language_idx. Written from the manifest by scripts/ingest.ts, never by a client.';

-- Partial unique index: the constraint applies only to the featured rows, so every other book
-- in a language is free. A plain `unique (language)` would allow exactly one book per language
-- in the whole catalog, which is the opposite of what Phase 3 is building.
--
-- This is what lets getHeroBook keep `.maybeSingle()` honestly: the database, not a convention,
-- guarantees the result set has at most one row. Naming follows the repo convention
-- (`<table>_<what>_idx`, cf. chunk_progress_user_book_idx, chunk_attempts_user_chunk_idx).
create unique index books_featured_per_language_idx on books (language)
where
	featured;

-- ---------------------------------------------------------------------------
-- first_incomplete_chunk_index — resume, computed in SQL (spec #18 §2).
--
-- SECURITY DEFINER + `set search_path = ''` + fully-qualified names throughout, matching the
-- convention of apply_chunk_attempt_rollups() (20260726002115) and handle_new_user().
--
-- DEFINER is needed because the function must read the book's FULL chunk list to find the first
-- gap, while the caller is only ever sent a window of it. It is also what makes the two
-- predicates below load-bearing rather than decorative:
--
--   * The user is derived from auth.uid() and is NEVER a parameter. A user-id argument on a
--     SECURITY DEFINER function that reads chunk_progress would let any signed-in caller read
--     any other user's resume position, because DEFINER bypasses the `user_id = auth.uid()`
--     policy that would otherwise stop them.
--
--   * The `published_at is not null` test is NOT redundant with 20260731120000's RLS policies:
--     DEFINER bypasses those too. Without it the function would compute a resume index for an
--     UNPUBLISHED book, and PostgREST exposes this at /rest/v1/rpc/first_incomplete_chunk_index
--     to every `authenticated` holder of the publishable key — so the route's own 404 is not
--     reached and is not a defence. It is a deliberate second copy of the publication-gating
--     rule; see the ADR-0006 amendment.
--
-- Everything unknowable collapses to the same answer, 0: fully complete, no progress at all,
-- unknown book id, unpublished book. There is no "finished" state (CONTEXT.md, Resume), so 0 is
-- a real answer rather than a sentinel — which is why an unpublished book is indistinguishable
-- from a book the caller simply has not started.
-- ---------------------------------------------------------------------------
create function public.first_incomplete_chunk_index (p_book_id uuid) returns integer language sql stable security definer
set
	search_path = '' as $$
	select coalesce(
		(
			select c."index"
			from public.chunks as c
			where c.book_id = p_book_id
				-- Uncorrelated: the planner evaluates it once as a one-time filter, so an
				-- unpublished (or unknown) book returns the empty set without touching a
				-- chunk row at all.
				and exists (
					select 1
					from public.books as b
					where b.id = p_book_id
						and b.published_at is not null
				)
				-- "Completed" is `first_completed_at is not null`, NEVER the mere existence of
				-- a chunk_progress row: the rollup trigger (20260726002115) writes a row on
				-- EVERY attempt, completed or not, so an abandoned passage leaves a row with
				-- attempt_count > 0 and first_completed_at null. Row-existence would resume the
				-- user PAST passages they abandoned. This test must stay identical to
				-- getCompletedChunkIds' in src/lib/server/progress.ts.
				and not exists (
					select 1
					from public.chunk_progress as cp
					where cp.user_id = (select auth.uid())
						and cp.chunk_id = c.id
						and cp.first_completed_at is not null
				)
			-- `order by ... limit 1` rather than `min("index")`: with the anti-join in the
			-- predicate Postgres cannot rewrite min() into an early-exit index scan, so it would
			-- probe chunk_progress once per chunk of a 2,000-chunk book. This form walks
			-- (book_id, "index") in order and stops at the first surviving row.
			order by c."index"
			limit 1
		),
		0
	);
$$;

comment on function public.first_incomplete_chunk_index (uuid) is 'Lowest chunk index in this published book with no completed attempt for auth.uid(). Returns 0 when the book is fully complete, unknown, or unpublished — there is no "finished" state (CONTEXT.md, Resume).';

-- Same hardening as 20260722185955 / 20260726002115: Postgres grants EXECUTE to PUBLIC on new
-- functions by default, so close that first, then open it to `authenticated` only. A guest calls
-- nothing — the load's `if (!user)` early return is the acceptance criterion — and `anon` has no
-- business reaching this at all (auth.uid() would be null there anyway, which is 0, but a
-- revoked grant is a refusal rather than a coincidence).
revoke execute on function public.first_incomplete_chunk_index (uuid)
from
	public,
	anon,
	authenticated;

grant execute on function public.first_incomplete_chunk_index (uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Indexes: none needed, checked rather than assumed.
--
--   * The chunk scan and its ordering are both served by `chunks unique (book_id, "index")`
--     (20260722161957) — the leading column filters, the second orders, so `order by "index"
--     limit 1` is an ordered index scan that stops at the first surviving row.
--   * The anti-join probes chunk_progress by (user_id, chunk_id), which is that table's PRIMARY
--     KEY (20260722162825).
--   * The publication `exists` probes books by primary key, once.
--
-- Every access path here is already an index-only-or-better lookup; adding one would be noise.
-- Same reasoning 20260731120000 recorded for its chunks policy.
-- ---------------------------------------------------------------------------
