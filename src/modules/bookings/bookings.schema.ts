import { z } from "zod";
import { bookingTypeSchema } from "../pricing/pricing.schema";

const uuid = z.string().uuid();
const offsetDateTime = z.string().datetime({ offset: true });
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be an ISO date, e.g. 2026-10-05.");

export const bookingStatusSchema = z.enum(["requested", "confirmed", "cancelled", "completed", "rejected"]);

// Each booking type has its own request shape — an hourly booking needs
// start+end, a day booking needs only a date, etc. (§16: "do not force every
// booking type to use meaningless identical request fields"). `booking_type`
// is the zod discriminant; every branch is `.strict()` so a request can't
// mix fields from the wrong type.

const hourlyBookingSchema = z
  .object({
    location_id: uuid,
    booking_type: z.literal("hourly"),
    start_at: offsetDateTime,
    end_at: offsetDateTime,
  })
  .strict();

const halfDayBookingSchema = z
  .object({
    location_id: uuid,
    booking_type: z.literal("half_day"),
    // end_at is derived from the location's configured half_day_duration_hours,
    // not client-supplied — see resolveInterval() in bookings.service.ts.
    start_at: offsetDateTime,
  })
  .strict();

const dayBookingSchema = z
  .object({
    location_id: uuid,
    booking_type: z.literal("day"),
    // No times at all — the reserved interval is derived from the location's
    // actual availability that date (never a naive 24-hour assumption).
    date: dateOnly,
  })
  .strict();

const multiDayBookingSchema = z
  .object({
    location_id: uuid,
    booking_type: z.literal("multi_day"),
    start_date: dateOnly,
    end_date: dateOnly,
  })
  .strict();

// Hourly is priced as rate x elapsed time (bookings/pricing.ts) — with no
// floor on that elapsed time, a short enough interval at a low enough rate
// rounds to a real ₹0 booking that still consumes a slot. 60 minutes is the
// smallest unit "hourly" pricing is already denominated in, so it's the
// natural floor rather than an arbitrary one; fractional hours above it
// (e.g. 2.5 hours) remain fully supported, unchanged.
const MIN_HOURLY_DURATION_MS = 60 * 60 * 1000;

// discriminatedUnion requires each member to be a plain ZodObject (so it can
// inspect the discriminant key directly) — a .refine() wraps a schema in
// ZodEffects, which breaks that. Cross-field checks that only apply to one
// branch are applied to the union as a whole instead, narrowing on
// booking_type inside the refinement.
const bookingUnionSchema = z
  .discriminatedUnion("booking_type", [hourlyBookingSchema, halfDayBookingSchema, dayBookingSchema, multiDayBookingSchema])
  .refine((d) => d.booking_type !== "hourly" || new Date(d.end_at) > new Date(d.start_at), {
    message: "end_at must be after start_at.",
    path: ["end_at"],
  })
  .refine(
    (d) =>
      d.booking_type !== "hourly" ||
      new Date(d.end_at).getTime() - new Date(d.start_at).getTime() >= MIN_HOURLY_DURATION_MS,
    {
      message: "Hourly bookings must be at least 60 minutes long.",
      path: ["end_at"],
    }
  )
  .refine((d) => d.booking_type !== "multi_day" || d.end_date >= d.start_date, {
    message: "end_date must not be before start_date.",
    path: ["end_date"],
  });

// Backward compatibility (§23): a request with no booking_type at all is the
// exact original Phase 6 shape ({location_id, start_at, end_at}) and is
// treated as `hourly` — an existing client that hasn't picked up the new
// field yet keeps working unmodified. A request that DOES specify a type
// still gets full, precise, per-type validation via the union above.
export const createBookingSchema = z.preprocess((value) => {
  if (value && typeof value === "object" && !("booking_type" in value)) {
    return { ...value, booking_type: "hourly" };
  }
  return value;
}, bookingUnionSchema);

export type CreateBookingInput = z.infer<typeof bookingUnionSchema>;

// reject/cancel bodies are entirely optional (just an optional reason) — a
// client that sends no body at all is legitimate here, but Express's
// express.json() leaves req.body as `undefined` (not `{}`) whenever no
// Content-Type/body is sent, which a bare z.object({...optional}) rejects.
// .default({}) makes "nothing sent" and "sent {}" behave identically.
export const bookingActionSchema = z
  .object({
    reason: z.string().max(500).nullable().optional(),
  })
  .strict()
  .default({});
export type BookingActionInput = z.infer<typeof bookingActionSchema>;

export const bookingIdParamSchema = z.object({ id: uuid });
export type BookingIdParam = z.infer<typeof bookingIdParamSchema>;

export const listBookingsQuerySchema = z.object({
  location_id: uuid.optional(),
  status: bookingStatusSchema.optional(),
  // Admin-only in practice (RLS already restricts a non-admin's results to
  // their own rows regardless of these filters being present) — exposed on
  // the shared schema rather than a separate admin one, since GET
  // /v1/admin/bookings is a thin wrapper around this same query.
  booker_id: uuid.optional(),
  host_id: uuid.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListBookingsQuery = z.infer<typeof listBookingsQuerySchema>;

export { bookingTypeSchema };
