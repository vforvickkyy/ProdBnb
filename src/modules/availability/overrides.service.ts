import { SupabaseClient } from "@supabase/supabase-js";
import { ConflictError, NotFoundError } from "../../errors/AppError";
import { assertLocationManageable } from "../locations/locations.service";
import { CreateOverrideInput, UpdateOverrideInput } from "./availability.schema";

const UNIQUE_VIOLATION = "23505";

const OVERRIDE_COLUMNS = "id, location_id, date, status, start_time, end_time, created_at, updated_at";

export interface AvailabilityOverride {
  id: string;
  location_id: string;
  date: string;
  status: string;
  start_time: string | null;
  end_time: string | null;
  created_at: string;
  updated_at: string;
}

export async function listOverrides(
  supabase: SupabaseClient,
  callerId: string,
  isAdmin: boolean,
  locationId: string
): Promise<AvailabilityOverride[]> {
  await assertLocationManageable(supabase, callerId, isAdmin, locationId);

  const { data, error } = await supabase
    .from("location_availability_overrides")
    .select(OVERRIDE_COLUMNS)
    .eq("location_id", locationId)
    .order("date", { ascending: true });

  if (error) {
    throw error;
  }
  return data ?? [];
}

export async function createOverride(
  supabase: SupabaseClient,
  callerId: string,
  isAdmin: boolean,
  locationId: string,
  input: CreateOverrideInput
): Promise<AvailabilityOverride> {
  await assertLocationManageable(supabase, callerId, isAdmin, locationId);

  const { data, error } = await supabase
    .from("location_availability_overrides")
    .insert({ location_id: locationId, ...input })
    .select(OVERRIDE_COLUMNS)
    .single();

  if (error || !data) {
    if (error?.code === UNIQUE_VIOLATION) {
      throw new ConflictError("An override already exists for this date — update or delete it instead.");
    }
    throw error ?? new Error("Failed to create availability override.");
  }
  return data;
}

export async function updateOverride(
  supabase: SupabaseClient,
  callerId: string,
  isAdmin: boolean,
  locationId: string,
  overrideId: string,
  input: UpdateOverrideInput
): Promise<AvailabilityOverride> {
  await assertLocationManageable(supabase, callerId, isAdmin, locationId);

  // Switching to unavailable must also clear any previously-set hours, or a
  // partial update would leave the old start/end times in place and
  // violate the table's own status/time-consistency check.
  const patch = input.status === "unavailable" ? { ...input, start_time: null, end_time: null } : input;

  const { data, error } = await supabase
    .from("location_availability_overrides")
    .update(patch)
    .eq("id", overrideId)
    .eq("location_id", locationId)
    .select(OVERRIDE_COLUMNS)
    .maybeSingle();

  if (error) {
    throw error;
  }
  if (!data) {
    throw new NotFoundError("Availability override not found for this location.");
  }
  return data;
}

export async function deleteOverride(
  supabase: SupabaseClient,
  callerId: string,
  isAdmin: boolean,
  locationId: string,
  overrideId: string
): Promise<void> {
  await assertLocationManageable(supabase, callerId, isAdmin, locationId);

  const { data, error } = await supabase
    .from("location_availability_overrides")
    .delete()
    .eq("id", overrideId)
    .eq("location_id", locationId)
    .select("id")
    .maybeSingle();

  if (error) {
    throw error;
  }
  if (!data) {
    throw new NotFoundError("Availability override not found for this location.");
  }
}
