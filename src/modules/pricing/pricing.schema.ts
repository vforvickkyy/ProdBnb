import { z } from "zod";
import { currencySchema } from "../locations/locations.schema";

const uuid = z.string().uuid();

export const bookingTypeSchema = z.enum(["hourly", "half_day", "day", "multi_day"]);
export type BookingType = z.infer<typeof bookingTypeSchema>;

export const createPricingSchema = z
  .object({
    booking_type: bookingTypeSchema,
    amount_minor_units: z.number().int().nonnegative(),
    currency: currencySchema.default("INR"),
    half_day_duration_hours: z.number().int().min(1).max(23).optional(),
  })
  .strict()
  .refine((d) => d.booking_type !== "half_day" || d.half_day_duration_hours !== undefined, {
    message: "half_day_duration_hours is required when booking_type is 'half_day'.",
    path: ["half_day_duration_hours"],
  })
  .refine((d) => d.booking_type === "half_day" || d.half_day_duration_hours === undefined, {
    message: "half_day_duration_hours is only valid when booking_type is 'half_day'.",
    path: ["half_day_duration_hours"],
  });
export type CreatePricingInput = z.infer<typeof createPricingSchema>;

export const updatePricingSchema = z
  .object({
    amount_minor_units: z.number().int().nonnegative().optional(),
    currency: currencySchema.optional(),
    half_day_duration_hours: z.number().int().min(1).max(23).nullable().optional(),
    is_active: z.boolean().optional(),
  })
  .strict()
  .refine((d) => Object.keys(d).length > 0, { message: "Provide at least one field to update." });
export type UpdatePricingInput = z.infer<typeof updatePricingSchema>;

export const locationIdParamSchema = z.object({ id: uuid });
export type LocationIdParam = z.infer<typeof locationIdParamSchema>;

export const pricingParamsSchema = z.object({ id: uuid, pricingId: uuid });
export type PricingParams = z.infer<typeof pricingParamsSchema>;
