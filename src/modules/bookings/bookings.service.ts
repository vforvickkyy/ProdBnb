import { SupabaseClient } from "@supabase/supabase-js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../../errors/AppError";
import { getVisibleLocationOrNull } from "../locations/locations.service";
import {
  notifyBookingCancelled,
  notifyBookingConfirmed,
  notifyBookingDeclined,
  notifyBookingRequestReceived,
} from "../notifications/notification.service";
import { BookingType } from "../pricing/pricing.schema";
import { BookingActionInput, CreateBookingInput, ListBookingsQuery } from "./bookings.schema";
import { calculateBookingPrice, getActivePricing } from "./pricing";

const EXCLUSION_VIOLATION = "23P01";

const BOOKING_COLUMNS = `
  id, location_id, booker_id, booking_type, start_at, end_at, status,
  base_amount_minor_units, platform_fee_minor_units, tax_minor_units, discount_minor_units,
  total_amount_minor_units, currency,
  cancelled_at, cancelled_by, cancellation_reason,
  created_at, updated_at
`;

const BOOKING_DETAIL_SELECT = `
  ${BOOKING_COLUMNS},
  locations ( id, title, city, timezone )
`;

interface LocationRef {
  id: string;
  title: string;
  city: string;
  timezone: string;
}

interface RawBookingRow {
  id: string;
  location_id: string;
  booker_id: string;
  booking_type: string;
  start_at: string;
  end_at: string;
  status: string;
  base_amount_minor_units: number;
  platform_fee_minor_units: number;
  tax_minor_units: number;
  discount_minor_units: number;
  total_amount_minor_units: number;
  currency: string;
  cancelled_at: string | null;
  cancelled_by: string | null;
  cancellation_reason: string | null;
  created_at: string;
  updated_at: string;
  locations: LocationRef;
}

export interface BookingDetail {
  id: string;
  location: LocationRef;
  booker_id: string;
  booking_type: string;
  start_at: string;
  end_at: string;
  status: string;
  pricing: {
    base_amount_minor_units: number;
    platform_fee_minor_units: number;
    tax_minor_units: number;
    discount_minor_units: number;
    total_amount_minor_units: number;
    currency: string;
  };
  created_at: string;
  updated_at: string;
  cancelled_at: string | null;
  cancelled_by: string | null;
  cancellation_reason: string | null;
}

function toBookingDetail(row: RawBookingRow): BookingDetail {
  return {
    id: row.id,
    location: row.locations,
    booker_id: row.booker_id,
    booking_type: row.booking_type,
    start_at: row.start_at,
    end_at: row.end_at,
    status: row.status,
    pricing: {
      base_amount_minor_units: row.base_amount_minor_units,
      platform_fee_minor_units: row.platform_fee_minor_units,
      tax_minor_units: row.tax_minor_units,
      discount_minor_units: row.discount_minor_units,
      total_amount_minor_units: row.total_amount_minor_units,
      currency: row.currency,
    },
    created_at: row.created_at,
    updated_at: row.updated_at,
    cancelled_at: row.cancelled_at,
    cancelled_by: row.cancelled_by,
    cancellation_reason: row.cancellation_reason,
  };
}

interface ResolvedWindow {
  start_at: string;
  end_at: string;
}

/**
 * The earliest window-start / latest window-end for one calendar date, per
 * `get_location_availability()` — reused as-is, never reimplemented. Used
 * for both `day` (one date) and `multi_day` (check-in/check-out dates).
 * Throws if the location has no availability at all that date, rather than
 * assuming a naive full-day span.
 */
async function daySpan(supabase: SupabaseClient, locationId: string, date: string): Promise<ResolvedWindow> {
  const { data, error } = await supabase.rpc("get_location_availability", {
    _location_id: locationId,
    _from_date: date,
    _to_date: date,
  });
  if (error) {
    throw error;
  }
  const windows = (data ?? []) as ResolvedWindow[];
  if (windows.length === 0) {
    throw new ValidationError(`This location has no availability on ${date}.`);
  }

  let start_at = windows[0]!.start_at;
  let end_at = windows[0]!.end_at;
  for (const w of windows) {
    if (new Date(w.start_at) < new Date(start_at)) start_at = w.start_at;
    if (new Date(w.end_at) > new Date(end_at)) end_at = w.end_at;
  }
  return { start_at, end_at };
}

/**
 * Resolves any of the four booking-type request shapes down to the one
 * thing the database has always protected atomically: a [start_at, end_at)
 * interval. `is_interval_available()`/the EXCLUDE constraint downstream are
 * completely unaware of booking_type — they only ever see the interval this
 * function produces.
 */
async function resolveInterval(
  supabase: SupabaseClient,
  locationId: string,
  input: CreateBookingInput
): Promise<ResolvedWindow> {
  switch (input.booking_type) {
    case "hourly":
      return { start_at: input.start_at, end_at: input.end_at };

    case "half_day": {
      const pricing = await getActivePricing(supabase, locationId, "half_day");
      if (pricing.half_day_duration_hours === null) {
        throw new ValidationError("This location's half-day pricing has no duration configured.");
      }
      const endAt = new Date(new Date(input.start_at).getTime() + pricing.half_day_duration_hours * 3_600_000);
      return { start_at: input.start_at, end_at: endAt.toISOString() };
    }

    case "day":
      return daySpan(supabase, locationId, input.date);

    case "multi_day": {
      const [checkIn, checkOut] = await Promise.all([
        daySpan(supabase, locationId, input.start_date),
        daySpan(supabase, locationId, input.end_date),
      ]);
      return { start_at: checkIn.start_at, end_at: checkOut.end_at };
    }
  }
}

export async function createBooking(
  supabase: SupabaseClient,
  bookerId: string,
  input: CreateBookingInput
): Promise<BookingDetail> {
  const location = await getVisibleLocationOrNull(supabase, input.location_id);
  // A booker may only ever book a live, published listing — even a host or
  // admin previewing their own draft via getVisibleLocationOrNull can't
  // "book" it; that function answers visibility, not bookability.
  if (!location || location.status !== "published") {
    throw new NotFoundError("Location not found.");
  }

  const interval = await resolveInterval(supabase, input.location_id, input);

  const { data: available, error: availabilityError } = await supabase.rpc("is_interval_available", {
    _location_id: input.location_id,
    _start_at: interval.start_at,
    _end_at: interval.end_at,
  });
  if (availabilityError) {
    throw availabilityError;
  }
  if (!available) {
    throw new ValidationError("The requested time is not available.");
  }

  const pricing = await calculateBookingPrice(
    supabase,
    input.location_id,
    input.booking_type as BookingType,
    interval.start_at,
    interval.end_at,
    location.timezone
  );
  const status = location.instant_booking_enabled ? "confirmed" : "requested";

  const { data, error } = await supabase
    .from("bookings")
    .insert({
      location_id: input.location_id,
      booker_id: bookerId,
      booking_type: input.booking_type,
      start_at: interval.start_at,
      end_at: interval.end_at,
      status,
      base_amount_minor_units: pricing.base_amount_minor_units,
      total_amount_minor_units: pricing.total_amount_minor_units,
      currency: pricing.currency,
    })
    .select(BOOKING_DETAIL_SELECT)
    .single();

  if (error || !data) {
    // The authoritative guarantee: even though is_interval_available already
    // checked above, a concurrent request can still win the race between
    // that check and this insert — the exclusion constraint is what
    // actually prevents two overlapping active bookings from both existing,
    // regardless of which booking_type either side used to get there.
    if (error?.code === EXCLUSION_VIOLATION) {
      throw new ConflictError("This time was just booked by someone else. Please choose another time.");
    }
    throw error ?? new Error("Failed to create booking.");
  }

  const booking = toBookingDetail(data as unknown as RawBookingRow);

  // Downstream effect only -- never allowed to fail booking creation itself
  // (notify*() guarantees it never throws, see notification.service.ts).
  await notifyBookingRequestReceived(location.host_id, booking.id);
  if (booking.status === "confirmed") {
    // instant_booking_enabled skipped host approval -- the booker should
    // still be told their booking is confirmed.
    await notifyBookingConfirmed(bookerId, booking.id);
  }

  return booking;
}

export interface PaginatedBookings {
  data: BookingDetail[];
  total: number;
}

export async function listBookings(supabase: SupabaseClient, query: ListBookingsQuery): Promise<PaginatedBookings> {
  const from = (query.page - 1) * query.pageSize;
  const to = from + query.pageSize - 1;

  // PostgREST only treats an embedded-resource filter as row-restricting
  // (rather than just filtering what appears inside the nested object) when
  // the embed is marked `!inner` -- the default embed filters the nested
  // relation only, leaving every outer row in place regardless. Safe to
  // switch unconditionally on host_id specifically: bookings.location_id is
  // NOT NULL, so every booking has exactly one location, and this caller
  // (host_id is admin-only in practice) already has full RLS visibility
  // into locations -- an inner join here can never drop a row it shouldn't.
  const select = query.host_id ? BOOKING_DETAIL_SELECT.replace("locations (", "locations!inner (") : BOOKING_DETAIL_SELECT;
  let request = supabase.from("bookings").select(select, { count: "exact" });
  if (query.location_id) {
    request = request.eq("location_id", query.location_id);
  }
  if (query.status) {
    request = request.eq("status", query.status);
  }
  if (query.booker_id) {
    request = request.eq("booker_id", query.booker_id);
  }
  if (query.host_id) {
    request = request.eq("locations.host_id", query.host_id);
  }

  const { data, error, count } = await request.order("start_at", { ascending: false }).range(from, to);
  if (error) {
    throw error;
  }

  return {
    data: (data ?? []).map((row) => toBookingDetail(row as unknown as RawBookingRow)),
    total: count ?? 0,
  };
}

export async function getBooking(supabase: SupabaseClient, bookingId: string): Promise<BookingDetail> {
  const { data, error } = await supabase.from("bookings").select(BOOKING_DETAIL_SELECT).eq("id", bookingId).single();
  if (error || !data) {
    throw new NotFoundError("Booking not found.");
  }
  return toBookingDetail(data as unknown as RawBookingRow);
}

interface BookingAccess {
  row: { id: string; location_id: string; booker_id: string; status: string };
  isBooker: boolean;
  isHost: boolean;
}

// No isAdmin parameter needed here: RLS on `bookings` already lets an admin's
// scoped client see any row, so a missing row (data === null) genuinely
// means "doesn't exist or isn't visible to this caller at all" regardless
// of role — the isAdmin check only matters afterward, for which *action*
// each caller may perform on a row they can already see.
async function loadBookingAccess(supabase: SupabaseClient, callerId: string, bookingId: string): Promise<BookingAccess> {
  const { data, error } = await supabase
    .from("bookings")
    .select("id, location_id, booker_id, status")
    .eq("id", bookingId)
    .maybeSingle();
  if (error) {
    throw error;
  }
  if (!data) {
    throw new NotFoundError("Booking not found.");
  }

  const isBooker = data.booker_id === callerId;
  let isHost = false;
  if (!isBooker) {
    const location = await getVisibleLocationOrNull(supabase, data.location_id);
    isHost = location?.host_id === callerId;
  }

  return { row: data, isBooker, isHost };
}

async function transitionBooking(
  supabase: SupabaseClient,
  bookingId: string,
  patch: Record<string, unknown>
): Promise<BookingDetail> {
  const { data, error } = await supabase
    .from("bookings")
    .update(patch)
    .eq("id", bookingId)
    .select(BOOKING_DETAIL_SELECT)
    .maybeSingle();
  if (error) {
    throw error;
  }
  if (!data) {
    throw new NotFoundError("Booking not found.");
  }
  return toBookingDetail(data as unknown as RawBookingRow);
}

export async function confirmBooking(
  supabase: SupabaseClient,
  callerId: string,
  isAdmin: boolean,
  bookingId: string
): Promise<BookingDetail> {
  const { row, isHost } = await loadBookingAccess(supabase, callerId, bookingId);
  if (!isHost && !isAdmin) {
    throw new ForbiddenError("Only the host or an admin can confirm a booking.");
  }
  if (row.status !== "requested") {
    throw new ValidationError(`Cannot confirm a booking with status '${row.status}'.`);
  }
  const booking = await transitionBooking(supabase, bookingId, { status: "confirmed" });
  await notifyBookingConfirmed(booking.booker_id, booking.id);
  return booking;
}

export async function rejectBooking(
  supabase: SupabaseClient,
  callerId: string,
  isAdmin: boolean,
  bookingId: string,
  input: BookingActionInput
): Promise<BookingDetail> {
  const { row, isHost } = await loadBookingAccess(supabase, callerId, bookingId);
  if (!isHost && !isAdmin) {
    throw new ForbiddenError("Only the host or an admin can reject a booking.");
  }
  if (row.status !== "requested") {
    throw new ValidationError(`Cannot reject a booking with status '${row.status}'.`);
  }
  const booking = await transitionBooking(supabase, bookingId, {
    status: "rejected",
    cancellation_reason: input.reason ?? null,
  });
  await notifyBookingDeclined(booking.booker_id, booking.id);
  return booking;
}

export async function completeBooking(
  supabase: SupabaseClient,
  callerId: string,
  isAdmin: boolean,
  bookingId: string
): Promise<BookingDetail> {
  const { row, isHost } = await loadBookingAccess(supabase, callerId, bookingId);
  if (!isHost && !isAdmin) {
    throw new ForbiddenError("Only the host or an admin can complete a booking.");
  }
  if (row.status !== "confirmed") {
    throw new ValidationError(`Cannot complete a booking with status '${row.status}'.`);
  }
  return transitionBooking(supabase, bookingId, { status: "completed" });
}

export async function cancelBooking(
  supabase: SupabaseClient,
  callerId: string,
  isAdmin: boolean,
  bookingId: string,
  input: BookingActionInput
): Promise<BookingDetail> {
  const { row, isBooker, isHost } = await loadBookingAccess(supabase, callerId, bookingId);
  if (!isBooker && !isHost && !isAdmin) {
    throw new ForbiddenError("You do not have permission to cancel this booking.");
  }
  if (row.status !== "requested" && row.status !== "confirmed") {
    throw new ValidationError(`Cannot cancel a booking with status '${row.status}'.`);
  }
  const booking = await transitionBooking(supabase, bookingId, {
    status: "cancelled",
    cancelled_at: new Date().toISOString(),
    cancelled_by: callerId,
    cancellation_reason: input.reason ?? null,
  });

  // Notify whichever party did NOT do the cancelling -- the booker cancelling
  // notifies the host, the host (or an admin) cancelling notifies the booker.
  if (isBooker) {
    const location = await getVisibleLocationOrNull(supabase, row.location_id);
    if (location) {
      await notifyBookingCancelled(location.host_id, booking.id);
    }
  } else {
    await notifyBookingCancelled(booking.booker_id, booking.id);
  }

  return booking;
}
