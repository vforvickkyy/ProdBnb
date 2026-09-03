import { SupabaseClient } from "@supabase/supabase-js";
import { ConflictError, NotFoundError } from "../../errors/AppError";
import { assertLocationManageable } from "../locations/locations.service";
import { CreateBlockInput, UpdateBlockInput } from "./availability.schema";

const EXCLUSION_VIOLATION = "23P01";

const BLOCK_COLUMNS = "id, location_id, start_at, end_at, reason, created_by, created_at, updated_at";

export interface BlockedPeriod {
  id: string;
  location_id: string;
  start_at: string;
  end_at: string;
  reason: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export async function listBlocks(
  supabase: SupabaseClient,
  callerId: string,
  isAdmin: boolean,
  locationId: string
): Promise<BlockedPeriod[]> {
  await assertLocationManageable(supabase, callerId, isAdmin, locationId);

  const { data, error } = await supabase
    .from("location_blocked_periods")
    .select(BLOCK_COLUMNS)
    .eq("location_id", locationId)
    .order("start_at", { ascending: true });

  if (error) {
    throw error;
  }
  return data ?? [];
}

export async function createBlock(
  supabase: SupabaseClient,
  callerId: string,
  isAdmin: boolean,
  locationId: string,
  input: CreateBlockInput
): Promise<BlockedPeriod> {
  await assertLocationManageable(supabase, callerId, isAdmin, locationId);

  const { data, error } = await supabase
    .from("location_blocked_periods")
    .insert({ location_id: locationId, created_by: callerId, ...input })
    .select(BLOCK_COLUMNS)
    .single();

  if (error || !data) {
    if (error?.code === EXCLUSION_VIOLATION) {
      throw new ConflictError("This period overlaps an existing blocked period for this location.");
    }
    throw error ?? new Error("Failed to create blocked period.");
  }
  return data;
}

export async function updateBlock(
  supabase: SupabaseClient,
  callerId: string,
  isAdmin: boolean,
  locationId: string,
  blockId: string,
  input: UpdateBlockInput
): Promise<BlockedPeriod> {
  await assertLocationManageable(supabase, callerId, isAdmin, locationId);

  const { data, error } = await supabase
    .from("location_blocked_periods")
    .update(input)
    .eq("id", blockId)
    .eq("location_id", locationId)
    .select(BLOCK_COLUMNS)
    .maybeSingle();

  if (error) {
    if (error.code === EXCLUSION_VIOLATION) {
      throw new ConflictError("This period overlaps an existing blocked period for this location.");
    }
    throw error;
  }
  if (!data) {
    throw new NotFoundError("Blocked period not found for this location.");
  }
  return data;
}

export async function deleteBlock(
  supabase: SupabaseClient,
  callerId: string,
  isAdmin: boolean,
  locationId: string,
  blockId: string
): Promise<void> {
  await assertLocationManageable(supabase, callerId, isAdmin, locationId);

  const { data, error } = await supabase
    .from("location_blocked_periods")
    .delete()
    .eq("id", blockId)
    .eq("location_id", locationId)
    .select("id")
    .maybeSingle();

  if (error) {
    throw error;
  }
  if (!data) {
    throw new NotFoundError("Blocked period not found for this location.");
  }
}
