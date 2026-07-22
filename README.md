# Typefy

A typing web app whose core engagement is **writing and "reading" long texts at the same time**. You
type through real books, seeing live feedback on every keystroke, and your progress is saved and synced
across devices.

> **Status:** Phases 0–1 complete; Phase 2a in progress. The scaffold, baseline EN/ES i18n, testing
> harnesses, CI/Vercel deploy, and the typing engine are in place; the Supabase backend foundation
> (schema, RLS, seeded books) has landed, with auth and content-from-database underway. See
> [`CONTEXT.md`](CONTEXT.md) and the [ADRs](docs/adr/).

## Concept

Most typing trainers throw random words at you. Typefy turns typing practice into reading a book: the
central unit is a **typeable text** (today a public-domain book, later custom text), split into
paragraph-sized **chunks** you complete one short session at a time. Finish enough chunks and you've
typed — and read — the whole book.

## Features (MVP scope)

- **Type through public-domain books** — English (Project Gutenberg) and Spanish (Cervantes Virtual and
  similar sources).
- **Live typing feedback** — per-character states: correct (green) and incorrect (red). Only current
  mistakes are highlighted; a fixed error renders like a correct character but still counts against
  accuracy. A chunk only completes when every mistake has been fixed.
- **Metrics** — WPM and raw accuracy, with live updates (by word / line / page).
- **Game modes** — **Normal** (tracks WPM + accuracy) and **Zen** (no tracking, just completion %).
- **Google login (optional)** — the app works without an account; signing in enables cross-device
  progress sync.
- **Bilingual UI** — English and Spanish, with browser-language detection and a persisted preference.

_Deferred beyond the MVP: custom text mode, accent strictness modes (hardcore vs relaxed), achievements,
and keyboard-layout selection._

## Tech stack

| Layer               | Choice                                                         |
| ------------------- | -------------------------------------------------------------- |
| Framework           | SvelteKit + TypeScript                                         |
| Backend / Auth / DB | Supabase (Postgres + Google OAuth + Row Level Security)        |
| Hosting             | Vercel                                                         |
| i18n                | Paraglide (EN/ES)                                              |
| Styling             | Tailwind CSS (+ Svelte scoped CSS for the engine & animations) |
| Testing             | Vitest (unit / TDD) + Playwright (E2E)                         |

Every choice is documented with its context, trade-offs and alternatives in the
[Architecture Decision Records](docs/adr/).

## Architecture at a glance

- **Data model** — `books` (lightweight metadata, feeds the catalog) and `chunks` (text content, loaded
  on demand per book), both in Supabase.
- **Ingestion** — an offline script (`scripts/ingest.ts`) downloads a public-domain text, strips source
  headers/footers, normalizes it, splits it into paragraph chunks, and seeds the database. Adding a book
  is a script run, not a redeploy.
- **Typing engine** — a hidden input rendering per-character spans (not a `<textarea>`). Text is read
  from `beforeinput`/`input` events (so dead-key/IME composition yields the final composed character),
  with `keydown` for control keys only ([ADR-0004](docs/adr/0004-typing-engine-model.md)). This is the
  core of the product and the most heavily tested part.

## Testing

Testing is treated as a first-class feature, not an afterthought. The typing engine, metrics, chunking,
and ingestion cleaner are pure logic built **test-first** with Vitest; Playwright covers end-to-end
typing flows (keydown, backspace, correction, accents). See
[ADR-0009](docs/adr/0009-vitest-playwright-testing.md).

## Roadmap

| Phase | Goal                                                          |
| ----- | ------------------------------------------------------------- |
| **0** | Scaffolding + baseline i18n, empty deploy to Vercel + CI      |
| **1** | Typing engine (TDD) over hardcoded text — the core            |
| **2** | Supabase + Auth + early progress sync against one seeded book |
| **3** | Ingestion pipeline + catalog of 10-20 books                   |
| **4** | Game modes + polish + E2E coverage                            |

## Development

Requires **Node 22** (see `engines` in `package.json`) and **npm**.

```bash
npm install
npm run dev
```

| Command              | Purpose                               |
| -------------------- | ------------------------------------- |
| `npm run dev`        | Start the dev server                  |
| `npm run build`      | Production build (`adapter-vercel`)   |
| `npm run preview`    | Preview the production build          |
| `npm run check`      | Type check with `svelte-check`        |
| `npm run lint`       | Prettier check + ESLint               |
| `npm run format`     | Format with Prettier                  |
| `npm run test:unit`  | Vitest (node + browser-mode projects) |
| `npm run test:e2e`   | Playwright end-to-end tests           |
| `npm run check:i18n` | EN/ES message key parity check        |

CI (GitHub Actions) runs the parity check, lint, type check, unit tests and E2E on every PR to
`main` and push to `main`, on Node 22. Deploys go out via Vercel on push to `main`, with preview
deployments per PR.

### Local backend (Supabase + Docker)

From Phase 2 on, the app talks to a Postgres database, an auth service, and a REST API — all provided
by Supabase. For local development you run the **entire Supabase stack on your own machine** inside
Docker, so you never touch the hosted (production) database while building. This section assumes **no
prior Docker experience**.

#### What is Docker here, in one paragraph

Supabase locally is not one program but about ten (Postgres, the Auth service, a REST API, the Studio
dashboard, a fake mail inbox, and more) that must run together at matching versions. **Docker** packages
each of those as a ready-made **image** (a frozen snapshot of software) and runs each image as a
**container** (a running instance of it). You don't install Postgres or configure any of this by hand —
the Supabase CLI pulls the images and starts the containers for you. The one thing to remember: the
**Docker engine must be running** (via Docker Desktop) before any `db:*` command below will work.

#### One-time prerequisites

| Requirement        | Notes                                                                                                                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Docker Desktop** | Install from [docker.com](https://www.docker.com/products/docker-desktop/). On Windows it uses WSL2 under the hood — accept the WSL2 prompts during install. Launch it and wait until it reports "Engine running" before continuing. |
| **`.env` file**    | Copy `.env.example` to `.env` and fill in the values (Supabase keys from the project dashboard; Google OAuth credentials — see below). `.env` is gitignored; never commit it.                                                        |
| **Dependencies**   | `npm install` (installs the Supabase CLI as a dev-dependency — no global install needed).                                                                                                                                            |

You do **not** install the Supabase CLI globally; it is pinned in `package.json` and run via the
`db:*` scripts, so every contributor uses the same version.

#### Running the local stack

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

#### Google OAuth for local sign-in

The hosted project reads its Google credentials from the Supabase dashboard. The **local** stack reads
them from your `.env` via `env()` substitution in `supabase/config.toml`
(`SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID` / `SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET`). The Google OAuth
client (in Google Cloud Console) must list **both** callback URLs as authorized redirect URIs:

- Hosted: `https://<your-project-ref>.supabase.co/auth/v1/callback`
- Local: `http://127.0.0.1:54321/auth/v1/callback`

After changing any provider values in `.env` or `config.toml`, run `npm run db:stop && npm run db:start`
for the change to take effect.

#### Troubleshooting

| Symptom                                                                      | Fix                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `db:start` errors with "Docker Desktop is unable to start" or a daemon error | The Docker engine isn't up. Open Docker Desktop and wait for "Engine running". On Windows, if `wsl --status` hangs, WSL2 itself is wedged — reboot, or repair via Docker Desktop → Settings → reset. |
| `db:start` hangs or a container is unhealthy                                 | `npm run db:stop`, then `npm run db:start` again. If still stuck, `npx supabase stop --no-backup` and restart.                                                                                       |
| Ports already in use (`54321`–`54324`)                                       | Another stack (or a stale container) is running: `npm run db:stop`, or check Docker Desktop's Containers list.                                                                                       |
| Local database in a bad state after a failed migration                       | `npm run db:reset` — rebuilds it cleanly from migrations. Local only; never touches production.                                                                                                      |
| Provider/config change didn't apply                                          | Config is read at startup only: `npm run db:stop && npm run db:start`.                                                                                                                               |

### i18n

The UI is bilingual (EN/ES) with Paraglide. The URL is authoritative: `/` serves English,
`/es` serves Spanish. On a first visit to an unprefixed URL the server negotiates
cookie > `Accept-Language` > English. The UI locale governs interface strings only — the
language of typeable text content is data and fully independent of the UI language.

## Project documentation

- [`CONTEXT.md`](CONTEXT.md) — project overview, domain glossary, and status
- [`docs/adr/`](docs/adr/) — architecture decision records
- [`CLAUDE.md`](CLAUDE.md) — agent workflow conventions (issue tracker, triage labels, domain docs)

## License

TBD.
