# ProdBnb Backend

The master backend for ProdBnb — a marketplace for discovering and booking film, advertising,
photography and production locations. One backend serves three clients: **iOS**, **Android**,
and **Web**.

This is **Phase 1**: core foundation, authentication, user profiles, and roles. See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/DATABASE.md`](docs/DATABASE.md), and
[`docs/API.md`](docs/API.md) for the full picture.

## Stack

- **Runtime**: Node.js + TypeScript + Express
- **Database & Auth**: [Supabase](https://supabase.com) (Postgres + Supabase Auth + Row Level
  Security)
- **Validation**: [zod](https://zod.dev)
- **Tests**: [vitest](https://vitest.dev) + [supertest](https://github.com/ladjs/supertest),
  run against a real local Supabase stack (not mocks) so Row Level Security is actually exercised.

## Prerequisites

- Node.js 20+ and npm
- [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started)
  (`supabase --version`), already authenticated (`supabase login`)
- **Docker Desktop** (or Colima/Podman) — required by `supabase start` to run the local
  Postgres/Auth/Studio stack. Without it, migrations and the test suite can't run locally.

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env

# 3. Start the local Supabase stack (requires Docker running)
supabase start
# Copy the printed API URL / anon key / service_role key into .env

# 4. Apply database migrations to the local stack
supabase migration up

# 5. Run the dev server
npm run dev
# -> curl http://localhost:4000/health

# 6. Run tests
npm test
```

## Project structure

```
supabase/          Supabase config + versioned SQL migrations
src/
  config/          Environment loading & validation
  lib/              Supabase client factories (user-scoped, anon, admin)
  middleware/       auth, role guard, validation, error handling
  errors/           Typed application errors
  modules/          One folder per feature (routes → controller → service → schema)
  utils/            Small shared helpers (response envelope)
tests/              vitest + supertest, against a real local Supabase stack
docs/               Architecture, database, and API documentation
```

Each `src/modules/<name>` is self-contained. Future features (locations, bookings, …) are added
the same way, as new module folders, without touching existing ones.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Start the API with hot reload |
| `npm run build` | Type-check and compile to `dist/` |
| `npm start` | Run the compiled server (`dist/`) |
| `npm run typecheck` | Type-check without emitting |
| `npm test` | Run the test suite once |
| `npm run test:watch` | Run the test suite in watch mode |

## Environment variables

See [`.env.example`](.env.example) for the full list and which values are safe to also ship
inside client apps vs. server-only secrets. Never commit `.env`.

## Database migrations

See [`docs/DATABASE.md`](docs/DATABASE.md) for the full migration workflow (create, apply
locally, reset, and push to the linked "ProdBnb" Supabase project).
