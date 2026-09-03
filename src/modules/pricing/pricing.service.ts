import { SupabaseClient } from "@supabase/supabase-js";
import { ConflictError, NotFoundError } from "../../errors/AppError";
import { assertLocationManageable, getVisibleLocationOrNull } from "../locations/locations.service";
import { CreatePricingInput, UpdatePricingInput } from "./pricing.schema";

const UNIQUE_VIOLATION = "23505";

const PRICING_COLUMNS = `
  id, location_id, booking_type, amount_minor_units, currency,
  half_day_duration_hours, is_active, created_at, updated_at
`;

export interface LocationPricing {
  id: string;
  location_id: string;
  booking_type: string;
  amount_minor_units: number;
  currency: string;
  half_day_duration_hours: number | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * Public/non-owning callers only ever see active pricing (an inactive row
 * is a host-management concern, not something a booker should be offered).
 * Owner/admin see everything, active or not, so they can manage it.
 */
export async function listPricing(
  supabase: SupabaseClient,
  callerId: string | undefined,
  locationId: string
): Promise<LocationPricing[]> {
  const location = await getVisibleLocationOrNull(supabase, locationId);
  if (!location) {
    throw new NotFoundError("Location not found.");
  }

  const isManager = callerId !== undefined && location.host_id === callerId;

  let query = supabase.from("location_pricing").select(PRICING_COLUMNS).eq("location_id", locationId);
  if (!isManager) {
    query = query.eq("is_active", true);
  }

  const { data, error } = await query.order("booking_type", { ascending: true });
  if (error) {
    throw error;
  }
  return data ?? [];
}

export async function createPricing(
  supabase: SupabaseClient,
  callerId: string,
  isAdmin: boolean,
  locationId: string,
  input: CreatePricingInput
): Promise<LocationPricing> {
  await assertLocationManageable(supabase, callerId, isAdmin, locationId);

  const { data, error } = await supabase
    .from("location_pricing")
    .insert({ location_id: locationId, ...input })
    .select(PRICING_COLUMNS)
    .single();

  if (error || !data) {
    if (error?.code === UNIQUE_VIOLATION) {
      throw new ConflictError(`Pricing for '${input.booking_type}' is already configured for this location.`);
    }
    throw error ?? new Error("Failed to create pricing.");
  }
  return data;
}

export async function updatePricing(
  supabase: SupabaseClient,
  callerId: string,
  isAdmin: boolean,
  locationId: string,
  pricingId: string,
  input: UpdatePricingInput
): Promise<LocationPricing> {
  await assertLocationManageable(supabase, callerId, isAdmin, locationId);

  const { data, error } = await supabase
    .from("location_pricing")
    .update(input)
    .eq("id", pricingId)
    .eq("location_id", locationId)
    .select(PRICING_COLUMNS)
    .maybeSingle();

  if (error) {
    throw error;
  }
  if (!data) {
    throw new NotFoundError("Pricing configuration not found for this location.");
  }
  return data;
}

export async function deletePricing(
  supabase: SupabaseClient,
  callerId: string,
  isAdmin: boolean,
  locationId: string,
  pricingId: string
): Promise<void> {
  await assertLocationManageable(supabase, callerId, isAdmin, locationId);

  const { data, error } = await supabase
    .from("location_pricing")
    .delete()
    .eq("id", pricingId)
    .eq("location_id", locationId)
    .select("id")
    .maybeSingle();

  if (error) {
    throw error;
  }
  if (!data) {
    throw new NotFoundError("Pricing configuration not found for this location.");
  }
}
