import { SupabaseClient } from "@supabase/supabase-js";
import { NextFunction, Request, Response } from "express";
import { ForbiddenError, UnauthenticatedError } from "../errors/AppError";

export type MarketplaceRole = "booker" | "host" | "admin";

/**
 * Reads through the caller's own request-scoped client, so this is just a
 * convenience check backed by the same RLS-protected data the database
 * itself enforces. Exported separately from requireRole so services that
 * need an admin/owner distinction (e.g. locations) can reuse it without a
 * second role-checking implementation.
 */
export async function callerHasRole(supabase: SupabaseClient, userId: string, role: MarketplaceRole): Promise<boolean> {
  const { data, error } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", role)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data !== null;
}

/**
 * Guards a route to callers holding a given marketplace role. Must run after
 * requireAuth (needs req.user / req.supabase).
 */
export function requireRole(role: MarketplaceRole) {
  return async function (req: Request, _res: Response, next: NextFunction): Promise<void> {
    if (!req.user || !req.supabase) {
      throw new UnauthenticatedError();
    }

    const has = await callerHasRole(req.supabase, req.user.id, role);

    if (!has) {
      throw new ForbiddenError(`This action requires the '${role}' role.`);
    }

    next();
  };
}
