# Environment variables

The source of truth for what each environment needs — referenced instead of re-deriving it from
`.env.example` each time a new environment is set up. `src/config/env.ts` validates all of this at
process startup via zod and **fails fast**: if anything required is missing or invalid, the process
throws and exits immediately rather than starting in a partially-configured state. On Render this
surfaces as a deploy that never passes its health check.

## Backend

| Variable | Classification | dev (existing, unchanged) | staging | production |
|---|---|---|---|---|
| `PORT` | server-only | Render-provided | Render-provided | Render-provided |
| `NODE_ENV` | server-only | `development` | `production` | `production` |
| `CORS_ORIGINS` | server-only | local dev value | `https://staging-admin.prodbnb.com` | `https://admin.prodbnb.com` |
| `API_BASE_URL` | server-only, **highest-risk value** | unchanged | `https://staging-api.prodbnb.com` | `https://api.prodbnb.com` |
| `SUPABASE_URL` | public-safe | existing project | new staging project | new prod project |
| `SUPABASE_ANON_KEY` | public-safe | existing | new | new |
| `SUPABASE_SERVICE_ROLE_KEY` | **secret** | existing | new | new |
| `R2_ACCOUNT_ID` | not secret | existing | new | new |
| `R2_BUCKET_NAME` | server-only | existing dev bucket | `prodbnb-media-staging` | `prodbnb-media-prod` |
| `R2_ACCESS_KEY_ID` | **secret** | existing | new, bucket-scoped | new, bucket-scoped |
| `R2_SECRET_ACCESS_KEY` | **secret** | existing | new, bucket-scoped | new, bucket-scoped |
| `R2_PUBLIC_BASE_URL` | public-safe | existing | `https://staging-media.prodbnb.com` | `https://media.prodbnb.com` |
| `R2_UPLOAD_URL_EXPIRY_SECONDS` | server-only | unchanged default | unchanged default | unchanged default |
| `MEDIA_MAX_PHOTO_SIZE_MB` / `MEDIA_MAX_VIDEO_SIZE_MB` | server-only | unchanged defaults | unchanged defaults | unchanged defaults |
| `PAYMENT_PROVIDER` | server-only | `cashfree` | `cashfree` | `cashfree` |
| `CASHFREE_ENV` | server-only | `test` | `test` | `test` — **cannot be otherwise; no production code path exists yet** |
| `CASHFREE_APP_ID` | secret-ish | existing test creds | sandbox creds | sandbox creds (until the production follow-up lands) |
| `CASHFREE_SECRET_KEY` | **secret** | existing | sandbox | sandbox (until the production follow-up lands) |
| `CASHFREE_API_VERSION` | server-only | unchanged default | unchanged default | unchanged default |
| `NOTIFICATION_PROVIDER` | server-only | `disabled` or `apns` | `disabled` or `apns` (sandbox) | `disabled` — **until the production follow-up lands** |
| `APNS_ENVIRONMENT` / `APNS_TEAM_ID` / `APNS_KEY_ID` / `APNS_BUNDLE_ID` / `APNS_PRIVATE_KEY` | **secret** | only if provider=apns | only if provider=apns (sandbox) | not usable yet |

**`API_BASE_URL` deserves its own callout.** It defaults to `http://localhost:4000` and is used to
build the webhook `notify_url` handed to Cashfree server-side. Left at the default in a deployed
environment, the app boots fine and payment creation *appears* to work — but Cashfree can never
reach the webhook, so payments silently never reconcile. There is no error, no log line, no failed
health check — just payments that stay `pending` forever. Set it explicitly for every deployed
environment and verify with a real webhook round-trip, not just "the deploy succeeded."

## Admin Panel

All three variables are `NEXT_PUBLIC_*` — public-safe by design (the same reasoning as shipping a
Supabase anon key to any client), but **baked into the browser bundle at build time**, not read at
runtime. Changing one requires a new build on the hosting platform, not just a redeploy of an
existing build.

| Variable | dev | staging | production |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | existing project | new staging project | new prod project |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | existing | new | new |
| `NEXT_PUBLIC_API_BASE_URL` | `http://localhost:4000` | `https://staging-api.prodbnb.com` | `https://api.prodbnb.com` |

## What must never reach the Admin Panel, any client, or Git

`SUPABASE_SERVICE_ROLE_KEY`, `CASHFREE_SECRET_KEY`, `APNS_PRIVATE_KEY`, `R2_ACCESS_KEY_ID`/
`R2_SECRET_ACCESS_KEY`, any webhook secret, any Postgres connection string. Store these in each
platform's own environment-variable UI (Render/Vercel) or a password manager — never in a repo,
never in shell history files, never pasted into chat.
