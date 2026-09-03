import { NextFunction, Request, Response } from "express";
import { UnauthenticatedError } from "../errors/AppError";
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

  next();
}
