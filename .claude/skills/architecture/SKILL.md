---
name: architecture
description: "System decomposition, database schema design, and Feature Briefs for Typefy. Use when designing a new feature's structure, planning database migrations, or defining module boundaries."
---

# Architecture Skill

## System Model

### Containers

| Container | Technology | Purpose |
|---|---|---|
| `webapp` | SvelteKit + TypeScript | Routes, load functions, actions, UI, typing engine |
| `supabase` | Supabase (PostgreSQL + Auth) | Database, Google Auth, RLS-protected progress data |
| `ingestion` | `scripts/ingest.ts` (offline) | Downloads/cleans public-domain texts, chunks them, seeds the DB |
| `vercel` | Vercel | Hosting + cron (keeps the Supabase free tier from pausing) |

### Container boundaries

- **webapp → supabase**: all DB access via the Supabase client (`@supabase/ssr` for SvelteKit). Never raw SQL from the app.
- **ingestion → supabase**: offline seeding only; the app never ingests at runtime (ADR-0006).
- **The typing engine is pure.** Engine modules in `src/lib/engine/` have no DOM, no Supabase, no SvelteKit imports — they are plain TypeScript, fully unit-testable (ADR-0004, ADR-0009).

### Dependency direction

Pure engine modules → services (`src/lib/server/`, Supabase-aware) → routes (`src/routes/`) → UI components. Dependencies point left; nothing on the left knows about the right.

## Core domain abstraction

Model everything on **typeable text**, not "book" (see `CONTEXT.md` glossary). Books are today's source of typeable texts; custom text comes later. Schema and module designs must not hard-wire book-only assumptions where a typeable text would do.

## Database schema conventions

### Naming
- **Tables**: `snake_case`, plural (`books`, `chunks`, `chunk_progress`)
- **Columns**: `snake_case` (`book_id`, `user_id`, `created_at`)
- **Foreign keys**: `{referenced_table_singular}_id`
- **Timestamps**: `created_at`, `updated_at` with `DEFAULT now()`

### Row Level Security (ADR-0002)
- Every table in `public` has RLS enabled.
- Catalog data (`books`, `chunks`) is publicly readable, writable only by the service role (ingestion).
- Progress data is strictly per-user: `user_id = auth.uid()` policies for SELECT/INSERT/UPDATE.

### Migrations
- Store in `supabase/migrations/`; create files with `supabase migration new <name>` (never invent filenames).
- Idempotent where practical (`IF NOT EXISTS`); wrap in a transaction.
- After schema changes, regenerate DB types (Supabase MCP `generate_typescript_types`) and keep app types in sync.

## TypeScript types

- Shared domain types live in `src/lib/types.ts` (engine types may live beside the engine in `src/lib/engine/`).
- Generated database types live in `src/lib/database.types.ts` — regenerate, don't hand-edit.
- `interface` for object shapes, `type` for unions/aliases (e.g. `CharacterState = 'pending' | 'correct' | 'corrected' | 'incorrect'`).

## Feature Brief template

Produced in Phase 1 from an approved spec; posted as a comment on the spec issue.

```markdown
## Feature Brief: [Feature Name] — Spec #[issue]

### Summary
[1-2 sentences]

### Affected layers
[Copy from the spec; confirm or correct it]

### Database changes
[Tables, columns, RLS policies, indexes — or "none"]

### Module graph
[Which src/lib/ modules, routes, and components are created/modified, and
who depends on whom]

### Dependency order
[Which phases run in what order; what can be parallel]

### Diagram (optional)
[Mermaid diagram for non-trivial flows]

### ADR check
[Existing ADRs this touches; new ADRs this work will need]
```

## Anti-Patterns

- Designing schema or modules around "book" where "typeable text" is the right abstraction.
- Letting Supabase or DOM imports leak into `src/lib/engine/`.
- Designing a table without deciding its RLS policy at the same time.
- Over-architecting: most Typefy features are new modules inside the existing webapp container.
- Making a significant decision (new dependency, new pattern, schema philosophy) without an ADR.
