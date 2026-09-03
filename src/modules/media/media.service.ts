import { randomUUID } from "node:crypto";
import { SupabaseClient } from "@supabase/supabase-js";
import { env } from "../../config/env";
import { NotFoundError, ValidationError } from "../../errors/AppError";
import { deleteObject, headObject, objectKeyFor, presignUpload } from "../../lib/r2";
import {
  assertLocationManageable,
  getVisibleLocationOrNull,
  PublicMediaItem,
  toPublicMediaItem,
} from "../locations/locations.service";
import { ALLOWED_CONTENT_TYPES, MediaType } from "./media.schema";

const MEDIA_COLUMNS = "id, media_type, storage_key, position, metadata, created_at, updated_at";

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

async function nextPosition(supabase: SupabaseClient, locationId: string): Promise<number> {
  const { data, error } = await supabase
    .from("location_media")
    .select("position")
    .eq("location_id", locationId)
    .order("position", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }
  return data ? data.position + 1 : 0;
}

export async function completeUpload(
  supabase: SupabaseClient,
  callerId: string,
  isAdmin: boolean,
  locationId: string,
  mediaId: string,
  position: number | undefined
): Promise<PublicMediaItem> {
  await assertCanManageLocation(supabase, callerId, isAdmin, locationId);

  const key = objectKeyFor(locationId, mediaId);
  const info = await headObject(key);

  if (!info || !info.contentType || info.contentLength === undefined) {
    throw new NotFoundError("No uploaded object found for this media id — upload it to the provided URL first.");
  }

  const mediaType = mediaTypeForContentType(info.contentType);
  if (!mediaType) {
    throw new ValidationError(`Uploaded content type '${info.contentType}' is not a supported media type.`);
  }
  if (info.contentLength > maxBytesFor(mediaType)) {
    throw new ValidationError(`Uploaded file exceeds the size limit for ${mediaType}.`);
  }

  const resolvedPosition = position ?? (await nextPosition(supabase, locationId));

  const { data, error } = await supabase
    .from("location_media")
    .insert({
      id: mediaId,
      location_id: locationId,
      media_type: mediaType,
      storage_key: key,
      position: resolvedPosition,
    })
    .select(MEDIA_COLUMNS)
    .single();

  if (error || !data) {
    throw error ?? new Error("Failed to record uploaded media.");
  }

  return toPublicMediaItem(data);
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

export async function updateMediaPosition(
  supabase: SupabaseClient,
  callerId: string,
  isAdmin: boolean,
  locationId: string,
  mediaId: string,
  position: number
): Promise<PublicMediaItem> {
  await assertCanManageLocation(supabase, callerId, isAdmin, locationId);

  const { data, error } = await supabase
    .from("location_media")
    .update({ position })
    .eq("id", mediaId)
    .eq("location_id", locationId)
    .select(MEDIA_COLUMNS)
    .maybeSingle();

  if (error) {
    throw error;
  }
  if (!data) {
    throw new NotFoundError("Media not found for this location.");
  }

  return toPublicMediaItem(data);
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
