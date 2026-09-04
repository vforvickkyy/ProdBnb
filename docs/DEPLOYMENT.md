# Deployment

How ProdBnb Backend and the separate Admin Panel go from local development to staging and
production. This is the executable version of the Phase 13 planning report — see git history for
the original report if you want the full reasoning behind each decision; this document is meant to
be followed, not re-derived.

**Local development is unaffected by any of this** — `npm run dev` against the existing Supabase
project (`nkekflglcealvquqqjwb`) continues to work exactly as it always has. This document only
concerns the two new hosted environments, staging and production.

## Architecture

| Concern | Choice |
|---|---|
| Backend hosting | [Render](https://render.com) — native Node Web Service |
| Admin Panel hosting | [Vercel](https://vercel.com) — Next.js Project |
| Database/Auth | Separate Supabase projects per environment (staging, production) — existing project stays dev, untouched |
| Storage | Separate Cloudflare R2 buckets per environment — existing bucket stays dev |
| Region | Singapore (`ap-southeast-1`) for both Render and the new Supabase projects — this backend has no DB connection pool, every Supabase call is a fresh HTTPS round-trip, so co-location matters more than usual |

Domains (the three API hostnames are fixed by the iOS app's own `AppConfiguration.swift`, not a
free choice here):

| Environment | API | Admin Panel | Media |
|---|---|---|---|
| staging | `staging-api.prodbnb.com` | `staging-admin.prodbnb.com` | `staging-media.prodbnb.com` |
| production | `api.prodbnb.com` | `admin.prodbnb.com` | `media.prodbnb.com` |

All DNS records are CNAMEs (no A records, no apex complications).

## What's out of scope here

**Cashfree and APNs production support does not exist in code.** `CASHFREE_ENV` and
`APNS_ENVIRONMENT` are both single-value zod enums (`"test"` / `"sandbox"` only) with no
production host wired up anywhere — no environment variable can turn either on; it requires a
small, separate, explicitly-approved code change. Production infrastructure can be fully deployed
and verified with `CASHFREE_ENV=test`/`NOTIFICATION_PROVIDER=disabled` still in place — it just
cannot be opened to real paying users or push notifications until that follow-up lands. Don't set
either to anything else; the app will refuse to boot (by design).

## One-time setup per environment

### 1. Supabase

1. Create a new project (staging or production), Singapore region, confirm Postgres major version
   matches `supabase/config.toml`'s pinned `major_version` (`SHOW server_version;`).
2. Get the **session-mode pooler** connection string (port 5432, not the transaction-mode pooler
   on 6543 — that breaks DDL) from Dashboard → Connect. Store it in a password manager, not in this
   repo.
3. Push migrations, targeting this project explicitly (**never re-link the CLI** — it stays
   pointed at the dev project permanently, see "Migration safety model" below):
   ```bash
   supabase migration list --db-url "<connection-string>"   # confirm all 11 show pending
   supabase db push --db-url "<connection-string>"
   ```
4. Verify (don't assume): `postgis`/`btree_gist` present in `pg_extension`; the 3 GiST exclusion
   constraints present; both partial unique indexes present; all 5 `SECURITY DEFINER` functions
   present with a pinned `search_path`; RLS enabled on every `public` table; all 15 triggers
   present. Run Supabase's Security Advisor.
5. **Before calling staging "verified," seed it with realistic, overlapping data** — an exclusion
   constraint always succeeds against an empty table (vacuously) and can fail against a populated
   one. An empty staging pass doesn't prove production will apply cleanly.
6. Production only: confirm the project is on a paid tier (free-tier projects pause after ~1 week
   of inactivity — unacceptable for production) and enable the PITR add-on before public launch.

### 2. Cloudflare R2

1. Create a new bucket (`prodbnb-media-staging` / `prodbnb-media-prod`).
2. Create a new API token scoped to **only that bucket** — never a token that can reach more than
   one environment's bucket.
3. Connect a custom domain (`staging-media.prodbnb.com` / `media.prodbnb.com`) via R2's "Connect
   Domain" flow.
4. Set a CORS policy on the bucket (Cloudflare dashboard → R2 → bucket → Settings). This only
   matters for **browser** clients (native iOS/Android uploads send no `Origin` header and aren't
   affected by bucket CORS at all):
   - `AllowedOrigins`: the matching Admin Panel origin only (e.g. `https://staging-admin.prodbnb.com`) — never `*`, the presigned URL is the only thing standing between a caller and a write.
   - `AllowedMethods`: `PUT`, `GET`, `HEAD`
   - `AllowedHeaders`: `content-type` (check the actual presigned URL's `X-Amz-SignedHeaders` if uploads fail preflight)
   - `ExposeHeaders`: `ETag`

### 3. Backend on Render

1. New Web Service, connected to this GitHub repo, watching the environment's branch (`staging` /
   `production`).
2. Build Command: `npm ci --include=dev && npm run build` — **not just `npm ci`**. Render sets
   `NODE_ENV=production` by default, which makes `npm ci` skip `devDependencies`, and `typescript`
   (needed for `npm run build`) is a devDependency. Omitting `--include=dev` here breaks the first
   deploy.
3. Start Command: `npm start`
4. Health Check Path: `/health/ready` — this checks real Supabase connectivity (bounded to 3s), not
   just process liveness, so Render's deploy-gating actually validates the thing that matters
   before promoting traffic to a new deploy. (`/health` alone would go green even if the database
   were unreachable.)
5. Set `NODE_VERSION` to a pinned LTS (e.g. `20.18.0`) — there's no `engines` field in
   `package.json` to pin it otherwise.
6. Set every environment variable per the matrix in `docs/ENVIRONMENT.md`. **`API_BASE_URL` is the
   single highest-risk value here** — it defaults to `http://localhost:4000`, and it's what gets
   handed to Cashfree as the webhook `notify_url`. Left unset, the app boots fine and payments
   *appear* to work, but Cashfree can never reach the webhook, so payments silently never
   reconcile. Set it to `https://staging-api.prodbnb.com` / `https://api.prodbnb.com` explicitly
   and verify it with a real webhook round-trip (see the verification checklist below) — don't
   trust that it's set correctly just because the deploy succeeded.

### 4. Admin Panel on Vercel

1. New Project, connected to the `ProdBnb-Admin` GitHub repo, watching the environment's branch.
2. Framework preset: Next.js (auto-detected).
3. Set the three `NEXT_PUBLIC_*` env vars per `docs/ENVIRONMENT.md`. **These are baked into the
   browser bundle at build time** — changing one requires a new build, not just flipping a runtime
   setting.
4. After the Admin Panel's domain is known, add it to the matching backend environment's
   `CORS_ORIGINS` on Render and redeploy — every browser-side API call from the Admin Panel fails
   cross-origin otherwise.

### 5. DNS (Cloudflare)

All CNAMEs. Keep the three API hostnames **DNS-only (grey cloud)**, not proxied — Cashfree's
webhook is a server-to-server POST that a WAF/Bot Fight rule could silently challenge or block if
proxied, and a silently blocked payment webhook is the worst failure mode this system has. Add
proxying deliberately later, with an explicit webhook-path bypass rule, not by accident on day one.
The Vercel records should also stay DNS-only (a proxied Vercel setup is fragile unless carefully
configured). R2 custom-domain records are proxied by design — that's how R2 custom domains work.

## Migration safety model

`supabase db push` stays the mechanism — no new tool. **The CLI's `supabase link` stays pointed at
the existing dev project, permanently.** Staging and production are targeted *explicitly per
command* via `--db-url <connection-string>`, never by re-linking — this means a bare, forgetful
`supabase db push` can only ever hit dev, and the actual destination of any push is visible in the
command itself.

Sequencing: **LOCAL** (`supabase db reset` must succeed clean) → **STAGING** (push, verify, seed
realistic data, full smoke test including the live webhook round-trip) → only then **PRODUCTION**
(the identical push, using the exact same migration files — no edits made in between). If a fix is
needed after staging, it's a new commit and the staging cycle repeats in full.

**No down-migrations exist.** Reversing a schema change means writing a new forward migration that
undoes it, through the same pipeline. This is why every migration must stay backward-compatible
with the previous application version (expand/contract: add nullable/defaulted columns, never
rename in place, never drop a column the same release that stops using it) — otherwise a one-click
app rollback becomes a trap, running old code against a schema that no longer matches it.

Before every production push: `supabase db dump --db-url "<production>" -f pre_<version>.sql` —
a full-restore artifact stored off-platform, not a surgical undo. Insurance against catastrophe,
not a rollback button.

## Deployment sequence

1. Create the two new Supabase projects, push + verify + seed staging.
2. Create the two new R2 buckets + scoped tokens + custom domains + CORS (staging first).
3. Create the staging Render service + staging Vercel project, wire env vars, deploy.
4. DNS for staging (three hostnames).
5. Run the full verification checklist (`docs/PRODUCTION_RUNBOOK.md`) against staging, including a
   real Cashfree sandbox payment + webhook round-trip against the *deployed* URL.
6. Only after staging is fully green: push migrations to production, create the production R2
   bucket/Render service/Vercel project, DNS.
7. Run the verification checklist against production — infrastructure live and correct, but
   **closed to real payment/push traffic** (`CASHFREE_ENV=test`/`NOTIFICATION_PROVIDER=disabled`
   still in place) until the separate Cashfree/APNs production phase is approved and shipped.

See `docs/PRODUCTION_RUNBOOK.md` for the full verification checklist and rollback procedures.
