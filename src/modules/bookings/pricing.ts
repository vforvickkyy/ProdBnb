import { SupabaseClient } from "@supabase/supabase-js";
import { ValidationError } from "../../errors/AppError";
import { BookingType } from "../pricing/pricing.schema";

export interface ActivePricing {
  amount_minor_units: number;
  currency: string;
  half_day_duration_hours: number | null;
}

export interface PricingResult {
  booking_type: BookingType;
  base_amount_minor_units: number;
  currency: string;
  total_amount_minor_units: number;
}

/** The one active `location_pricing` row for this (location, type) — 400 if none exists. */
export async function getActivePricing(
  supabase: SupabaseClient,
  locationId: string,
  bookingType: BookingType
): Promise<ActivePricing> {
  const { data, error } = await supabase
    .from("location_pricing")
    .select("amount_minor_units, currency, half_day_duration_hours")
    .eq("location_id", locationId)
    .eq("booking_type", bookingType)
    .eq("is_active", true)
    .maybeSingle();

  if (error) {
    throw error;
  }
  if (!data) {
    throw new ValidationError(`This location does not offer '${bookingType}' bookings.`);
  }
  return data;
}

function localDateString(instant: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(instant)
  );
}

/** Inclusive calendar-day count between two instants, in the location's own timezone. */
function countDays(startAt: string, endAt: string, timezone: string): number {
  const startDate = localDateString(startAt, timezone);
  const endDate = localDateString(endAt, timezone);
  const diffDays = (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000;
  return Math.round(diffDays) + 1;
}

/**
 * The single centralized pricing calculation — nowhere else in the booking
 * flow computes an amount. `hourly` multiplies by elapsed hours (the
 * original Phase 6 formula, unchanged); `half_day`/`day` are flat rates (the
 * configured amount already *is* the price for that unit, no multiplication);
 * `multi_day` multiplies by the inclusive number of production days,
 * matching the prompt's own worked example (₹15,000/day × 3 days = ₹45,000).
 * No taxes/fees/discounts computed yet — those snapshot columns stay 0,
 * structurally ready for Phase 7.
 */
export async function calculateBookingPrice(
  supabase: SupabaseClient,
  locationId: string,
  bookingType: BookingType,
  startAt: string,
  endAt: string,
  timezone: string
): Promise<PricingResult> {
  const pricing = await getActivePricing(supabase, locationId, bookingType);

  let baseAmount: number;
  if (bookingType === "hourly") {
    const hours = (new Date(endAt).getTime() - new Date(startAt).getTime()) / 3_600_000;
    baseAmount = Math.round(pricing.amount_minor_units * hours);
  } else if (bookingType === "half_day" || bookingType === "day") {
    baseAmount = pricing.amount_minor_units;
  } else {
    baseAmount = pricing.amount_minor_units * countDays(startAt, endAt, timezone);
  }

  return {
    booking_type: bookingType,
    base_amount_minor_units: baseAmount,
    currency: pricing.currency,
    total_amount_minor_units: baseAmount,
  };
}
