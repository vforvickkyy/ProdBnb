import { NextFunction, Request, Response } from "express";
import { ForbiddenError, UnauthenticatedError } from "../errors/AppError";
import { anonClient, createUserScopedClient } from "../lib/supabase";

const BEARER_PREFIX = "Bearer ";

/**
 * Identifies the caller from a Supabase access token.
 *
 * Validates the token against Supabase Auth itself (auth.getUser) rather than
 * verifying the JWT signature locally — a network round trip, but it stays
 * correct automatically across key rotation and token revocation without the
 * backend having to manage signing keys. Attaches `req.user` and a
 * request-scoped `req.supabase` client (so downstream queries run under the
 * caller's own RLS context) for every authenticated request.
 *
 * Also enforces `profiles.status` (Phase 1 column, unenforced anywhere until
 * Phase 11's admin suspension capability made it meaningful): a `suspended`
 * account is rejected here, before any route-specific authorization runs.
 * Every existing user defaults to `'active'`, so this is a no-op for anyone
 * not explicitly suspended by an admin.
 */
export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.header("authorization");

  if (!header || !header.startsWith(BEARER_PREFIX)) {
    throw new UnauthenticatedError();
  }

  const accessToken = header.slice(BEARER_PREFIX.length).trim();
  if (!accessToken) {
    throw new UnauthenticatedError();
  }

  const { data, error } = await anonClient.auth.getUser(accessToken);

  if (error || !data.user) {
    throw new UnauthenticatedError("Your session is invalid or has expired.");
  }

  req.user = { id: data.user.id, email: data.user.email ?? null };
  req.supabase = createUserScopedClient(accessToken);

  const { data: profile, error: profileError } = await req.supabase
    .from("profiles")
    .select("status")
    .eq("id", data.user.id)
    .maybeSingle();
  if (profileError) {
    throw profileError;
  }
  if (profile && profile.status !== "active") {
    throw new ForbiddenError("Your account has been suspended.");
  }

  next();
}
