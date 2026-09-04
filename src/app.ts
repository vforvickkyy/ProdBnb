import cors from "cors";
import express, { Express } from "express";
import helmet from "helmet";
import { env } from "./config/env";
import { anonClient } from "./lib/supabase";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";
import { generalLimiter } from "./middleware/rateLimit";
import { adminRouter } from "./modules/admin/admin.routes";
import { availabilityRouter } from "./modules/availability/availability.routes";
import { bookingsRouter } from "./modules/bookings/bookings.routes";
import { catalogRouter } from "./modules/catalog/catalog.routes";
import { devicesRouter } from "./modules/devices/device.routes";
import { locationsRouter } from "./modules/locations/locations.routes";
import { mediaRouter } from "./modules/media/media.routes";
import { notificationsRouter } from "./modules/notifications/notification.routes";
import { postCashfreeWebhook } from "./modules/payments/payment.controller";
import { paymentsRouter } from "./modules/payments/payment.routes";
import { pricingRouter } from "./modules/pricing/pricing.routes";
import { rolesRouter } from "./modules/roles/roles.routes";
import { usersRouter } from "./modules/users/users.routes";

/** Never resolves later than `ms` — bounds the readiness check below so a
 * hung Supabase call can't hang /health/ready (and therefore a platform's
 * deploy-gating health check) indefinitely. */
function withTimeout<T>(promise: PromiseLike<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

export function createApp(): Express {
  const app = express();

  // Affects req.protocol/req.secure (correctly read X-Forwarded-Proto from
  // Vercel's edge rather than assuming plain HTTP) and is a safe default for
  // req.ip generally. The rate limiter does NOT rely on this for its actual
  // security-relevant IP determination, though -- see clientIp() in
  // src/middleware/rateLimit.ts, which reads Vercel's own
  // x-vercel-forwarded-for header directly instead of hop-counting (Vercel's
  // edge network doesn't map cleanly onto Express's "N proxies in front of
  // me" trust-proxy model the way a single self-managed reverse proxy does).
  app.set("trust proxy", 1);

  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGINS.length > 0 ? env.CORS_ORIGINS : false }));

  // Registered BEFORE the global express.json() below, and deliberately not
  // part of paymentsRouter -- Cashfree's webhook signature covers the exact
  // raw request bytes (see CashfreeProvider#verifyAndParseWebhook), which
  // express.json() would otherwise parse-and-discard before this handler
  // ever saw them. Every other route is unaffected: express.raw() only
  // consumes application/json bodies posted to this one path.
  //
  // Also deliberately registered BEFORE generalLimiter below: this path is
  // called by Cashfree's own servers, not end users, and a silently
  // rate-limited payment webhook is a worse failure mode than an
  // unrate-limited one -- payment reconciliation depends on it arriving.
  app.post("/v1/payments/webhooks/cashfree", express.raw({ type: "application/json" }), postCashfreeWebhook);

  app.use(generalLimiter);
  app.use(express.json());

  // Liveness -- unconditional, unchanged: "is the process up at all."
  app.get("/health", (_req, res) => {
    res.status(200).json({ data: { status: "ok" } });
  });

  // Readiness -- "is this instance actually able to serve traffic." Checked
  // separately from /health (Phase 13) so external uptime monitoring / a
  // manual post-deploy check can distinguish "process is up" from "the
  // database is actually reachable." Unlike a persistent-process host,
  // Vercel promotes a deployment on successful BUILD, not a runtime health
  // probe -- there is no platform-level mechanism this endpoint gates the
  // way it would on e.g. Render, so treat it as a verification tool
  // (docs/PRODUCTION_RUNBOOK.md), not an automatic deploy gate. Bounded to
  // 3s so a hung Supabase call can't hang this endpoint indefinitely;
  // queries the smallest public, already-RLS-open lookup table (no auth, no
  // row content, no internals in the response).
  app.get("/health/ready", async (_req, res) => {
    try {
      const { error } = await withTimeout(anonClient.from("categories").select("id").limit(1), 3000);
      if (error) {
        throw error;
      }
      res.status(200).json({ data: { status: "ready" } });
    } catch (err) {
      console.error("Readiness check failed:", err);
      res.status(503).json({ error: { code: "SERVICE_UNAVAILABLE", message: "Not ready to accept traffic." } });
    }
  });

  app.use("/v1", usersRouter);
  app.use("/v1", rolesRouter);
  app.use("/v1", locationsRouter);
  app.use("/v1", mediaRouter);
  app.use("/v1", availabilityRouter);
  app.use("/v1", bookingsRouter);
  app.use("/v1", pricingRouter);
  app.use("/v1", paymentsRouter);
  app.use("/v1", devicesRouter);
  app.use("/v1", notificationsRouter);
  // Mounted at /v1/admin specifically, not /v1 -- adminRouter's blanket
  // requireAuth+requireRole('admin') gate (no path restriction, applied
  // once for the whole router) would otherwise intercept every request for
  // every router registered after it, including public ones like
  // catalogRouter, since Express only skips a sub-router entirely when the
  // request path doesn't match its mount prefix.
  app.use("/v1/admin", adminRouter);
  app.use("/v1", catalogRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

// The single, authoritative Express app instance for this process. Vercel's
// native Express framework detection (Project Settings -> Framework Preset:
// Express) requires this file's default export to be the app itself, not a
// factory -- see docs/DEPLOYMENT.md. src/index.ts imports this same instance
// rather than calling createApp() again, so there is exactly one app
// constructed per process, on Vercel or anywhere else.
const app = createApp();
export default app;
