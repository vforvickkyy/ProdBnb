import { NextFunction, Request, Response } from "express";
import { anonClient, createUserScopedClient } from "../lib/supabase";

const BEARER_PREFIX = "Bearer ";

/**
 * Like requireAuth, but never rejects a missing/invalid token — it just falls
 * back to an anonymous client. For endpoints that behave differently for
 * signed-in vs. anonymous callers but must work for both (e.g. a location
 * detail view: public if published, owner/admin if not).
 */
export async function optionalAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.header("authorization");
  const accessToken = header?.startsWith(BEARER_PREFIX) ? header.slice(BEARER_PREFIX.length).trim() : undefined;

  if (!accessToken) {
    req.supabase = anonClient;
    next();
    return;
  }

  const { data, error } = await anonClient.auth.getUser(accessToken);

  if (error || !data.user) {
    req.supabase = anonClient;
    next();
    return;
  }

  req.user = { id: data.user.id, email: data.user.email ?? null };
  req.supabase = createUserScopedClient(accessToken);

  next();
}
