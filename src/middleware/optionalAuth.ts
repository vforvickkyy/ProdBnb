import { NextFunction, Request, Response } from "express";
import { anonClient, createUserScopedClient } from "../lib/supabase";

const BEARER_PREFIX = "Bearer ";

/**
 * Like requireAuth, but never rejects a missing/invalid token — it just falls
 * back to an anonymous client. For endpoints that behave differently for
 * signed-in vs. anonymous callers but must work for both (e.g. a location
 * detail view: public if published, owner/admin if not).
 *
 * A suspended/deleted account (Phase 12: this check was previously only in
 * requireAuth) falls back to anonymous the same way an invalid token does,
 * rather than being rejected outright — this middleware never rejects, it
 * only ever downgrades to "treat this request as if it were unauthenticated."
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

  const scopedClient = createUserScopedClient(accessToken);
  const { data: profile, error: profileError } = await scopedClient
    .from("profiles")
    .select("status")
    .eq("id", data.user.id)
    .maybeSingle();
  if (profileError) {
    throw profileError;
  }
  if (profile && profile.status !== "active") {
    req.supabase = anonClient;
    next();
    return;
  }

  req.user = { id: data.user.id, email: data.user.email ?? null };
  req.supabase = scopedClient;

  next();
}
