import { SupabaseClient } from "@supabase/supabase-js";
import { ConflictError, ForbiddenError, NotFoundError } from "../../errors/AppError";
import { MarketplaceRole } from "../../middleware/requireRole";

const UNIQUE_VIOLATION = "23505";

export async function listRoles(supabase: SupabaseClient, userId: string): Promise<MarketplaceRole[]> {
  const { data, error } = await supabase.from("user_roles").select("role").eq("user_id", userId);

  if (error) {
    throw error;
  }

  return (data ?? []).map((row: { role: MarketplaceRole }) => row.role);
}

export async function assignRole(
  supabase: SupabaseClient,
  userId: string,
  role: MarketplaceRole
): Promise<MarketplaceRole[]> {
  if (role === "admin") {
    throw new ForbiddenError("The admin role cannot be self-assigned.");
  }

  const { error } = await supabase.from("user_roles").insert({ user_id: userId, role });

  if (error) {
    if (error.code === UNIQUE_VIOLATION) {
      throw new ConflictError(`You already have the '${role}' role.`);
    }
    throw error;
  }

  return listRoles(supabase, userId);
}

export async function removeRole(
  supabase: SupabaseClient,
  userId: string,
  role: MarketplaceRole
): Promise<MarketplaceRole[]> {
  if (role === "admin") {
    throw new ForbiddenError("The admin role cannot be removed via self-service.");
  }

  const { data, error } = await supabase
    .from("user_roles")
    .delete()
    .eq("user_id", userId)
    .eq("role", role)
    .select("role");

  if (error) {
    throw error;
  }

  if (!data || data.length === 0) {
    throw new NotFoundError(`You do not have the '${role}' role.`);
  }

  return listRoles(supabase, userId);
}
