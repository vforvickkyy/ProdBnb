import { SupabaseClient } from "@supabase/supabase-js";
import { ForbiddenError, NotFoundError, ValidationError } from "../../errors/AppError";
import { CreateLocationInput, UpdateLocationInput } from "./locations.schema";

const FOREIGN_KEY_VIOLATION = "23503";

const LOCATION_COLUMNS = `
  id, host_id, title, description,
  address_line1, address_line2, city, region, country, postal_code,
  latitude, longitude, capacity, status, created_at, updated_at
`;

const LOCATION_DETAIL_SELECT = `
  ${LOCATION_COLUMNS},
  location_categories ( categories ( id, name ) ),
  location_amenities ( amenities ( id, name ) ),
  location_use_cases ( use_cases ( id, name ) ),
  location_media ( id, media_type, storage_key, position, metadata, created_at, updated_at )
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
  status: string;
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

export interface LocationMediaItem {
  id: string;
  media_type: "photo" | "video";
  storage_key: string;
  position: number;
  metadata: unknown;
  created_at: string;
  updated_at: string;
}

export interface LocationDetail extends LocationSummary {
  categories: CatalogRef[];
  amenities: CatalogRef[];
  use_cases: CatalogRef[];
  media: LocationMediaItem[];
  host: HostPublicSummary | null;
}

interface RawLocationDetailRow extends LocationSummary {
  location_categories: { categories: CatalogRef }[];
  location_amenities: { amenities: CatalogRef }[];
  location_use_cases: { use_cases: CatalogRef }[];
  location_media: LocationMediaItem[];
}

function flattenDetail(row: RawLocationDetailRow, host: HostPublicSummary | null): LocationDetail {
  const { location_categories, location_amenities, location_use_cases, location_media, ...summary } =
    row as RawLocationDetailRow;
  return {
    ...(summary as LocationSummary),
    categories: location_categories.map((r) => r.categories),
    amenities: location_amenities.map((r) => r.amenities),
    use_cases: location_use_cases.map((r) => r.use_cases),
    media: location_media,
    host,
  };
}

async function fetchHostPublicSummary(supabase: SupabaseClient, hostId: string): Promise<HostPublicSummary | null> {
  const { data, error } = await supabase.rpc("get_host_public_profile", { _host_id: hostId }).maybeSingle();
  if (error) {
    throw error;
  }
  return (data as HostPublicSummary | null) ?? null;
}

async function getVisibleLocationOrNull(supabase: SupabaseClient, id: string): Promise<LocationSummary | null> {
  const { data, error } = await supabase.from("locations").select(LOCATION_COLUMNS).eq("id", id).maybeSingle();
  if (error) {
    throw error;
  }
  return (data as LocationSummary | null) ?? null;
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

async function listLocations(
  supabase: SupabaseClient,
  page: number,
  pageSize: number,
  filters: { status?: string; hostId?: string } = {}
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

  const { data, error, count } = await query.order("created_at", { ascending: false }).range(from, to);

  if (error) {
    throw error;
  }

  return { data: (data as LocationSummary[]) ?? [], total: count ?? 0 };
}

export function listPublicLocations(anon: SupabaseClient, page: number, pageSize: number): Promise<PaginatedLocations> {
  return listLocations(anon, page, pageSize, { status: "published" });
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
  status?: string
): Promise<PaginatedLocations> {
  return listLocations(supabase, page, pageSize, status ? { status } : {});
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

  const patch = { ...fields, ...(status !== undefined ? { status } : {}) };

  if (Object.keys(patch).length > 0) {
    const { error } = await supabase.from("locations").update(patch).eq("id", locationId);
    if (error) {
      throw error;
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
    throw error;
  }
}
