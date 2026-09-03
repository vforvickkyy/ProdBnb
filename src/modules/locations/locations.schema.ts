import { z } from "zod";

const uuid = z.string().uuid();

// Validated with Intl rather than a fixed list — throws on anything that
// isn't a real IANA identifier (e.g. "IST"/"PST" abbreviations, which are
// deliberately not canonical timezone representations for this API).
export const ianaTimezoneSchema = z.string().refine(
  (tz) => {
    try {
      new Intl.DateTimeFormat(undefined, { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  },
  { message: "Must be a valid IANA timezone identifier, e.g. 'Asia/Kolkata'." }
);

// ISO-4217-shaped, not a fixed allowlist — keeps international expansion
// from requiring a migration, while still rejecting obvious garbage.
export const currencySchema = z.string().regex(/^[A-Z]{3}$/, "Must be a 3-letter ISO currency code, e.g. 'INR'.");

export const locationStatusSchema = z.enum([
  "draft",
  "submitted",
  "under_review",
  "approved",
  "published",
  "rejected",
  "suspended",
  "archived",
]);

export const createLocationSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().max(5000).default(""),
    address_line1: z.string().max(200).nullable().optional(),
    address_line2: z.string().max(200).nullable().optional(),
    city: z.string().trim().min(1).max(120),
    region: z.string().max(120).nullable().optional(),
    country: z.string().trim().min(1).max(120),
    postal_code: z.string().max(20).nullable().optional(),
    latitude: z.number().min(-90).max(90).nullable().optional(),
    longitude: z.number().min(-180).max(180).nullable().optional(),
    capacity: z.number().int().positive().nullable().optional(),
    timezone: ianaTimezoneSchema.optional(),
    instant_booking_enabled: z.boolean().optional(),
    category_ids: z.array(uuid).max(20).default([]),
    amenity_ids: z.array(uuid).max(30).default([]),
    use_case_ids: z.array(uuid).max(10).default([]),
  })
  .strict();

export type CreateLocationInput = z.infer<typeof createLocationSchema>;

export const updateLocationSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(5000).optional(),
    address_line1: z.string().max(200).nullable().optional(),
    address_line2: z.string().max(200).nullable().optional(),
    city: z.string().trim().min(1).max(120).optional(),
    region: z.string().max(120).nullable().optional(),
    country: z.string().trim().min(1).max(120).optional(),
    postal_code: z.string().max(20).nullable().optional(),
    latitude: z.number().min(-90).max(90).nullable().optional(),
    longitude: z.number().min(-180).max(180).nullable().optional(),
    capacity: z.number().int().positive().nullable().optional(),
    timezone: ianaTimezoneSchema.optional(),
    instant_booking_enabled: z.boolean().optional(),
    category_ids: z.array(uuid).max(20).optional(),
    amenity_ids: z.array(uuid).max(30).optional(),
    use_case_ids: z.array(uuid).max(10).optional(),
    status: locationStatusSchema.optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, { message: "Provide at least one field to update." });

export type UpdateLocationInput = z.infer<typeof updateLocationSchema>;

export const locationIdParamSchema = z.object({ id: uuid });
export type LocationIdParam = z.infer<typeof locationIdParamSchema>;

export const listLocationsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListLocationsQuery = z.infer<typeof listLocationsQuerySchema>;

export const adminListLocationsQuerySchema = listLocationsQuerySchema.extend({
  status: locationStatusSchema.optional(),
  host_id: uuid.optional(),
  search: z.string().trim().min(1).max(200).optional(),
});
export type AdminListLocationsQuery = z.infer<typeof adminListLocationsQuerySchema>;
