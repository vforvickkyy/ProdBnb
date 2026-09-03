import { z } from "zod";

const uuid = z.string().uuid();
const offsetDateTime = z.string().datetime({ offset: true });

export const bookingStatusSchema = z.enum(["requested", "confirmed", "cancelled", "completed", "rejected"]);

export const createBookingSchema = z
  .object({
    location_id: uuid,
    start_at: offsetDateTime,
    end_at: offsetDateTime,
  })
  .strict()
  .refine((d) => new Date(d.end_at) > new Date(d.start_at), {
    message: "end_at must be after start_at.",
    path: ["end_at"],
  });
export type CreateBookingInput = z.infer<typeof createBookingSchema>;

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
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListBookingsQuery = z.infer<typeof listBookingsQuerySchema>;
