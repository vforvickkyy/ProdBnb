import { SupabaseClient } from "@supabase/supabase-js";
import { NotFoundError, ValidationError } from "../../errors/AppError";
import { getLocation, getVisibleLocationOrNull, LocationDetail } from "../locations/locations.service";
import { writeAuditLog } from "./audit.service";

// All reads/writes here use the caller's own request-scoped client, never
// adminClient -- `locations_update_own_or_admin` and
// `profiles_select_own_or_admin` (both pre-existing RLS policies) already
// let an admin's own scoped client see/update any row, exactly the same way
// the generic PATCH /v1/locations/:id admin path already worked before this
// phase. No new RLS bypass is needed for moderation.

async function isHostSuspended(supabase: SupabaseClient, hostId: string): Promise<boolean> {
  const { data, error } = await supabase.from("profiles").select("status").eq("id", hostId).maybeSingle();
  if (error) {
    throw error;
  }
  return data?.status === "suspended";
}

async function updateLocationRow(supabase: SupabaseClient, locationId: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await supabase.from("locations").update(patch).eq("id", locationId);
  if (error) {
    throw error;
  }
}

/**
 * submitted/under_review -> published directly (Phase 11 decision: no
 * separate intermediate 'approved' publish step -- see docs/DATABASE.md).
 */
export async function approveLocation(supabase: SupabaseClient, adminId: string, locationId: string): Promise<LocationDetail> {
  const location = await getVisibleLocationOrNull(supabase, locationId);
  if (!location) {
    throw new NotFoundError("Location not found.");
  }
  if (location.status !== "submitted" && location.status !== "under_review") {
    throw new ValidationError(`Cannot approve a location with status '${location.status}'.`);
  }
  if (await isHostSuspended(supabase, location.host_id)) {
    throw new ValidationError("Cannot approve a location whose host is currently suspended.");
  }

  await updateLocationRow(supabase, locationId, { status: "published", moderation_reason: null });
  await writeAuditLog(adminId, "ADMIN_APPROVED_LOCATION", "location", locationId, null, { previous_status: location.status });
  return getLocation(supabase, locationId);
}

export async function rejectLocation(
  supabase: SupabaseClient,
  adminId: string,
  locationId: string,
  reason: string
): Promise<LocationDetail> {
  const location = await getVisibleLocationOrNull(supabase, locationId);
  if (!location) {
    throw new NotFoundError("Location not found.");
  }
  if (location.status !== "submitted" && location.status !== "under_review") {
    throw new ValidationError(`Cannot reject a location with status '${location.status}'.`);
  }

  await updateLocationRow(supabase, locationId, { status: "rejected", moderation_reason: reason });
  await writeAuditLog(adminId, "ADMIN_REJECTED_LOCATION", "location", locationId, reason, { previous_status: location.status });
  return getLocation(supabase, locationId);
}

/** Always clears suspended_by_host_suspension -- a manual suspend is always an independent admin decision. */
export async function suspendLocation(
  supabase: SupabaseClient,
  adminId: string,
  locationId: string,
  reason: string
): Promise<LocationDetail> {
  const location = await getVisibleLocationOrNull(supabase, locationId);
  if (!location) {
    throw new NotFoundError("Location not found.");
  }
  if (location.status !== "published") {
    throw new ValidationError(`Cannot suspend a location with status '${location.status}'.`);
  }

  await updateLocationRow(supabase, locationId, {
    status: "suspended",
    moderation_reason: reason,
    suspended_by_host_suspension: false,
  });
  await writeAuditLog(adminId, "ADMIN_SUSPENDED_LOCATION", "location", locationId, reason, { previous_status: "published" });
  return getLocation(supabase, locationId);
}

/** Always clears suspended_by_host_suspension too -- restoring a location is always an independent admin decision. */
export async function restoreLocation(supabase: SupabaseClient, adminId: string, locationId: string): Promise<LocationDetail> {
  const location = await getVisibleLocationOrNull(supabase, locationId);
  if (!location) {
    throw new NotFoundError("Location not found.");
  }
  if (location.status !== "suspended") {
    throw new ValidationError(`Cannot restore a location with status '${location.status}'.`);
  }

  await updateLocationRow(supabase, locationId, {
    status: "published",
    moderation_reason: null,
    suspended_by_host_suspension: false,
  });
  await writeAuditLog(adminId, "ADMIN_RESTORED_LOCATION", "location", locationId, null, {});
  return getLocation(supabase, locationId);
}
