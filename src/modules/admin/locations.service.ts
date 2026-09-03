import { SupabaseClient } from "@supabase/supabase-js";
import { NotFoundError, ValidationError } from "../../errors/AppError";
import { adminClient } from "../../lib/supabase";
import { getLocation, getVisibleLocationOrNull, LocationDetail } from "../locations/locations.service";
import { writeAuditLog } from "./audit.service";

// Reads use the caller's own request-scoped client (RLS already lets an
// admin's own scoped client see any row). Writes use adminClient (Phase 12:
// `locations` no longer grants authenticated UPDATE on status/
// moderation_reason/suspended_by_host_suspension at all, precisely so a
// caller can't reach these columns via direct PostgREST -- these four
// functions are now the only place, alongside the generic-PATCH admin path
// in locations.service.ts, that can ever move them).

async function isHostSuspended(supabase: SupabaseClient, hostId: string): Promise<boolean> {
  const { data, error } = await supabase.from("profiles").select("status").eq("id", hostId).maybeSingle();
  if (error) {
    throw error;
  }
  return data?.status === "suspended";
}

async function updateLocationRow(locationId: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await adminClient.from("locations").update(patch).eq("id", locationId);
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

  await updateLocationRow(locationId, { status: "published", moderation_reason: null });
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

  await updateLocationRow(locationId, { status: "rejected", moderation_reason: reason });
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

  await updateLocationRow(locationId, {
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

  await updateLocationRow(locationId, {
    status: "published",
    moderation_reason: null,
    suspended_by_host_suspension: false,
  });
  await writeAuditLog(adminId, "ADMIN_RESTORED_LOCATION", "location", locationId, null, {});
  return getLocation(supabase, locationId);
}
