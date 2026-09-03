import { NextFunction, Request, Response } from "express";
import { ForbiddenError, UnauthenticatedError } from "../errors/AppError";

export type MarketplaceRole = "booker" | "host" | "admin";

/**
 * Guards a route to callers holding a given marketplace role. Must run after
 * requireAuth (needs req.user / req.supabase). Reads through the caller's own
 * request-scoped client, so this is just a convenience check backed by the
 * same RLS-protected data the database itself enforces.
 */
export function requireRole(role: MarketplaceRole) {
  return async function (req: Request, _res: Response, next: NextFunction): Promise<void> {
    if (!req.user || !req.supabase) {
      throw new UnauthenticatedError();
    }

    const { data, error } = await req.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", req.user.id)
      .eq("role", role)
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (!data) {
      throw new ForbiddenError(`This action requires the '${role}' role.`);
    }

    next();
  };
}
