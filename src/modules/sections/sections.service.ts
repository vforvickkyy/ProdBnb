import { SupabaseClient } from "@supabase/supabase-js";
import { ConflictError, NotFoundError, ValidationError } from "../../errors/AppError";
import {
  assertLocationManageable,
  getVisibleLocationOrNull,
  PublicMediaItem,
  RawLocationMediaRow,
  toPublicMediaItem,
} from "../locations/locations.service";
import { CreateSectionInput, MAX_SECTIONS_PER_LOCATION, UpdateSectionInput } from "./sections.schema";

const SECTION_COLUMNS = "id, location_id, name, description, created_at, updated_at";
const MEDIA_COLUMNS = "id, media_type, storage_key, position, metadata, created_at, updated_at";

export interface RawLocationSectionRow {
  id: string;
  location_id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface PublicLocationSection {
  id: string;
  location_id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * A section as the list endpoint returns it: metadata plus just enough to render a card — the
 * section's own cover and how many photos it holds.
 *
 * Deliberately **not** every media object of every section. A location with 20 sections of 30 photos
 * would otherwise make the list response 600 media rows, when a client rendering a rail needs one
 * image and a count. The full gallery is one request away at
 * `GET /v1/locations/:id/sections/:sectionId/media`.
 */
export interface PublicLocationSectionSummary extends PublicLocationSection {
  /** The section's own cover: its lowest-positioned photo. `null` when the section has none. */
  cover: PublicMediaItem | null;
  photo_count: number;
}

function toPublicSection(row: RawLocationSectionRow): PublicLocationSection {
  return {
    id: row.id,
    location_id: row.location_id,
    name: row.name,
    description: row.description,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * The section, if it belongs to this location. `null` otherwise.
 *
 * Scoping the lookup by `location_id` rather than checking afterwards is what makes a section from
 * another location indistinguishable from one that does not exist — the same non-oracular idiom the
 * media module already uses for a cross-location media id.
 */
async function findSectionOrNull(
  supabase: SupabaseClient,
  locationId: string,
  sectionId: string
): Promise<RawLocationSectionRow | null> {
  const { data, error } = await supabase
    .from("location_sections")
    .select(SECTION_COLUMNS)
    .eq("id", sectionId)
    .eq("location_id", locationId)
    .maybeSingle();

  if (error) {
    throw error;
  }
  return (data as RawLocationSectionRow | null) ?? null;
}

/**
 * Asserts the section exists **and belongs to this location**, for callers that have already been
 * authorized for the location. Throws the module's single 404 either way.
 */
export async function assertSectionBelongsToLocation(
  supabase: SupabaseClient,
  locationId: string,
  sectionId: string
): Promise<RawLocationSectionRow> {
  const section = await findSectionOrNull(supabase, locationId, sectionId);
  if (!section) {
    throw new NotFoundError("Section not found for this location.");
  }
  return section;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Every section of a location, with its cover and photo count.
 *
 * Visibility mirrors `GET /v1/locations/:id` exactly: a published location's sections are public, a
 * draft's are visible only to its owner and to admins. That rule lives in `getVisibleLocationOrNull`
 * and in the table's RLS policy, so it cannot drift between the two.
 */
export async function listSections(
  supabase: SupabaseClient,
  locationId: string
): Promise<PublicLocationSectionSummary[]> {
  const location = await getVisibleLocationOrNull(supabase, locationId);
  if (!location) {
    throw new NotFoundError("Location not found.");
  }
  return sectionSummariesFor(supabase, locationId);
}

/**
 * The same summaries without the visibility check, for callers that have already established the
 * location is visible to them — `GET /v1/locations/:id` in particular, which would otherwise read
 * the location twice to answer one request.
 *
 * RLS still applies: `location_sections_select_via_location` mirrors the parent location's
 * visibility, so this cannot return a draft's sections to someone who may not see the draft.
 */
export async function sectionSummariesFor(
  supabase: SupabaseClient,
  locationId: string
): Promise<PublicLocationSectionSummary[]> {
  const { data, error } = await supabase
    .from("location_sections")
    .select(SECTION_COLUMNS)
    .eq("location_id", locationId)
    .order("created_at", { ascending: true });

  if (error) {
    throw error;
  }

  const sections = (data ?? []) as RawLocationSectionRow[];
  if (sections.length === 0) {
    return [];
  }

  // One query for every section's media rather than one per section. Only the columns a cover and a
  // count need are read, and the rows come back position-ordered so the first row seen for a section
  // is that section's cover.
  const { data: mediaRows, error: mediaError } = await supabase
    .from("location_media")
    .select(`section_id, ${MEDIA_COLUMNS}`)
    .eq("location_id", locationId)
    .in(
      "section_id",
      sections.map((s) => s.id)
    )
    .order("position", { ascending: true });

  if (mediaError) {
    throw mediaError;
  }

  const covers = new Map<string, PublicMediaItem>();
  const counts = new Map<string, number>();
  for (const row of (mediaRows ?? []) as ({ section_id: string } & RawLocationMediaRow)[]) {
    const { section_id, ...media } = row;
    counts.set(section_id, (counts.get(section_id) ?? 0) + 1);
    if (!covers.has(section_id)) {
      covers.set(section_id, toPublicMediaItem(media as RawLocationMediaRow));
    }
  }

  return sections.map((section) => ({
    ...toPublicSection(section),
    cover: covers.get(section.id) ?? null,
    photo_count: counts.get(section.id) ?? 0,
  }));
}

export async function getSection(
  supabase: SupabaseClient,
  locationId: string,
  sectionId: string
): Promise<PublicLocationSection> {
  const location = await getVisibleLocationOrNull(supabase, locationId);
  if (!location) {
    throw new NotFoundError("Location not found.");
  }
  return toPublicSection(await assertSectionBelongsToLocation(supabase, locationId, sectionId));
}

/**
 * One section's media, position-ordered.
 *
 * Returns that section's photos and nothing else: no other section's, and none of the general
 * gallery's. The `section_id` equality does both.
 */
export async function listSectionMedia(
  supabase: SupabaseClient,
  locationId: string,
  sectionId: string
): Promise<PublicMediaItem[]> {
  const location = await getVisibleLocationOrNull(supabase, locationId);
  if (!location) {
    throw new NotFoundError("Location not found.");
  }
  await assertSectionBelongsToLocation(supabase, locationId, sectionId);

  const { data, error } = await supabase
    .from("location_media")
    .select(MEDIA_COLUMNS)
    .eq("location_id", locationId)
    .eq("section_id", sectionId)
    .order("position", { ascending: true });

  if (error) {
    throw error;
  }

  return ((data ?? []) as RawLocationMediaRow[]).map(toPublicMediaItem);
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export async function createSection(
  supabase: SupabaseClient,
  callerId: string,
  isAdmin: boolean,
  locationId: string,
  input: CreateSectionInput
): Promise<PublicLocationSection> {
  await assertLocationManageable(supabase, callerId, isAdmin, locationId);

  // The cap lives here so it can be a clean 400 that names the limit. `head: true` counts without
  // transferring rows.
  const { count, error: countError } = await supabase
    .from("location_sections")
    .select("id", { count: "exact", head: true })
    .eq("location_id", locationId);

  if (countError) {
    throw countError;
  }
  if ((count ?? 0) >= MAX_SECTIONS_PER_LOCATION) {
    throw new ValidationError(
      `A location may have at most ${MAX_SECTIONS_PER_LOCATION} sections (this one already has ${count}).`
    );
  }

  const { data, error } = await supabase
    .from("location_sections")
    .insert({ location_id: locationId, name: input.name, description: input.description ?? null })
    .select(SECTION_COLUMNS)
    .single();

  if (error) {
    throw error;
  }
  return toPublicSection(data as RawLocationSectionRow);
}

export async function updateSection(
  supabase: SupabaseClient,
  callerId: string,
  isAdmin: boolean,
  locationId: string,
  sectionId: string,
  input: UpdateSectionInput
): Promise<PublicLocationSection> {
  await assertLocationManageable(supabase, callerId, isAdmin, locationId);
  await assertSectionBelongsToLocation(supabase, locationId, sectionId);

  const { data, error } = await supabase
    .from("location_sections")
    .update(input)
    .eq("id", sectionId)
    .eq("location_id", locationId)
    .select(SECTION_COLUMNS)
    .maybeSingle();

  if (error) {
    throw error;
  }
  if (!data) {
    throw new NotFoundError("Section not found for this location.");
  }
  return toPublicSection(data as RawLocationSectionRow);
}

/**
 * Deletes a section — **only when it holds no media**.
 *
 * The alternatives were both rejected deliberately:
 *
 *  * Cascading the media rows away would delete photos, and media deletion is the one path that also
 *    removes the stored R2 object. Doing that as a side effect of renaming-and-removing an area
 *    would silently orphan objects and destroy content the host never chose to delete.
 *  * Reassigning the photos to the general gallery would be inventing product behaviour: it silently
 *    moves a "Police Station" photo into the location's main gallery, which is a decision for a
 *    person, not a DELETE.
 *
 * So the section must be emptied first, explicitly, through the media endpoints the host already
 * uses. `location_media.section_id` is `ON DELETE NO ACTION`, so even a caller who bypassed this
 * service hits a foreign-key violation rather than losing photos.
 */
export async function deleteSection(
  supabase: SupabaseClient,
  callerId: string,
  isAdmin: boolean,
  locationId: string,
  sectionId: string
): Promise<void> {
  await assertLocationManageable(supabase, callerId, isAdmin, locationId);
  await assertSectionBelongsToLocation(supabase, locationId, sectionId);

  const { count, error: countError } = await supabase
    .from("location_media")
    .select("id", { count: "exact", head: true })
    .eq("location_id", locationId)
    .eq("section_id", sectionId);

  if (countError) {
    throw countError;
  }
  if ((count ?? 0) > 0) {
    throw new ConflictError(
      `This section still has ${count} photo${count === 1 ? "" : "s"}. Delete or move them before deleting the section.`
    );
  }

  const { error } = await supabase
    .from("location_sections")
    .delete()
    .eq("id", sectionId)
    .eq("location_id", locationId);

  if (error) {
    throw error;
  }
}
