import { Request } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { env } from "../config/env";

/**
 * Phase 13 deployment hardening, revised for Vercel (originally written for
 * Render — the platform choice changed mid-phase). Deliberately simple:
 * in-memory, not a distributed store. Documented assumptions/limitations,
 * verified against Vercel's actual documented behavior, not guessed:
 *
 * - IN-MEMORY STATE ON VERCEL: this deploys as a single Vercel Function
 *   using Fluid compute (the platform default). Fluid compute genuinely
 *   DOES let module-level in-memory state persist and be shared across
 *   concurrent requests handled by the same warm instance — this is not the
 *   classic one-request-per-instance Lambda model. However, Vercel spins up
 *   ADDITIONAL instances (each with its own separate memory) once a running
 *   instance has no spare capacity — which real load, and especially a
 *   burst of abusive traffic, is exactly the condition likely to trigger.
 *   So the guarantee is real but soft: strong at low/normal traffic (likely
 *   one warm instance), weaker specifically under the bursty traffic this
 *   exists to defend against, where the effective limit becomes
 *   (configured limit) x (however many instances Vercel scales to). Vercel's
 *   own guidance is explicit that anything needing an authoritative shared
 *   count across instances belongs in an external store (e.g. Vercel KV /
 *   Upstash Redis), not instance memory. Kept in-memory here anyway as a
 *   real, non-zero defense-in-depth layer appropriate for pre-launch scale —
 *   not introduced a distributed dependency speculatively. Revisit with a
 *   shared store once real traffic/attack patterns justify it, not before.
 * - CLIENT IP ON VERCEL: does NOT rely on Express's trust-proxy hop-counting
 *   (that model fits a self-managed reverse proxy like Render/nginx, where
 *   you know exactly how many hops sit in front of you — it doesn't map
 *   cleanly onto Vercel's edge network). Vercel documents that it overwrites
 *   `X-Forwarded-For` at its edge with the real, unspoofable client IP, and
 *   separately exposes `x-vercel-forwarded-for` as a guaranteed-untampered
 *   copy of the same value (kept distinct specifically for the case where
 *   something else sits in front of Vercel too). clientIp() below reads
 *   that header directly when present; falls back to req.ip for local dev,
 *   where neither header exists and there is no proxy at all.
 * - Disabled entirely when NODE_ENV=test (set automatically by Vitest) —
 *   the test suite legitimately calls these routes far more times, in a far
 *   shorter window, than any real caller would.
 */

function skipInTest(): boolean {
  return env.NODE_ENV === "test";
}

function clientIp(req: Request): string {
  const vercelForwardedFor = req.headers["x-vercel-forwarded-for"];
  if (typeof vercelForwardedFor === "string" && vercelForwardedFor.length > 0) {
    return vercelForwardedFor.split(",")[0]!.trim();
  }
  return req.ip ?? "unknown";
}

/** Baseline anti-abuse net across the whole API. */
export const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  // ipKeyGenerator normalizes IPv6 addresses to a fixed-size subnet -- using
  // the raw address directly would let a caller cycle through addresses
  // within their own /64 to evade the limit, since each one looks distinct.
  keyGenerator: (req: Request) => ipKeyGenerator(clientIp(req)),
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
  keyGenerator: (req: Request) => req.user?.id ?? ipKeyGenerator(clientIp(req)),
});
