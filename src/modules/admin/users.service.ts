import { SupabaseClient } from "@supabase/supabase-js";
import { NotFoundError, ValidationError } from "../../errors/AppError";
import { adminClient } from "../../lib/supabase";
import { AdminProfileRow } from "../users/users.service";
import { writeAuditLog } from "./audit.service";

export interface AdminUserDetail extends AdminProfileRow {
  email: string | null;
  last_sign_in_at: string | null;
  locations_count: number;
  bookings_count: number;
}

/**
 * `profiles` deliberately has no email column (Phase 1: "Auth credentials
 * stay in auth.users"). Email/last-sign-in can only come from Supabase's
 * Admin Auth API, which is why this one read needs `adminClient` even
 * though every other admin read in this module uses the caller's own
 * request-scoped client where RLS already covers it.
 */
export async function getAdminUserDetail(supabase: SupabaseClient, userId: string): Promise<AdminUserDetail> {
  const { data: profile, error } = await supabase
    .from("profiles")
    .select("id, first_name, last_name, avatar_url, status, created_at, updated_at, user_roles ( role )")
    .eq("id", userId)
    .maybeSingle();
  if (error) {
    throw error;
  }
  if (!profile) {
    throw new NotFoundError("User not found.");
  }

  const { user_roles, ...rest } = profile as typeof profile & { user_roles: { role: string }[] };

  const [{ data: authUser }, locationsCount, bookingsCount] = await Promise.all([
    adminClient.auth.admin.getUserById(userId),
    supabase.from("locations").select("id", { count: "exact", head: true }).eq("host_id", userId),
    supabase.from("bookings").select("id", { count: "exact", head: true }).eq("booker_id", userId),
  ]);

  return {
    ...rest,
    roles: user_roles.map((r) => r.role),
    email: authUser.user?.email ?? null,
    last_sign_in_at: authUser.user?.last_sign_in_at ?? null,
    locations_count: locationsCount.count ?? 0,
    bookings_count: bookingsCount.count ?? 0,
  };
}

async function getProfileStatus(supabase: SupabaseClient, userId: string): Promise<string | null> {
  const { data, error } = await supabase.from("profiles").select("status").eq("id", userId).maybeSingle();
  if (error) {
    throw error;
  }
  return data?.status ?? null;
}

/**
 * `profiles.status` has no column-level UPDATE grant to `authenticated` at
 * all (Phase 1: "so profile updates can never self-escalate account
 * status") -- only `service_role` can write it, for any user including an
 * admin's own row. This is why suspend/restore must use `adminClient`, not
 * the caller's own scoped client, unlike most other admin writes in this
 * module.
 *
 * Cascades to the host's currently-`published` locations only (never
 * touches draft/submitted/independently-suspended/rejected/archived ones),
 * marking each with `suspended_by_host_suspension = true` so a later
 * restore can tell them apart from an independent admin decision. Existing
 * bookings, payments, and availability are never touched.
 */
export async function suspendUser(
  supabase: SupabaseClient,
  adminId: string,
  userId: string,
  reason: string
): Promise<AdminUserDetail> {
  const status = await getProfileStatus(supabase, userId);
  if (!status) {
    throw new NotFoundError("User not found.");
  }
  if (status === "suspended") {
    throw new ValidationError("User is already suspended.");
  }

  const { error: statusError } = await adminClient.from("profiles").update({ status: "suspended" }).eq("id", userId);
  if (statusError) {
    throw statusError;
  }

  const { data: locations, error: locationsError } = await adminClient
    .from("locations")
    .select("id")
    .eq("host_id", userId)
    .eq("status", "published");
  if (locationsError) {
    throw locationsError;
  }

  const locationIds = (locations ?? []).map((l) => l.id as string);
  if (locationIds.length > 0) {
    const { error: cascadeError } = await adminClient
      .from("locations")
      .update({
        status: "suspended",
        moderation_reason: "Host account suspended.",
        suspended_by_host_suspension: true,
      })
      .in("id", locationIds);
    if (cascadeError) {
      throw cascadeError;
    }
  }

  await writeAuditLog(adminId, "ADMIN_SUSPENDED_USER", "user", userId, reason, { suspended_location_ids: locationIds });
  return getAdminUserDetail(supabase, userId);
}

/** Only republishes locations this user's own suspension put down (see the migration's column comment) -- never an independently-moderated one. */
export async function restoreUser(supabase: SupabaseClient, adminId: string, userId: string): Promise<AdminUserDetail> {
  const status = await getProfileStatus(supabase, userId);
  if (!status) {
    throw new NotFoundError("User not found.");
  }
  if (status !== "suspended") {
    throw new ValidationError("User is not suspended.");
  }

  const { error: statusError } = await adminClient.from("profiles").update({ status: "active" }).eq("id", userId);
  if (statusError) {
    throw statusError;
  }

  const { data: locations, error: locationsError } = await adminClient
    .from("locations")
    .select("id")
    .eq("host_id", userId)
    .eq("status", "suspended")
    .eq("suspended_by_host_suspension", true);
  if (locationsError) {
    throw locationsError;
  }

  const locationIds = (locations ?? []).map((l) => l.id as string);
  if (locationIds.length > 0) {
    const { error: cascadeError } = await adminClient
      .from("locations")
      .update({ status: "published", moderation_reason: null, suspended_by_host_suspension: false })
      .in("id", locationIds);
    if (cascadeError) {
      throw cascadeError;
    }
  }

  await writeAuditLog(adminId, "ADMIN_RESTORED_USER", "user", userId, null, { restored_location_ids: locationIds });
  return getAdminUserDetail(supabase, userId);
}
