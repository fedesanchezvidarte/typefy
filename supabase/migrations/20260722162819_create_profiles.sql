-- Phase 2a — user identity: profiles (spec #7).
--
-- One profile row per auth.users row, created automatically by a trigger so no code
-- path ever has to cope with a signed-in user lacking a profile. A user owns and may
-- read/update only their own profile (RLS on auth.uid() = id). Rows are never deleted
-- directly — they cascade away when the auth.users row is deleted.
--
-- `locale` is nullable on purpose: NULL means "no explicit preference", which is what
-- lets the cookie and Accept-Language tiers still apply in the detection chain
-- (profile > cookie > Accept-Language > EN).

create table profiles (
	id uuid primary key references auth.users (id) on delete cascade,
	display_name text,
	avatar_url text,
	locale text check (locale in ('en', 'es')),
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Keep updated_at honest on every row change.
-- SECURITY DEFINER + empty search_path: fully-qualified names only, per Supabase
-- security guidance (avoids the mutable-search_path advisor warning).
-- ---------------------------------------------------------------------------
create function public.touch_updated_at() returns trigger language plpgsql security definer
set
	search_path = '' as $$
begin
	new.updated_at := now();
	return new;
end;
$$;

create trigger profiles_touch_updated_at before update on profiles for each row
execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Create a profile whenever a new auth user is created. Runs as the definer so it
-- can insert into public.profiles regardless of the new user's own grants. Display
-- name and avatar are seeded from the OAuth identity metadata when present; locale
-- is left NULL so the request-time detection chain governs it until the user chooses.
-- ---------------------------------------------------------------------------
create function public.handle_new_user() returns trigger language plpgsql security definer
set
	search_path = '' as $$
begin
	insert into public.profiles (id, display_name, avatar_url)
	values (
		new.id,
		coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
		coalesce(new.raw_user_meta_data ->> 'avatar_url', new.raw_user_meta_data ->> 'picture')
	);
	return new;
end;
$$;

create trigger on_auth_user_created after insert on auth.users for each row
execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- RLS: a user sees and edits only their own profile. No delete policy (cascade only).
-- ---------------------------------------------------------------------------
alter table profiles enable row level security;

create policy "Users can view their own profile" on profiles for select to authenticated using (
	(
		select auth.uid ()
	) = id
);

create policy "Users can insert their own profile" on profiles for insert to authenticated
with
	check (
		(
			select auth.uid ()
		) = id
	);

create policy "Users can update their own profile" on profiles for update to authenticated using (
	(
		select auth.uid ()
	) = id
)
with
	check (
		(
			select auth.uid ()
		) = id
	);

-- Table-level grants (automatic exposure of new tables is disabled). anon gets nothing.
grant select, insert, update on profiles to authenticated;
