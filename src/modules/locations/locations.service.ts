import { SupabaseClient } from "@supabase/supabase-js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../../errors/AppError";
import { adminClient } from "../../lib/supabase";
import { publicUrlFor } from "../../lib/r2";
import { writeAuditLog } from "../admin/audit.service";
import { CreateLocationInput, UpdateLocationInput } from "./locations.schema";

const FOREIGN_KEY_VIOLATION = "23503";

// base_price_minor_units/currency (Phase 6) are deliberately not selected
// here anymore — location_pricing (Phase 6A) is the sole pricing source now.
// The columns still exist in the database (never dropped) but the app layer
// stops reading/writing them, so there's no way for the two to disagree.
// moderation_reason (Phase 11) is safe to include in this shared select even
// though it can carry admin-written text: it is only ever non-null in the
// same UPDATE that moves status away from 'published' (reject/suspend), and
// cleared in the same UPDATE that moves it back (approve/restore) — a
// publicly-visible (published) row therefore always has moderation_reason
// null by construction, never leaking anything through the public detail/
// search response. See src/modules/admin/locations.service.ts.
const LOCATION_COLUMNS = `
  id, host_id, title, description,
  address_line1, address_line2, city, region, country, postal_code,
  latitude, longitude, capacity, timezone, instant_booking_enabled,
  status, moderation_reason, suspended_by_host_suspension, created_at, updated_at
`;

const LOCATION_DETAIL_SELECT = `
  ${LOCATION_COLUMNS},
  location_categories ( categories ( id, name ) ),
  location_amenities ( amenities ( id, name ) ),
  location_use_cases ( use_cases ( id, name ) ),
  location_media ( id, media_type, storage_key, position, metadata, created_at, updated_at ),
  location_pricing ( booking_type, amount_minor_units, currency, is_active )
`;

// A host may only request these transitions through the general-purpose
// PATCH endpoint; anything else from a non-admin caller is 403. Admins may
// set any of the 8 statuses. Kept deliberately small — a full workflow
// engine is explicitly a later-phase concern.
const HOST_ALLOWED_TRANSITIONS: Record<string, string[]> = {
  draft: ["submitted"],
  submitted: ["draft"],
  published: ["archived"],
};

const REQUIRED_FOR_SUBMISSION = ["title", "description", "city", "country", "latitude", "longitude"] as const;

export interface LocationSummary {
  id: string;
  host_id: string;
  title: string;
  description: string;
  address_line1: string | null;
  address_line2: string | null;
  city: string;
  region: string | null;
  country: string;
  postal_code: string | null;
  latitude: number | null;
  longitude: number | null;
  capacity: number | null;
  timezone: string;
  instant_booking_enabled: boolean;
  status: string;
  moderation_reason: string | null;
  // Only visible to the location's own host or an admin (locations SELECT
  // RLS restricts a non-published row to those two anyway) -- distinguishes
  // "your host account was suspended" from "this specific listing was
  // suspended" so the moderation UI can show the right explanation (Phase
  // 14; the underlying column and cascade logic are unchanged from Phase 11).
  suspended_by_host_suspension: boolean;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

export interface CatalogRef {
  id: string;
  name: string;
}

export interface HostPublicSummary {
  id: string;
  first_name: string | null;
  last_name: string | null;
  avatar_url: string | null;
}

/** Raw shape as stored/queried — never returned to a client (storage_key is an internal R2 detail). */
interface RawLocationMediaRow {
  id: string;
  media_type: "photo" | "video";
  storage_key: string;
  position: number;
  metadata: unknown;
  created_at: string;
  updated_at: string;
}

/** Public-facing shape: a computed `url`, never the raw storage key. */
export interface PublicMediaItem {
  id: string;
  media_type: "photo" | "video";
  url: string;
  position: number;
  created_at: string;
  updated_at: string;
}

export function toPublicMediaItem(row: RawLocationMediaRow): PublicMediaItem {
  return {
    id: row.id,
    media_type: row.media_type,
    url: publicUrlFor(row.storage_key),
    position: row.position,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export interface BookingOption {
  type: string;
  amount_minor_units: number;
  currency: string;
}

interface RawLocationPricingRow {
  booking_type: string;
  amount_minor_units: number;
  currency: string;
  is_active: boolean;
}

export interface LocationDetail extends LocationSummary {
  categories: CatalogRef[];
  amenities: CatalogRef[];
  use_cases: CatalogRef[];
  media: PublicMediaItem[];
  host: HostPublicSummary | null;
  booking_options: BookingOption[];
}

interface RawLocationDetailRow extends LocationSummary {
  location_categories: { categories: CatalogRef }[];
  location_amenities: { amenities: CatalogRef }[];
  location_use_cases: { use_cases: CatalogRef }[];
  location_media: RawLocationMediaRow[];
  location_pricing: RawLocationPricingRow[];
}

function flattenDetail(row: RawLocationDetailRow, host: HostPublicSummary | null): LocationDetail {
  const { location_categories, location_amenities, location_use_cases, location_media, location_pricing, ...summary } =
    row as RawLocationDetailRow;
  return {
    ...(summary as LocationSummary),
    categories: location_categories.map((r) => r.categories),
    amenities: location_amenities.map((r) => r.amenities),
    use_cases: location_use_cases.map((r) => r.use_cases),
    media: location_media.map(toPublicMediaItem).sort((a, b) => a.position - b.position),
    host,
    // Active pricing only — booking_options is a marketplace/booking-facing
    // field, not a management one, so it's filtered the same way regardless
    // of who's viewing (the owner/admin management view of inactive pricing
    // configs lives at GET /v1/locations/:id/pricing, not here).
    booking_options: location_pricing
      .filter((p) => p.is_active)
      .map((p) => ({ type: p.booking_type, amount_minor_units: p.amount_minor_units, currency: p.currency })),
  };
}

async function fetchHostPublicSummary(supabase: SupabaseClient, hostId: string): Promise<HostPublicSummary | null> {
  const { data, error } = await supabase.rpc("get_host_public_profile", { _host_id: hostId }).maybeSingle();
  if (error) {
    throw error;
  }
  return (data as HostPublicSummary | null) ?? null;
}

export async function getVisibleLocationOrNull(supabase: SupabaseClient, id: string): Promise<LocationSummary | null> {
  const { data, error } = await supabase.from("locations").select(LOCATION_COLUMNS).eq("id", id).maybeSingle();
  if (error) {
    throw error;
  }
  return (data as LocationSummary | null) ?? null;
}

/**
 * Shared ownership/visibility gate reused by every module that manages a
 * sub-resource of a location (media, availability, ...): invisible location
 * -> 404 (don't reveal a private draft exists), visible but not owned and
 * caller isn't admin -> 403.
 */
export async function assertLocationManageable(
  supabase: SupabaseClient,
  callerId: string,
  isAdmin: boolean,
  locationId: string
): Promise<LocationSummary> {
  const location = await getVisibleLocationOrNull(supabase, locationId);
  if (!location) {
    throw new NotFoundError("Location not found.");
  }
  if (location.host_id !== callerId && !isAdmin) {
    throw new ForbiddenError("You do not have permission to manage this location.");
  }
  return location;
}

export async function getLocation(supabase: SupabaseClient, id: string): Promise<LocationDetail> {
  const { data, error } = await supabase.from("locations").select(LOCATION_DETAIL_SELECT).eq("id", id).single();

  if (error || !data) {
    throw new NotFoundError("Location not found.");
  }

  const row = data as unknown as RawLocationDetailRow;
  const host = await fetchHostPublicSummary(supabase, row.host_id);
  return flattenDetail(row, host);
}

export interface PaginatedLocations {
  data: LocationSummary[];
  total: number;
}

export interface LocationListFilters {
  status?: string;
  hostId?: string;
  search?: string;
}

async function listLocations(
  supabase: SupabaseClient,
  page: number,
  pageSize: number,
  filters: LocationListFilters = {}
): Promise<PaginatedLocations> {
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  let query = supabase.from("locations").select(LOCATION_COLUMNS, { count: "exact" });

  if (filters.status) {
    query = query.eq("status", filters.status);
  }
  if (filters.hostId) {
    query = query.eq("host_id", filters.hostId);
  }
  if (filters.search) {
    query = query.ilike("title", `%${filters.search}%`);
  }

  const { data, error, count } = await query.order("created_at", { ascending: false }).range(from, to);

  if (error) {
    throw error;
  }

  return { data: (data as LocationSummary[]) ?? [], total: count ?? 0 };
}

export function listMyLocations(
  supabase: SupabaseClient,
  hostId: string,
  page: number,
  pageSize: number
): Promise<PaginatedLocations> {
  return listLocations(supabase, page, pageSize, { hostId });
}

export function listAllLocationsForAdmin(
  supabase: SupabaseClient,
  page: number,
  pageSize: number,
  filters: LocationListFilters = {}
): Promise<PaginatedLocations> {
  return listLocations(supabase, page, pageSize, filters);
}

async function replaceTags(
  supabase: SupabaseClient,
  locationId: string,
  table: string,
  column: string,
  ids: string[]
): Promise<void> {
  const { error: deleteError } = await supabase.from(table).delete().eq("location_id", locationId);
  if (deleteError) {
    throw deleteError;
  }

  if (ids.length === 0) {
    return;
  }

  const rows = ids.map((id) => ({ location_id: locationId, [column]: id }));
  const { error: insertError } = await supabase.from(table).insert(rows);
  if (insertError) {
    if (insertError.code === FOREIGN_KEY_VIOLATION) {
      throw new ValidationError("One or more category/amenity/use-case IDs do not exist.");
    }
    throw insertError;
  }
}

export async function createLocation(
  supabase: SupabaseClient,
  hostId: string,
  input: CreateLocationInput
): Promise<LocationDetail> {
  const { category_ids, amenity_ids, use_case_ids, ...fields } = input;

  const { data: createdRow, error } = await supabase
    .from("locations")
    .insert({ ...fields, host_id: hostId })
    .select(LOCATION_COLUMNS)
    .single();

  if (error || !createdRow) {
    throw error ?? new Error("Failed to create location.");
  }

  const locationId = (createdRow as LocationSummary).id;

  await replaceTags(supabase, locationId, "location_categories", "category_id", category_ids);
  await replaceTags(supabase, locationId, "location_amenities", "amenity_id", amenity_ids);
  await replaceTags(supabase, locationId, "location_use_cases", "use_case_id", use_case_ids);

  return getLocation(supabase, locationId);
}

export async function updateLocation(
  supabase: SupabaseClient,
  callerId: string,
  isAdmin: boolean,
  locationId: string,
  input: UpdateLocationInput
): Promise<LocationDetail> {
  const current = await getVisibleLocationOrNull(supabase, locationId);
  if (!current) {
    throw new NotFoundError("Location not found.");
  }
  if (current.host_id !== callerId && !isAdmin) {
    throw new ForbiddenError("You do not have permission to modify this location.");
  }

  const { category_ids, amenity_ids, use_case_ids, status, ...fields } = input;

  if (status !== undefined && !isAdmin) {
    const allowed = HOST_ALLOWED_TRANSITIONS[current.status] ?? [];
    if (!allowed.includes(status)) {
      throw new ForbiddenError(`Hosts cannot change status from '${current.status}' to '${status}'.`);
    }
    if (status === "submitted") {
      const merged = { ...current, ...fields };
      const missing = REQUIRED_FOR_SUBMISSION.filter((key) => {
        const value = merged[key];
        return value === null || value === undefined || value === "";
      });
      if (missing.length > 0) {
        throw new ValidationError(`Cannot submit for review — missing: ${missing.join(", ")}.`);
      }
    }
  }

  // `locations` no longer grants authenticated UPDATE on status at all
  // (Phase 12: a host could otherwise self-publish or self-restore via
  // direct PostgREST, bypassing HOST_ALLOWED_TRANSITIONS/admin moderation
  // entirely). Ordinary content fields are unaffected -- host-owns-row is
  // still fully enforced above, and via RLS -- only status now requires the
  // service-role client. Two separate statements because a single UPDATE
  // naming any column the caller's own client isn't granted would fail in
  // full, even for the columns it IS allowed to touch.
  if (Object.keys(fields).length > 0) {
    const { error } = await supabase.from("locations").update(fields).eq("id", locationId);
    if (error) {
      throw error;
    }
  }

  if (status !== undefined) {
    const { error } = await adminClient.from("locations").update({ status }).eq("id", locationId);
    if (error) {
      throw error;
    }
    if (isAdmin) {
      // Only the four purpose-built moderation actions (approve/reject/
      // suspend/restore, admin/locations.service.ts) map cleanly onto their
      // own documented audit action -- this generic path can reach ANY of
      // the 8 statuses (including 'approved'/'under_review', which no
      // dedicated endpoint produces), so it gets its own, equally-audited
      // action rather than being force-fit into one of the other four.
      await writeAuditLog(callerId, "ADMIN_UPDATED_LOCATION_STATUS", "location", locationId, null, {
        previous_status: current.status,
        new_status: status,
      });
    }
  }

  if (category_ids !== undefined) {
    await replaceTags(supabase, locationId, "location_categories", "category_id", category_ids);
  }
  if (amenity_ids !== undefined) {
    await replaceTags(supabase, locationId, "location_amenities", "amenity_id", amenity_ids);
  }
  if (use_case_ids !== undefined) {
    await replaceTags(supabase, locationId, "location_use_cases", "use_case_id", use_case_ids);
  }

  return getLocation(supabase, locationId);
}

export async function deleteLocation(
  supabase: SupabaseClient,
  callerId: string,
  isAdmin: boolean,
  locationId: string
): Promise<void> {
  const current = await getVisibleLocationOrNull(supabase, locationId);
  if (!current) {
    throw new NotFoundError("Location not found.");
  }
  if (current.host_id !== callerId && !isAdmin) {
    throw new ForbiddenError("You do not have permission to delete this location.");
  }

  const { error } = await supabase.from("locations").delete().eq("id", locationId);
  if (error) {
    // bookings.location_id deliberately has no ON DELETE CASCADE — a
    // location with any booking history can't be deleted out from under it.
    if (error.code === FOREIGN_KEY_VIOLATION) {
      throw new ConflictError("Cannot delete a location with existing bookings.");
    }
    throw error;
  }
}
