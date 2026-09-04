# Deployment

How ProdBnb Backend and the separate Admin Panel go from local development to staging and
production. This is the executable version of the Phase 13 planning report — see git history for
the original reasoning if you want the full "why," including the earlier (superseded) Render-based
plan from before the platform decision changed to Vercel for both projects.

**Local development is unaffected by any of this** — `npm run dev` against the existing Supabase
project (`nkekflglcealvquqqjwb`) continues to work exactly as it always has. This document only
concerns the two new hosted environments, staging and production.

## Architecture

| Concern | Choice |
|---|---|
| Backend hosting | [Vercel](https://vercel.com) — the whole Express app deployed as a single Vercel Function |
| Admin Panel hosting | [Vercel](https://vercel.com) — Next.js Project (unchanged choice, always was Vercel) |
| Database/Auth | Separate Supabase projects per environment (staging, production) — existing project stays dev, untouched |
| Storage | Separate Cloudflare R2 buckets per environment — existing bucket stays dev |
| Region | Singapore (`ap-southeast-1` for Supabase; `sin1` for Vercel Functions, `vercel.json`'s `regions` field) — this backend has no DB connection pool, every Supabase call is a fresh HTTPS round-trip, so co-location matters more than usual |

Domains (the three API hostnames are fixed by the iOS app's own `AppConfiguration.swift`, not a
free choice here):

| Environment | API | Admin Panel | Media |
|---|---|---|---|
| staging | `staging-api.prodbnb.com` | `staging-admin.prodbnb.com` | `staging-media.prodbnb.com` |
| production | `api.prodbnb.com` | `admin.prodbnb.com` | `media.prodbnb.com` |

All DNS records are CNAMEs (no A records, no apex complications).

## Vercel + Express: how this repo is actually structured for it

Vercel's "zero-config" Express auto-detection (scanning for `app.ts`/`index.ts`/`server.ts` at a
few fixed paths) does **not** cleanly fit this repo: it found both `src/app.ts` (exports a
`createApp()` factory, not an app instance) and `src/index.ts` (calls `app.listen()`, but doesn't
import `express` directly) as candidates and picked the wrong one (`src/app.ts`) — confirmed
empirically with `vercel dev --local` before relying on it, not assumed. Rather than restructure
the existing module layout to fit that heuristic, this repo uses Vercel's other, fully explicit,
unambiguous convention instead:

- **`api/index.ts`** — the only Vercel-specific file in this repo. Imports `createApp()` from
  `../src/app` and does `export default app`. Vercel wraps this as a single Vercel Function using
  Fluid compute and forwards the raw Node `(req, res)` through to it — every existing Express
  behavior (routing, middleware order, the raw-body Cashfree webhook handling) is unaffected.
  Verified locally with `vercel dev --local`: the function loads and correctly runs the real
  Express app (confirmed via its own 404 JSON envelope on an unmatched route).
- **`vercel.json`** — a single catch-all rewrite (`"/(.*)" → "/api"`) so every path (`/health`,
  `/v1/*`, not just `/api/*`) reaches this one function, plus `"regions": ["sin1"]` to co-locate
  with the Singapore Supabase projects (Hobby plan supports one custom region; Pro supports up to
  5). **This exact rewrite could not be locally verified** — `vercel dev --local` (deliberately
  used to avoid linking/creating a Vercel project before you'd approved it) does not fully emulate
  `vercel.json` rewrites/routing the same way a real deployment does; direct requests to `/api`
  itself were confirmed working, isolating the untested part specifically to the rewrite mechanism.
  **This must be the first thing verified once staging is actually deployed** — hit `/health`
  and confirm it resolves, before anything else.
- **`api/tsconfig.json`** — extends the root `tsconfig.json` with `noEmit: true` and an `include`
  covering both `api/` and `src/`, purely so `npm run typecheck` catches errors in `api/index.ts`
  too. Deliberately **not** added to the root `tsconfig.json`'s own `include` — that would shift
  `npm run build`'s computed output structure and break `dist/index.js`/`npm start`, which must
  keep working unchanged for local dev and any non-Vercel Node host.
- `src/index.ts` (the `app.listen()` + graceful-SIGTERM entrypoint) is **unaffected and still used
  for local dev** (`npm run dev`) — Vercel never imports or executes this file.

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
   on 6543 — that breaks DDL) from Dashboard → Connect. This contains the database password —
   **run the migration push yourself from your own terminal** (see step 3) rather than pasting the
   connection string into chat; there is no need for it to leave your own machine.
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

1. The bucket itself may already exist (e.g. `prodbnb-media-staging`) — don't create a duplicate.
2. Create an API token scoped to **only that bucket** — never a token that can reach more than one
   environment's bucket.
3. Connect a custom domain (`staging-media.prodbnb.com` / `media.prodbnb.com`) via R2's "Connect
   Domain" flow.
4. Set a CORS policy on the bucket (Cloudflare dashboard → R2 → bucket → Settings). This only
   matters for **browser** clients (native iOS/Android uploads send no `Origin` header and aren't
   affected by bucket CORS at all — the backend never proxies media bytes either way, uploads go
   directly browser/app → R2 via presigned URLs):
   - `AllowedOrigins`: the matching Admin Panel origin only (e.g. `https://staging-admin.prodbnb.com`) — never `*`, the presigned URL is the only thing standing between a caller and a write.
   - `AllowedMethods`: `PUT`, `GET`, `HEAD`
   - `AllowedHeaders`: `content-type` (check the actual presigned URL's `X-Amz-SignedHeaders` if uploads fail preflight)
   - `ExposeHeaders`: `ETag`
   - `MaxAgeSeconds`: `3600`
5. Confirm public read access is enabled the same way the existing dev bucket already is (R2 is a
   deliberately public bucket by this project's design, per Phase 3 — not a new decision here).

### 3. Backend on Vercel

1. New Vercel Project, connected to this GitHub repo, watching the environment's branch
   (`staging` / `production`).
2. No build command override needed — `vercel.json` + `api/index.ts` are zero-config from here;
   Vercel detects and bundles the Express app itself rather than running this repo's own
   `npm run build` script for the deployed Function.
3. Set every environment variable per the matrix in `docs/ENVIRONMENT.md`. **`API_BASE_URL` is the
   single highest-risk value here** — it defaults to `http://localhost:4000`, and it's what gets
   handed to Cashfree as the webhook `notify_url`. Left unset, the app boots fine and payment
   creation *appears* to work — but Cashfree can never reach the webhook, so payments silently
   never reconcile. Set it to `https://staging-api.prodbnb.com` / `https://api.prodbnb.com`
   explicitly and verify it with a real webhook round-trip (see the runbook) — don't trust that
   it's set correctly just because the deploy succeeded.
4. **First live check, before anything else**: `GET /health` on the deployed URL. This is the one
   thing that could not be verified locally (see "Vercel + Express" above) — confirm the
   `vercel.json` rewrite is actually routing top-level paths to the function before assuming
   anything else works.

### 4. Admin Panel on Vercel

1. New Vercel Project, connected to the `ProdBnb-Admin` GitHub repo, watching the environment's
   branch.
2. Framework preset: Next.js (auto-detected).
3. Set the three `NEXT_PUBLIC_*` env vars per `docs/ENVIRONMENT.md`. **These are baked into the
   browser bundle at build time** — changing one requires a new build, not just flipping a runtime
   setting.
4. After the Admin Panel's domain is known, add it to the matching backend environment's
   `CORS_ORIGINS` on Vercel and redeploy — every browser-side API call from the Admin Panel fails
   cross-origin otherwise.

### 5. DNS (Cloudflare)

All CNAMEs. Keep the three API hostnames **DNS-only (grey cloud)**, not proxied — Cashfree's
webhook is a server-to-server POST that a WAF/Bot Fight rule could silently challenge or block if
proxied, and a silently blocked payment webhook is the worst failure mode this system has. Add
proxying deliberately later, with an explicit webhook-path bypass rule, not by accident on day one.
The Vercel records (both backend and Admin Panel) should also stay DNS-only — a proxied setup in
front of Vercel is fragile unless carefully configured (SSL mode, double-CDN behavior). R2
custom-domain records are proxied by design — that's inherent to how R2 custom domains work.

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
rename in place, never drop a column the same release that stops using it) — otherwise a rollback
of the deployed application becomes a trap, running old code against a schema that no longer
matches it.

Before every production push: `supabase db dump --db-url "<production>" -f pre_<version>.sql` —
a full-restore artifact stored off-platform, not a surgical undo. Insurance against catastrophe,
not a rollback button.

## Deployment sequence

1. Create the Vercel Projects for staging (backend + Admin Panel).
2. Push migrations to the (already-created) staging Supabase project, verify, seed realistic data.
3. Finish staging R2 setup (token, CORS, custom domain) on the (already-created) staging bucket.
4. Wire staging env vars on both Vercel Projects, deploy.
5. DNS for staging (three hostnames).
6. **First check**: `GET /health` on the deployed backend URL — confirms the rewrite routing
   works before anything else is trusted.
7. Run the full verification checklist (`docs/PRODUCTION_RUNBOOK.md`) against staging, including a
   real Cashfree sandbox payment + webhook round-trip against the *deployed* URL.
8. Only after staging is fully green: create production Supabase/R2/Vercel Projects, push
   migrations, DNS.
9. Run the verification checklist against production — infrastructure live and correct, but
   **closed to real payment/push traffic** (`CASHFREE_ENV=test`/`NOTIFICATION_PROVIDER=disabled`
   still in place) until the separate Cashfree/APNs production phase is approved and shipped.

See `docs/PRODUCTION_RUNBOOK.md` for the full verification checklist and rollback procedures.
