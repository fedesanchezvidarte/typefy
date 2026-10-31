# Development

Everything needed to run, test and change Typefy locally. For what the app is, see the [README](../README.md).

Requires **Node 22** (see `engines` in `package.json`) and **npm**.

```bash
npm install
npm run dev
```

| Command                    | Purpose                               |
| -------------------------- | ------------------------------------- |
| `npm run dev`              | Start the dev server                  |
| `npm run build`            | Production build (`adapter-vercel`)   |
| `npm run preview`          | Preview the production build          |
| `npm run check`            | Type check with `svelte-check`        |
| `npm run lint`             | Prettier check + ESLint               |
| `npm run format`           | Format with Prettier                  |
| `npm run test:unit`        | Vitest (node + browser-mode projects) |
| `npm run test:e2e`         | Playwright end-to-end tests           |
| `npm run check:i18n`       | EN/ES message key parity check        |
| `npm run check:migrations` | Applied migrations are append-only    |

`check:migrations` fails when the branch modifies, deletes, or renames a migration file that already
exists at the merge-base with `origin/main` — corrections belong in a new migration, because a
database that already applied the old file never replays the edit. A migration added on the current
branch stays freely editable. It also runs on `pre-commit` (over staged changes only) and is only as
fresh as your local `origin/main`, so `git fetch` before trusting a local pass. Set
`MIGRATIONS_APPEND_ONLY_BASE_REF` to compare against a different ref — useful on a fork with no
`origin/main`. Locally the check skips with a warning when that ref is missing; in CI it fails
instead, so a broken checkout can never report a silent pass.

CI (GitHub Actions) runs the parity and append-only checks, lint, type check, unit tests and E2E on every PR to
`main` and push to `main`, on Node 22. Deploys go out via Vercel on push to `main`, with preview
deployments per PR.

## Local backend (Supabase + Docker)

From Phase 2 on, the app talks to a Postgres database, an auth service, and a REST API — all provided
by Supabase. For local development you run the **entire Supabase stack on your own machine** inside
Docker, so you never touch the hosted (production) database while building. This section assumes **no
prior Docker experience**.

### What is Docker here, in one paragraph

Supabase locally is not one program but about ten (Postgres, the Auth service, a REST API, the Studio
dashboard, a fake mail inbox, and more) that must run together at matching versions. **Docker** packages
each of those as a ready-made **image** (a frozen snapshot of software) and runs each image as a
**container** (a running instance of it). You don't install Postgres or configure any of this by hand —
the Supabase CLI pulls the images and starts the containers for you. The one thing to remember: the
**Docker engine must be running** (via Docker Desktop) before any `db:*` command below will work.

### One-time prerequisites

| Requirement        | Notes                                                                                                                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Docker Desktop** | Install from [docker.com](https://www.docker.com/products/docker-desktop/). On Windows it uses WSL2 under the hood — accept the WSL2 prompts during install. Launch it and wait until it reports "Engine running" before continuing. |
| **`.env` file**    | Copy `.env.example` to `.env` and fill in the values (Supabase keys from the project dashboard; Google OAuth credentials — see below). `.env` is gitignored; never commit it.                                                        |
| **Dependencies**   | `npm install` (installs the Supabase CLI as a dev-dependency — no global install needed).                                                                                                                                            |

You do **not** install the Supabase CLI globally; it is pinned in `package.json` and run via the
`db:*` scripts, so every contributor uses the same version.

### Running the local stack

| Command             | Purpose                                                                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run db:start`  | Start the local stack. **First run pulls ~10 images (several minutes)**; later runs take seconds. Prints the local URLs and keys when ready.                                               |
| `npm run db:stop`   | Stop the stack and free memory. **Your data is preserved** in a Docker volume — this is not a reset.                                                                                       |
| `npm run db:status` | Reprint the local URLs and keys of a running stack.                                                                                                                                        |
| `npm run db:reset`  | **Wipe the local database** and replay every migration (and the seed) from scratch. Your "undo" button while developing — it only ever affects the _local_ database, never the hosted one. |

Once started, the useful local URLs are:

| Service             | URL                    | What it is                                                                                           |
| ------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------- |
| **Studio**          | http://127.0.0.1:54323 | The Supabase dashboard, pointed at your _local_ database. Inspect tables and rows here.              |
| **API**             | http://127.0.0.1:54321 | What the app talks to in local dev.                                                                  |
| **Mailpit** (inbox) | http://127.0.0.1:54324 | Catches every email the local Auth service "sends" (magic links, etc.). Nothing leaves your machine. |

> **The local keys are not secrets.** `supabase start` prints an `anon`/`service_role` key and a JWT
> secret that are **shared, fixed defaults** — identical on every developer's machine. They are safe to
> use in local test config. This is the opposite of your **hosted** keys (in `.env`, from the
> dashboard), which are genuine secrets. Same shape, opposite handling — the difference is
> local-vs-hosted.

### Google OAuth for local sign-in

The hosted project reads its Google credentials from the Supabase dashboard. The **local** stack reads
them from your `.env` via `env()` substitution in `supabase/config.toml`
(`SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID` / `SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET`). The Google OAuth
client (in Google Cloud Console) must list **both** callback URLs as authorized redirect URIs:

- Hosted: `https://<your-project-ref>.supabase.co/auth/v1/callback`
- Local: `http://127.0.0.1:54321/auth/v1/callback`

After changing any provider values in `.env` or `config.toml`, run `npm run db:stop && npm run db:start`
for the change to take effect.

### Schema changes: migrations, seed, and types

The committed migrations are the **single source of truth** for the schema. Never change the schema in
the hosted dashboard — that causes local/hosted drift.

1. `npx supabase migration new <name>` scaffolds a timestamped file in `supabase/migrations/`.
2. Write the SQL (always include explicit `enable row level security` + policies for new tables).
3. `npm run db:reset` — apply and test locally.
4. Commit the migration.
5. `npm run db:push` — apply to the hosted project (prompts for the database password).

| Command                    | Purpose                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| `npm run db:seed:generate` | Regenerate the seed migration from `src/lib/fixtures/` (keeps fixtures the single source). |
| `npm run db:types`         | Regenerate `src/lib/database.types.ts` from the local schema. Run after any schema change. |

After DDL changes, check the Supabase security advisors (zero issues expected). Every `db push` prints a
cosmetic `pg-delta` "failed to cache migrations catalog" warning — it is unrelated to whether the
migration applied; ignore it.

### Troubleshooting

| Symptom                                                                      | Fix                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `db:start` errors with "Docker Desktop is unable to start" or a daemon error | The Docker engine isn't up. Open Docker Desktop and wait for "Engine running". On Windows, if `wsl --status` hangs, WSL2 itself is wedged — reboot, or repair via Docker Desktop → Settings → reset. |
| `db:start` hangs or a container is unhealthy                                 | `npm run db:stop`, then `npm run db:start` again. If still stuck, `npx supabase stop --no-backup` and restart.                                                                                       |
| Ports already in use (`54321`–`54324`)                                       | Another stack (or a stale container) is running: `npm run db:stop`, or check Docker Desktop's Containers list.                                                                                       |
| Local database in a bad state after a failed migration                       | `npm run db:reset` — rebuilds it cleanly from migrations. Local only; never touches production.                                                                                                      |
| Provider/config change didn't apply                                          | Config is read at startup only: `npm run db:stop && npm run db:start`.                                                                                                                               |

## i18n

The UI is bilingual (EN/ES) with Paraglide. The URL is authoritative: `/` serves English,
`/es` serves Spanish. On a first visit to an unprefixed URL the server negotiates
cookie > `Accept-Language` > English. The UI locale governs interface strings only — the
language of typeable text content is data and fully independent of the UI language.

