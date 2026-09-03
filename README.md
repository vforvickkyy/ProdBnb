# ProdBnb Backend

The master backend for ProdBnb — a marketplace for discovering and booking film, advertising,
photography and production locations. One backend serves three clients: **iOS**, **Android**,
and **Web**.

Phase 1 (core foundation, authentication, user profiles, roles), Phase 2 (locations/listings —
the marketplace inventory a host lists), Phase 3 (Cloudflare R2 media — direct-to-storage
photo/video upload), Phase 4 (search & discovery — PostgreSQL/PostGIS-backed text search,
geographic search, and filtering), Phase 5 (availability & calendar — weekly schedules, date
overrides, blocked periods, and timezone-aware computed availability), Phase 6 (booking engine +
pricing foundation — atomic double-booking prevention, price snapshots, booking lifecycle), and
Phase 6A (booking model & pricing expansion — four booking types, `hourly`/`half_day`/`day`/
`multi_day`, each resolving to the same atomically-protected interval, normalized per-type
`location_pricing`), Phase 7 (payment architecture — a provider-agnostic `PaymentProvider`
interface with Cashfree, TEST/sandbox only, as the first implementation), and Phase 8
(notification infrastructure — in-app notifications, multi-device push registration, preferences,
and a provider-agnostic `NotificationProvider` interface with APNs as the first implementation),
Phase 11 (admin control — a `/v1/admin/*` API namespace for user/host/location moderation,
booking/payment/refund oversight, and an immutable audit log, backing a separate Admin Panel
frontend project), and Phase 12 (security + performance hardening audit — closed a
column/grant-level RLS gap shared by `bookings`/`locations`/`location_media`, two payment/refund
TOCTOU races, and an admin audit-log completeness gap on two pre-Phase-11 routes; added four
indexes for existing admin/host listing query patterns; see
[`docs/DATABASE.md`](docs/DATABASE.md#rlsgrant-hardening-phase-12)) are done. Phases 9 (Favorites +
Reviews) and 10 (Messaging/Chat) are intentionally skipped for now. See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md),
[`docs/DATABASE.md`](docs/DATABASE.md), and [`docs/API.md`](docs/API.md) for the full picture.
**The notification system is fully developed and tested without any Apple Developer account or
APNs credentials** — it defaults to an explicit `disabled` provider that records every push
attempt honestly rather than pretending success (see
[`docs/DATABASE.md`](docs/DATABASE.md#developing-and-testing-without-an-apple-developer-account)).
Host payouts/commission splitting are the next payment-related extension point — see
[`docs/DATABASE.md`](docs/DATABASE.md#payment-architecture--cashfree-integration-phase-7).

## Admin Panel

The Admin Panel is a **separate frontend project/repository** — it is never built inside this
backend repo, and this backend never ships its `SUPABASE_SERVICE_ROLE_KEY`/`CASHFREE_SECRET_KEY`/
`APNS_PRIVATE_KEY`/R2 secrets to it. It signs in via the same Supabase Auth project as every other
client and calls this backend's `/v1/admin/*` REST API with the resulting access token — see
[`docs/DATABASE.md`](docs/DATABASE.md#admin-control--admin-panel-phase-11). Located at
`../ProdBnb Admin` (a sibling of this repo), consuming the generated OpenAPI contract at
`docs/admin-openapi.json` (`npm run generate:openapi` in this repo regenerates it).

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
- A **Cloudflare R2** bucket + API token — only needed for a real end-to-end media upload; the
  test suite mocks R2 entirely (see [`docs/DATABASE.md`](docs/DATABASE.md#media-storage-phase-3-cloudflare-r2)).
- A **Cashfree TEST/sandbox** App ID + Secret Key — only needed for a real end-to-end payment
  smoke test; the test suite mocks the Cashfree adapter's network calls entirely (webhook
  signature verification is still tested for real — it's pure local HMAC, no network involved).
  Production Cashfree credentials are never used in this phase.
- An **Apple Developer Program** membership + APNs Authentication Key — **not needed at all** to
  build, run, or test this backend. `NOTIFICATION_PROVIDER` defaults to `disabled`; only needed
  later for a real push notification to actually land on a physical iOS device.

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
  lib/              Supabase client factories (user-scoped, anon, admin) + the R2 client
  middleware/       auth, role guard, validation, error handling
  errors/           Typed application errors
  modules/          One folder per feature (routes → controller → service → schema)
  utils/            Small shared helpers (response envelope)
tests/              vitest + supertest, against a real local Supabase stack (R2 is mocked)
docs/               Architecture, database, and API documentation
```

Each `src/modules/<name>` is self-contained (`users`, `roles`, `locations`, `catalog`, `media`,
`search`, `availability`, `bookings`, `pricing`, `payments`, `devices`, `notifications`, `admin`).
Future features are added the same way, as new module folders, without touching existing ones.
`payments/providers/` holds the provider-agnostic `PaymentProvider` interface plus one adapter per
payment provider (`CashfreeProvider` today) — see
[`docs/DATABASE.md`](docs/DATABASE.md#payment-architecture--cashfree-integration-phase-7).
`notifications/providers/` holds the identically-shaped `NotificationProvider` interface plus one
adapter per push provider (`APNsProvider` and the default `DisabledProvider` today) — see
[`docs/DATABASE.md`](docs/DATABASE.md#notification-infrastructure--apns-push-phase-8).

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Start the API with hot reload |
| `npm run build` | Type-check and compile to `dist/` |
| `npm start` | Run the compiled server (`dist/`) |
| `npm run typecheck` | Type-check without emitting |
| `npm test` | Run the test suite once |
| `npm run test:watch` | Run the test suite in watch mode |
| `npm run generate:openapi` | Regenerate `docs/admin-openapi.json` from the `/v1/admin/*` zod schemas |

## Environment variables

See [`.env.example`](.env.example) for the full list and which values are safe to also ship
inside client apps vs. server-only secrets. Never commit `.env`.

## Database migrations

See [`docs/DATABASE.md`](docs/DATABASE.md) for the full migration workflow (create, apply
locally, reset, and push to the linked "ProdBnb" Supabase project).
