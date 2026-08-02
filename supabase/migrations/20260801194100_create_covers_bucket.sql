-- Phase 3c — the `covers` Storage bucket (spec #19, ADR-0006).
--
-- Covers are catalog metadata for world-readable content, prepared by hand and uploaded
-- offline by scripts/ingest.ts under the service role. They carry the same security model
-- as `books` and `chunks`: world-readable, client-unwritable, maintained outside the app.
--
-- The bucket lives in a migration rather than in supabase/config.toml so that `db reset`
-- and production are reproduced from the same source — and so the rule is stated once,
-- not a second time in a file production never reads.

insert into
	storage.buckets (
		id,
		name,
		public,
		file_size_limit,
		allowed_mime_types
	)
values
	(
		'covers',
		'covers',
		true,
		524288,
		array['image/png', 'image/jpeg']
	)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- The policies this migration deliberately does NOT create.
--
-- There are none, and the absence is the design. Read this before adding any.
--
--   Public read needs no SELECT policy. `public = true` makes the storage API serve
--   GET /storage/v1/object/public/covers/<path> without consulting RLS at all. That is
--   the exact URL books.cover_url stores and <img src> fetches, so the images load with
--   zero policies on storage.objects.
--
--   No client write, ever, is enforced by the ABSENCE of any insert/update/delete policy
--   for anon or authenticated. RLS on storage.objects is enabled by Supabase and is
--   deny-by-default, so adding nothing is what closes the write path. Uploads reach the
--   bucket only through the service role, which the storage API short-circuits before RLS
--   is consulted — the same asymmetry that lets ingestion write unpublished books.
--
--   A SELECT policy is omitted ON PURPOSE, not by oversight. Reads do not need one (see
--   above), and adding one would ENABLE enumeration: storage.from('covers').list() goes
--   through RLS, unlike the public object path. The slugs are public anyway, so listing
--   would leak nothing — but the minimum surface that satisfies the requirement is the
--   one to ship, and "we added a policy we did not need" is how a bucket quietly becomes
--   listable. To a future reader here to fix the missing SELECT policy: this is the fix,
--   and it is already applied.
--
-- ADR-0002 requires RLS on every table in `public`. storage.objects is not in `public`,
-- so that convention does not literally reach it; this block is its storage analogue, and
-- the place the gap is closed in prose rather than in a policy.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- file_size_limit = 524288 (512 KB) deliberately restates COVER_MAX_BYTES in
-- src/lib/ingest/cover.ts. One rule, two expressions — CHANGE BOTH.
--
-- The duplication runs in the safe direction. The pure module rejects first, before a
-- byte crosses the network, with a readable message naming the file and the limit; the
-- bucket is the backstop that still holds if something ever uploads outside the script.
-- allowed_mime_types plays the same backstop role for the format allow-list, which the
-- module derives from magic bytes rather than from the file extension.
-- ---------------------------------------------------------------------------
