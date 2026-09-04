# Production runbook

Meant to be followed under actual pressure — a deploy, an incident, a "did this actually work"
moment — not just read once. Staging and production share this one runbook; substitute the
environment-specific values from `docs/ENVIRONMENT.md`.

## Verification checklist

Run this in full against staging first. Repeat identically against production before considering
it live (with `CASHFREE_ENV=test`/`NOTIFICATION_PROVIDER=disabled` still in place — production
stays closed to real payment/push traffic until the separate Cashfree/APNs production phase ships).

**Health**
- [ ] `GET /health` → `200 {"data":{"status":"ok"}}` — process liveness only.
- [ ] `GET /health/ready` → `200 {"data":{"status":"ready"}}` — confirms real Supabase
      connectivity, bounded to 3s, no internals leaked on failure (just a generic `503`).
- [ ] Watch a real deploy: Render's Health Check Path (set to `/health/ready`) gates traffic
      promotion correctly — a build that can't reach Supabase should not go live.
- [ ] `kill -TERM <pid>` locally against a running build (or trigger a real deploy) and confirm the
      "shutting down gracefully" / "all connections closed" log lines appear and the process exits
      cleanly, not by force-kill.

**Auth**
- [ ] Sign up via Supabase Auth against the environment's own project.
- [ ] An authenticated request with a real token succeeds.
- [ ] A `profiles.status='suspended'` user is rejected (`403`).
- [ ] A role-gated route correctly `403`s a caller without that role.

**Locations**
- [ ] Public search/discovery returns only `published` locations.
- [ ] Host create → submit → admin approve/reject/suspend/restore all work and audit-log.

**Media**
- [ ] Presigned upload against the environment's *own* R2 bucket succeeds.
- [ ] `completeUpload`'s `headObject` verification succeeds.
- [ ] The returned public URL resolves through this environment's own media domain — not another
      environment's.

**Availability**
- [ ] Computed availability reflects rules/overrides/blocks correctly.

**Bookings**
- [ ] Create each of the 4 booking types successfully.
- [ ] Two genuinely concurrent overlapping requests resolve to exactly one success (re-verifies the
      exclusion-constraint guarantee against this specific project, not just that the migration
      ran without error).
- [ ] Host approve/reject flow works.

**Payments — the highest-value checks in this whole list**
- [ ] Order creation reaches Cashfree.
- [ ] **Trigger a real sandbox payment and confirm the deployed `/v1/payments/webhooks/cashfree`
      actually receives and processes it.** This is the one check that catches an `API_BASE_URL`
      misconfiguration — everything else on this list can pass even with that value wrong.
- [ ] Attempting a second payment on an already-settled booking is rejected (`409`).
- [ ] A refund flow works end to end.
- [ ] Hit the payment-creation endpoint more than 10 times in 15 minutes as one caller and confirm
      the rate limiter actually returns `429` past the limit (proves `paymentCreationLimiter` is
      live in this environment, not silently skipped).

**Notifications**
- [ ] Device registration works.
- [ ] In-app notification records are created correctly regardless of push provider.
- [ ] If `NOTIFICATION_PROVIDER=apns` (sandbox), a real push delivers. If `disabled`, confirm
      attempts are honestly recorded as `skipped`, never faked as delivered.

**Admin**
- [ ] Admin login works end to end against the deployed Admin Panel URL.
- [ ] Dashboard loads.
- [ ] User/location/booking/payment/refund operations all audit-log correctly.
- [ ] The audit log remains unspoofable via direct PostgREST against this project (attempt a raw
      insert/update/delete with an admin's own bearer token — all three must fail).

**Security**
- [ ] A booker cannot rewrite their own booking's price/status via direct PostgREST (`42501`).
- [ ] A host cannot self-publish a location via direct PostgREST (`42501`).
- [ ] A request from an origin not in `CORS_ORIGINS` is actually rejected by the browser.
- [ ] No secret value appears in any API response (spot check a payment/refund response body).

## Rollback / disaster recovery

**Application rollback**: Render's "Rollback to this deploy" (backend) / Vercel's "Promote to
Production" on any prior deployment (Admin Panel). Both are one action. They're independent — a
change spanning both repos needs both rolled back deliberately, not assumed to happen together.

**Database rollback does not exist as a single action.** The Supabase CLI has no down-migrations.
Reversing a schema change means writing and pushing a *new* forward migration through the full
LOCAL → STAGING → PRODUCTION pipeline. This is why every migration must stay backward-compatible
with the previous application version — otherwise a one-click app rollback runs old code against a
schema that no longer matches it, trading one outage for a different one.

**Supabase backup/PITR** (being precise about what's actually included, not assumed): free tier —
no restorable backups at all. Paid tier — daily backups, limited retention. PITR — a separate paid
add-on, not included by default even on Pro. The `supabase db dump` taken before every production
push (see `docs/DEPLOYMENT.md`) is the honest baseline until PITR is enabled: a full-restore,
outage-length operation, not a scalpel. Enable PITR on production before public launch.

**R2 recovery**: no versioning/lifecycle policy is configured by default. A deleted/overwritten
media object is gone unless R2 object versioning is deliberately enabled (storage-cost trade-off) —
decide this explicitly before real user media exists.

**Payment webhook recovery**: Cashfree retries failed webhook deliveries on its own schedule
(provider-side, not controlled by this codebase). Combined with the existing idempotency ledger
(`payment_webhook_events`), a transient outage during a webhook delivery is self-healing once the
backend is back up, provided Cashfree's retry window outlasts the outage. There is no manual replay
mechanism in this codebase if it doesn't.

**Notification recovery**: best-effort by design (`notify()` never fails the parent booking/payment
operation) — a missed push during an outage is not retried; the in-app notification record itself
is written independently and is unaffected.

## Known, accepted limitations at this stage (not bugs — documented trade-offs)

- **Rate limiting is in-memory, per-instance.** Correct and sufficient at one Render instance per
  environment (the current deployment target). If ever scaled to multiple instances, the effective
  limit becomes `configured limit × instance count` — would need a shared store (e.g. Redis) to
  stay exact. Not solved speculatively.
- **Rate limiting assumes exactly one reverse-proxy hop** (`app.set("trust proxy", 1)` in
  `src/app.ts`, matching Render/Railway/Heroku-style platforms). Adding a CDN/WAF in front later
  (e.g. Cloudflare orange-cloud) changes the hop count and needs this revisited, or `req.ip`
  resolves to the wrong address.
- **No distributed session revocation.** Suspending a user blocks their *next* authenticated
  request; it doesn't invalidate an already-issued, not-yet-expired JWT mid-flight. Documented,
  small, known window — not addressed by this phase.
