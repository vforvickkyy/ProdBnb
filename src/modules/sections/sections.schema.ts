import { z } from "zod";

/**
 * Phase 29.6: the most sections one location may have.
 *
 * Enforced in the service layer rather than as a trigger or constraint, so the caller gets a clean
 * `400 VALIDATION_ERROR` naming the limit instead of a database error. A product cap, not a
 * technical one.
 */
export const MAX_SECTIONS_PER_LOCATION = 20;

/** Matches `locations.title`'s limit — a section name is the same kind of short label. */
export const SECTION_NAME_MAX_LENGTH = 200;
/** Matches `locations.description`. */
export const SECTION_DESCRIPTION_MAX_LENGTH = 5000;

/**
 * Names are deliberately unconstrained beyond length: arbitrary text is allowed, and **duplicate
 * names within a location are permitted**. Two stages really can both be called "Warehouse", and
 * rejecting that would be the API inventing a rule the product does not have.
 */
export const createSectionSchema = z
  .object({
    name: z.string().trim().min(1).max(SECTION_NAME_MAX_LENGTH),
    description: z.string().max(SECTION_DESCRIPTION_MAX_LENGTH).nullable().optional(),
  })
  .strict();

export type CreateSectionInput = z.infer<typeof createSectionSchema>;

/**
 * `location_id` is deliberately absent: a section cannot be moved to another location. The RLS
 * policy's WITH CHECK enforces the same thing at the database level.
 */
export const updateSectionSchema = z
  .object({
    name: z.string().trim().min(1).max(SECTION_NAME_MAX_LENGTH).optional(),
    description: z.string().max(SECTION_DESCRIPTION_MAX_LENGTH).nullable().optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, { message: "Provide at least one field to update." });

export type UpdateSectionInput = z.infer<typeof updateSectionSchema>;

const uuid = z.string().uuid();

export const locationSectionParamsSchema = z.object({
  id: uuid,
  sectionId: uuid,
});
export type LocationSectionParams = z.infer<typeof locationSectionParamsSchema>;
