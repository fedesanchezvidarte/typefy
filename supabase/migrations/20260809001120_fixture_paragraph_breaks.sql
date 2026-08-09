-- Phase 5b — give the short E2E fixture real paragraph breaks (spec #32, brief §6 R9).
--
-- WHY THIS EXISTS. Phase 5b makes `\n` an ordinary typed character, and the whole point
-- of the short fixture book (src/lib/fixtures/tortoise.ts, seeded by
-- 20260722163000_seed_books.sql) is that E2E specs assert against a tiny, stable,
-- hand-written text instead of against catalog content. The fixture books are
-- hand-chunked and are NOT produced by the chunker, so the re-cut never reaches them:
-- without this migration they contain no newline at all, and every newline E2E would
-- have to target an ingested novel — exactly the fragility the short fixture exists to
-- prevent. Book content is not a test fixture.
--
-- WHAT CHANGES. One chunk: `tortoise-and-hare` index 2, the final chunk. It is chosen
-- because it is the chunk the fewest specs type on its own — index 0 is typed directly
-- by several tests, index 2 only by the whole-book loops — and because being last it
-- also exercises "complete a page whose text contains a newline".
--
-- MINIMAL CHURN, DELIBERATELY. Not one word is added, removed or reordered. Two
-- existing spaces become `\n`, splitting the chunk into three paragraphs at sentence
-- boundaries that were already there. Consequences, all intentional:
--   * char_count is unchanged (448) — a space and a newline are both one character.
--   * The chunk still ends with terminal punctuation (never cuts a sentence, ADR-0005).
--   * It never begins or ends with `\n`, and paragraphs are joined by a SINGLE `\n`.
--   * Every character stays inside the typeable set (ADR-0013): the newline is already
--     admitted, so the G1 database-level guard in e2e/catalog-integrity.e2e.ts
--     (/^[\x20-\x7E\náéíóúüñÁÉÍÓÚÜÑ¿¡\n]*$/u) still passes on this row.
--
-- Written as an E'' escape string on purpose. A literal newline inside a dollar-quoted
-- block is invisible on review and one reformat away from being lost; `\n` is legible
-- and diffable.
--
-- char_count is a plain NOT NULL column with a `> 0` check — not generated, and no
-- trigger maintains it (verified against pg_trigger: `chunks` carries no triggers at
-- all). It is therefore set here from length() of the very literal being written, so
-- the two cannot drift.
--
-- IDEMPOTENT. `is distinct from` makes a re-run match zero rows. On a fresh
-- `db reset` the seed migration inserts the original text first and this updates it, so
-- local and hosted stacks converge on identical content either way.
--
-- NOTE FOR THE OPERATOR: on the linked hosted project `tortoise-and-hare` does not
-- exist — the seed migration was recorded as applied there before the short fixture was
-- added to it, and a regenerated migration is never re-run. This statement is therefore
-- a legitimate 0-row no-op against the hosted project and a 1-row update locally, where
-- the E2E suite actually runs. Backfilling that missing book is a separate decision and
-- is deliberately not smuggled into this migration.

-- No explicit begin/commit: the Supabase CLI already wraps each migration file in a
-- transaction, and an inner `begin` only emits a "transaction already in progress"
-- warning while the matching `commit` closes the outer transaction early.

with amended (slug, chunk_index, content) as (
	values (
		'tortoise-and-hare',
		2,
		E'The afternoon grew warm and the hare slept far longer than he had meant to. When at last he woke and remembered the race, he ran as he had never run before, and the wind of his going bent the grass on either side of the road.\nBut the road ahead of him was empty. He came over the last rise and saw the tortoise standing quietly at the mark, with the fox beside him and the animals of the wood cheering.\nSlow and steady, said the fox, wins the race.'
	)
)
update public.chunks as c
set
	content = a.content,
	char_count = length(a.content)
from amended as a
	join public.books as b on b.slug = a.slug
where c.book_id = b.id
	and c."index" = a.chunk_index
	and c.content is distinct from a.content;
