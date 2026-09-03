import { SupabaseClient } from "@supabase/supabase-js";
import { ConflictError, NotFoundError } from "../../errors/AppError";
import { assertLocationManageable } from "../locations/locations.service";
import { CreateRuleInput, UpdateRuleInput } from "./availability.schema";

const EXCLUSION_VIOLATION = "23P01";

const RULE_COLUMNS = "id, location_id, day_of_week, start_time, end_time, created_at, updated_at";

export interface AvailabilityRule {
  id: string;
  location_id: string;
  day_of_week: string;
  start_time: string;
  end_time: string;
  created_at: string;
  updated_at: string;
}

export async function listRules(
  supabase: SupabaseClient,
  callerId: string,
  isAdmin: boolean,
  locationId: string
): Promise<AvailabilityRule[]> {
  await assertLocationManageable(supabase, callerId, isAdmin, locationId);

  const { data, error } = await supabase
    .from("location_availability_rules")
    .select(RULE_COLUMNS)
    .eq("location_id", locationId)
    .order("day_of_week", { ascending: true })
    .order("start_time", { ascending: true });

  if (error) {
    throw error;
  }
  return data ?? [];
}

export async function createRule(
  supabase: SupabaseClient,
  callerId: string,
  isAdmin: boolean,
  locationId: string,
  input: CreateRuleInput
): Promise<AvailabilityRule> {
  await assertLocationManageable(supabase, callerId, isAdmin, locationId);

  const { data, error } = await supabase
    .from("location_availability_rules")
    .insert({ location_id: locationId, ...input })
    .select(RULE_COLUMNS)
    .single();

  if (error || !data) {
    if (error?.code === EXCLUSION_VIOLATION) {
      throw new ConflictError("This window overlaps an existing availability rule for that day.");
    }
    throw error ?? new Error("Failed to create availability rule.");
  }
  return data;
}

export async function updateRule(
  supabase: SupabaseClient,
  callerId: string,
  isAdmin: boolean,
  locationId: string,
  ruleId: string,
  input: UpdateRuleInput
): Promise<AvailabilityRule> {
  await assertLocationManageable(supabase, callerId, isAdmin, locationId);

  const { data, error } = await supabase
    .from("location_availability_rules")
    .update(input)
    .eq("id", ruleId)
    .eq("location_id", locationId)
    .select(RULE_COLUMNS)
    .maybeSingle();

  if (error) {
    if (error.code === EXCLUSION_VIOLATION) {
      throw new ConflictError("This window overlaps an existing availability rule for that day.");
    }
    throw error;
  }
  if (!data) {
    throw new NotFoundError("Availability rule not found for this location.");
  }
  return data;
}

export async function deleteRule(
  supabase: SupabaseClient,
  callerId: string,
  isAdmin: boolean,
  locationId: string,
  ruleId: string
): Promise<void> {
  await assertLocationManageable(supabase, callerId, isAdmin, locationId);

  const { data, error } = await supabase
    .from("location_availability_rules")
    .delete()
    .eq("id", ruleId)
    .eq("location_id", locationId)
    .select("id")
    .maybeSingle();

  if (error) {
    throw error;
  }
  if (!data) {
    throw new NotFoundError("Availability rule not found for this location.");
  }
}
