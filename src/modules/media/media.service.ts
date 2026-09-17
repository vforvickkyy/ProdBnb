import { randomUUID } from "node:crypto";
import { SupabaseClient } from "@supabase/supabase-js";
import { env } from "../../config/env";
import { NotFoundError, ValidationError } from "../../errors/AppError";
import { deleteObject, headObject, objectKeyFor, presignUpload } from "../../lib/r2";
import { adminClient } from "../../lib/supabase";
import {
  assertLocationManageable,
  getVisibleLocationOrNull,
  PublicMediaItem,
  RawLocationMediaRow,
  toPublicMediaItem,
} from "../locations/locations.service";
import { ALLOWED_CONTENT_TYPES, MediaType } from "./media.schema";

const MEDIA_COLUMNS = "id, media_type, storage_key, position, metadata, created_at, updated_at";

/** Postgres unique_violation. Same module-local constant the messaging/payments/roles services use. */
const UNIQUE_VIOLATION = "23505";

/**
 * The single 404 body `completeUpload` returns for **every** media id it will not record:
 * one that was never uploaded, and one that is already recorded against a different location.
 *
 * Deliberately identical in both cases. A distinct "that belongs to someone else" message would
 * turn a media id into an existence oracle — a caller could probe ids and learn which ones exist
 * somewhere in the system. Returning the not-uploaded answer is also what would happen naturally
 * without the cross-location check, since `objectKeyFor` is scoped per location: a foreign media's
 * object lives under *its* location's prefix, so a HEAD against this caller's prefix finds nothing.
 */
const NOT_UPLOADED_MESSAGE = "No uploaded object found for this media id — upload it to the provided URL first.";

function maxBytesFor(mediaType: MediaType): number {
  const mb = mediaType === "photo" ? env.MEDIA_MAX_PHOTO_SIZE_MB : env.MEDIA_MAX_VIDEO_SIZE_MB;
  return mb * 1024 * 1024;
}

function mediaTypeForContentType(contentType: string): MediaType | undefined {
  return (Object.keys(ALLOWED_CONTENT_TYPES) as MediaType[]).find((type) =>
    ALLOWED_CONTENT_TYPES[type].includes(contentType)
  );
}

async function assertCanManageLocation(
  supabase: SupabaseClient,
  callerId: string,
  isAdmin: boolean,
  locationId: string
): Promise<void> {
  await assertLocationManageable(supabase, callerId, isAdmin, locationId);
}

export interface UploadAuthorization {
  media_id: string;
  upload_url: string;
  method: "PUT";
  headers: { "Content-Type": string; "Content-Length": string };
  expires_at: string;
}

export async function requestUpload(
  supabase: SupabaseClient,
  callerId: string,
  isAdmin: boolean,
  locationId: string,
  input: { media_type: MediaType; content_type: string; size_bytes: number }
): Promise<UploadAuthorization> {
  await assertCanManageLocation(supabase, callerId, isAdmin, locationId);

  if (!ALLOWED_CONTENT_TYPES[input.media_type].includes(input.content_type)) {
    throw new ValidationError(`content_type '${input.content_type}' is not allowed for media_type '${input.media_type}'.`);
  }

  const maxBytes = maxBytesFor(input.media_type);
  if (input.size_bytes > maxBytes) {
    throw new ValidationError(`File exceeds the ${Math.round(maxBytes / (1024 * 1024))}MB limit for ${input.media_type}.`);
  }

  const mediaId = randomUUID();
  const key = objectKeyFor(locationId, mediaId);
  const { url, expiresAt } = await presignUpload(key, input.content_type, input.size_bytes);

  return {
    media_id: mediaId,
    upload_url: url,
    method: "PUT",
    headers: { "Content-Type": input.content_type, "Content-Length": String(input.size_bytes) },
    expires_at: expiresAt.toISOString(),
  };
}

/**
 * Phase 29.5: `nextPosition()` is gone, and deliberately has no replacement here.
 *
 * It read `max(position)` in one statement and the insert used it in another, with no lock in
 * between. Under READ COMMITTED two completions racing for the same location both read the same
 * maximum and both inserted the same position — and with iOS uploading two photos at a time, that
 * race is the ordinary multi-photo path rather than an edge case.
 *
 * Reading and inserting are now one statement sequence inside `record_location_media()`, serialised
 * per location by a transaction-scoped advisory lock. Computing the position in TypeScript cannot be
 * made safe, because the supabase client has no transaction to hold a lock across.
 */

/**
 * The outcome of a completion, so the route can answer 201 for a genuine first
 * record and 200 for an idempotent replay.
 */
export interface CompleteUploadResult {
  item: PublicMediaItem;
  /** `true` only when this call is the one that inserted the row. */
  created: boolean;
}

/**
 * Looks a recorded media row up by id **across all locations**, through `adminClient`.
 *
 * Deliberately not the caller's scoped client: under RLS a row on another host's *draft* location
 * is invisible, so a scoped lookup would find nothing, fall through to the insert, and only then
 * collide — making behaviour depend on the other location's publication status. The admin lookup is
 * deterministic, and nothing it finds is ever returned to the caller unless the row belongs to the
 * location they have already been authorized for.
 */
async function findRecordedMedia(mediaId: string): Promise<{ location_id: string; row: RawLocationMediaRow } | null> {
  const { data, error } = await adminClient
    .from("location_media")
    .select(`location_id, ${MEDIA_COLUMNS}`)
    .eq("id", mediaId)
    .maybeSingle();

  if (error) {
    throw error;
  }
  if (!data) {
    return null;
  }

  const { location_id, ...row } = data as { location_id: string } & RawLocationMediaRow;
  return { location_id, row: row as RawLocationMediaRow };
}

/**
 * Records an uploaded object against a location — **idempotently** (Phase 29 B2.5-b).
 *
 * The failure mode this closes: the insert names an explicit `id`, so a retry after a lost response
 * violated the primary key, and `errorHandler` has no 23505 mapping, so the client saw a bare
 * `500 INTERNAL_ERROR` for a completion that had actually succeeded. iOS worked around it by
 * re-reading the listing's media before ever retrying a complete; web and Android would each have
 * had to reinvent that.
 *
 * Three outcomes, in this order:
 *
 *  A. **Not yet recorded** — the pre-B2.5-b path, unchanged: verify the R2 object exists, validate
 *     its *actual* content type and size, then insert. 201.
 *  B. **Already recorded for this location** — return that row as it was first stored. 200.
 *     **No second R2 HEAD, no re-insert, no position change, no timestamp touched.**
 *  C. **Already recorded for a different location** — 404, with the same body as A's not-uploaded
 *     case. See `NOT_UPLOADED_MESSAGE`.
 */
export async function completeUpload(
  supabase: SupabaseClient,
  callerId: string,
  isAdmin: boolean,
  locationId: string,
  mediaId: string,
  position: number | undefined
): Promise<CompleteUploadResult> {
  // Unchanged, and deliberately still first: a caller who cannot manage this location learns
  // nothing about any media id, because they never get past here.
  await assertCanManageLocation(supabase, callerId, isAdmin, locationId);

  const alreadyRecorded = await findRecordedMedia(mediaId);
  if (alreadyRecorded) {
    if (alreadyRecorded.location_id !== locationId) {
      throw new NotFoundError(NOT_UPLOADED_MESSAGE);
    }
    // Case B. Nothing is read from R2 and nothing is written.
    return { item: toPublicMediaItem(alreadyRecorded.row), created: false };
  }

  const key = objectKeyFor(locationId, mediaId);
  const info = await headObject(key);

  if (!info || !info.contentType || info.contentLength === undefined) {
    throw new NotFoundError(NOT_UPLOADED_MESSAGE);
  }

  const mediaType = mediaTypeForContentType(info.contentType);
  if (!mediaType) {
    throw new ValidationError(`Uploaded content type '${info.contentType}' is not a supported media type.`);
  }
  if (info.contentLength > maxBytesFor(mediaType)) {
    throw new ValidationError(`Uploaded file exceeds the size limit for ${mediaType}.`);
  }

  // Phase 29.5: the position is resolved and the row inserted inside one function call, under a
  // per-location advisory lock, so two concurrent completions cannot be handed the same position.
  // `position` is passed straight through — an explicitly requested one is still honoured verbatim.
  //
  // Still adminClient, not the caller's own scoped client (Phase 12: `location_media` no longer
  // grants authenticated INSERT at all) -- otherwise a host could bypass the headObject()
  // verification above entirely via direct PostgREST and register a row pointing at any
  // storage_key, including another location's real, already-uploaded media. `record_location_media`
  // is granted to service_role alone for the same reason. Ownership was already fully checked by
  // assertCanManageLocation() above.
  const { data, error } = await adminClient.rpc("record_location_media", {
    _media_id: mediaId,
    _location_id: locationId,
    _media_type: mediaType,
    _storage_key: key,
    _position: position ?? null,
  });

  const [insertedRow] = (data ?? []) as RawLocationMediaRow[];
  if (!error && insertedRow) {
    return { item: toPublicMediaItem(insertedRow), created: true };
  }

  // The lookup above found nothing, so a primary-key collision here means a concurrent request
  // inserted the same media id between the two statements. The correct answer is the row that
  // already exists — the same answer case B gives — rather than a 500 for work that succeeded.
  //
  // Scoped deliberately: only a 23505 whose row can actually be found for THIS location becomes a
  // success. A 23505 with nothing to find, or one belonging elsewhere, is not swallowed.
  if (error?.code === UNIQUE_VIOLATION) {
    const raced = await findRecordedMedia(mediaId);
    if (raced) {
      if (raced.location_id !== locationId) {
        throw new NotFoundError(NOT_UPLOADED_MESSAGE);
      }
      return { item: toPublicMediaItem(raced.row), created: false };
    }
    // 23505 with nothing to find means the collision was not this media id —
    // surface it rather than inventing a result.
  }

  throw error ?? new Error("Failed to record uploaded media.");
}

export async function listMedia(supabase: SupabaseClient, locationId: string): Promise<PublicMediaItem[]> {
  const location = await getVisibleLocationOrNull(supabase, locationId);
  if (!location) {
    throw new NotFoundError("Location not found.");
  }

  const { data, error } = await supabase
    .from("location_media")
    .select(MEDIA_COLUMNS)
    .eq("location_id", locationId)
    .order("position", { ascending: true });

  if (error) {
    throw error;
  }

  return (data ?? []).map(toPublicMediaItem);
}

/**
 * Phase 29.5: `updateMediaPosition()` and its `PATCH /v1/locations/:id/media/:mediaId` route are
 * REMOVED. Do not reintroduce a single-item position mutation.
 *
 * It set one row's raw position and renumbered no siblings, so expressing even a two-item swap
 * meant two independent requests that were transiently -- and, if the second never arrived,
 * permanently -- both on the same position. `reorderMedia()` below states the gallery's complete
 * order in one transaction and is the supported ordering mechanism.
 *
 * `authenticated` deliberately KEEPS its `UPDATE ("position")` grant on location_media: that grant
 * is what authorises `reorder_location_media()`, which is SECURITY INVOKER. Revoking it because the
 * PATCH route is gone would break the atomic reorder.
 */

/**
 * Phase 29 B2.5-a: atomically renumbers the whole gallery to exactly 0..n-1 in
 * the order given.
 *
 * Replaces the caller having to issue one `PATCH .../media/:mediaId` per moved
 * photo — up to N sequential, independent transactions, any of which could fail
 * and leave the gallery partially renumbered. `PATCH` itself is deliberately
 * untouched and still works; B2.5-c is what stops iOS using it for reorder.
 *
 * The primary validation lives here rather than in the RPC so error mapping
 * matches every other media route: ownership first (404 for a location the
 * caller cannot see, 403 for one they can but do not own), then 400 for a body
 * that does not describe this gallery. The function repeats the set checks as a
 * backstop — see its comment — but is never relied upon for the response shape.
 */
export async function reorderMedia(
  supabase: SupabaseClient,
  callerId: string,
  isAdmin: boolean,
  locationId: string,
  orderedIds: string[]
): Promise<PublicMediaItem[]> {
  await assertCanManageLocation(supabase, callerId, isAdmin, locationId);

  // The schema already rejects duplicates; repeated here because this function
  // is reachable from anywhere in the module, not only through that route.
  if (new Set(orderedIds).size !== orderedIds.length) {
    throw new ValidationError("ordered_ids must not contain duplicate ids.");
  }

  // B2.6: the general gallery becomes `.is("section_id", null)` here, and a
  // section's gallery `.eq("section_id", sectionId)`.
  const { data, error } = await supabase.from("location_media").select("id").eq("location_id", locationId);

  if (error) {
    throw error;
  }

  const gallery = new Set((data ?? []).map((row) => row.id as string));

  // Deliberately says nothing about whether an unknown id exists elsewhere —
  // validation must not become an existence oracle for another host's media.
  if (orderedIds.some((id) => !gallery.has(id))) {
    throw new ValidationError("ordered_ids contains media that does not belong to this location's gallery.");
  }

  // Completeness (approved decision Q1). Reached only when every id was
  // recognised, so a mismatch here means photos were omitted.
  if (orderedIds.length !== gallery.size) {
    throw new ValidationError(
      `ordered_ids must list every photo in this gallery exactly once (gallery has ${gallery.size}, received ${orderedIds.length}).`
    );
  }

  // One transaction. The RPC returns the resulting rows, so no second read is
  // needed and the response cannot disagree with what was committed.
  const { data: rows, error: rpcError } = await supabase.rpc("reorder_location_media", {
    _location_id: locationId,
    _ordered_ids: orderedIds,
  });

  if (rpcError) {
    throw rpcError;
  }

  return ((rows ?? []) as RawLocationMediaRow[]).map(toPublicMediaItem);
}

export async function deleteMedia(
  supabase: SupabaseClient,
  callerId: string,
  isAdmin: boolean,
  locationId: string,
  mediaId: string
): Promise<void> {
  await assertCanManageLocation(supabase, callerId, isAdmin, locationId);

  const { data, error } = await supabase
    .from("location_media")
    .select("storage_key")
    .eq("id", mediaId)
    .eq("location_id", locationId)
    .maybeSingle();

  if (error) {
    throw error;
  }
  if (!data) {
    throw new NotFoundError("Media not found for this location.");
  }

  // Best-effort: a transient R2 error shouldn't block a host from removing
  // unwanted content from their own listing. The metadata row is the source
  // of truth for what's actually shown; an orphaned R2 object costs nothing
  // and can be cleaned up later.
  try {
    await deleteObject(data.storage_key);
  } catch (err) {
    console.error(`Failed to delete R2 object ${data.storage_key}:`, err);
  }

  const { error: deleteError } = await supabase.from("location_media").delete().eq("id", mediaId).eq("location_id", locationId);
  if (deleteError) {
    throw deleteError;
  }
}
