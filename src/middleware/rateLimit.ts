import { Request } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { env } from "../config/env";

/**
 * Phase 13 deployment hardening. Deliberately simple: in-memory,
 * single-process rate limiting, not a distributed store — matches this
 * project's current deployment target (one Render Web Service per
 * environment). Documented assumptions/limitations, not silently glossed
 * over:
 *
 * - Requires `app.set("trust proxy", 1)` in app.ts. Render (and most PaaS
 *   platforms — Railway, Heroku-style setups) put exactly one reverse proxy
 *   in front of this process; trusting one hop is what lets Express — and
 *   therefore express-rate-limit's default IP-based key — read the real
 *   client IP from X-Forwarded-For instead of the proxy's own address.
 *   Trusting more hops than actually exist lets a client spoof its IP via
 *   that header; trusting fewer collapses every caller onto one IP. If a
 *   CDN/WAF (e.g. Cloudflare) is ever added in front of Render, this number
 *   needs revisiting — it is not future-proofed automatically.
 * - In-memory store means each server instance keeps its own counters. At
 *   one instance per environment (the current plan) the limit is exact. If
 *   ever scaled horizontally, the effective limit becomes
 *   (configured limit) x (instance count) — acceptable for now, not solved
 *   speculatively; a shared store (e.g. `rate-limit-redis`) would be the
 *   fix at that point, not before.
 * - Disabled entirely when NODE_ENV=test (set automatically by Vitest) —
 *   the test suite legitimately calls these routes far more times, in a far
 *   shorter window, than any real caller would.
 */

function skipInTest(): boolean {
  return env.NODE_ENV === "test";
}

/** Baseline anti-abuse net across the whole API. */
export const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
});

/**
 * Tighter limit specifically on payment creation — the one route that calls
 * out to a real payment provider and has direct cost/abuse consequences.
 * Keyed by the authenticated caller (requireAuth already ran, so req.user
 * is set) rather than raw IP: IP-based keys both under-count (many users
 * behind one corporate/mobile-carrier IP share a limit) and over-count (one
 * user cycling IPs evades it) for an authenticated route.
 */
export const paymentCreationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  // ipKeyGenerator normalizes IPv6 addresses to a fixed-size subnet before
  // using them as a fallback key -- using the raw address directly would let
  // a caller cycle through addresses within their own /64 to evade the
  // limit, since each one looks like a distinct key otherwise.
  keyGenerator: (req: Request) => req.user?.id ?? ipKeyGenerator(req.ip ?? "unknown"),
});
