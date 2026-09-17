import { z } from "zod";

export const mediaTypeSchema = z.enum(["photo", "video"]);
export type MediaType = z.infer<typeof mediaTypeSchema>;

// Allowed content_type per media_type — a fixed content-safety decision, not
// an env-configurable "limit". Size limits are configurable (see media.service.ts).
export const ALLOWED_CONTENT_TYPES: Record<MediaType, readonly string[]> = {
  photo: ["image/jpeg", "image/png", "image/webp"],
  video: ["video/mp4", "video/quicktime", "video/webm"],
};

export const requestUploadSchema = z
  .object({
    media_type: mediaTypeSchema,
    content_type: z.string().min(1).max(100),
    size_bytes: z.number().int().positive(),
  })
  .strict();

export type RequestUploadInput = z.infer<typeof requestUploadSchema>;

/**
 * Phase 29.6: `section_id` chooses the gallery this photo joins.
 *
 * Absent or `null` -> the location's GENERAL gallery, which is exactly what every existing caller
 * sends and therefore exactly what they keep getting. A uuid -> that section's gallery, provided the
 * section belongs to this location (checked in the service layer, and again in the database).
 */
export const completeUploadSchema = z
  .object({
    position: z.number().int().min(0).optional(),
    section_id: z.string().uuid().nullable().optional(),
  })
  .strict();

export type CompleteUploadInput = z.infer<typeof completeUploadSchema>;

/**
 * Phase 29 B2.5-a: `PUT /v1/locations/:id/media/order`.
 *
 * `ordered_ids` must be the gallery's COMPLETE order, not a partial edit
 * (approved decision Q1) — a partial list makes "where do the omitted photos
 * go?" ambiguous, and the client always holds the full list anyway. Set
 * equality against the real gallery is enforced in the service layer, which
 * owns the 404-vs-403-vs-400 distinction; this schema covers only the shape.
 *
 * The 100 cap is a technical/DoS guard (approved decision Q2), not a product
 * limit on how many photos a location may have — no such limit exists.
 *
 * Duplicates are rejected here rather than in the service so the caller gets
 * the standard zod `fieldErrors` detail shape every other 400 uses.
 */
export const MAX_REORDER_IDS = 100;

export const reorderMediaSchema = z
  .object({
    ordered_ids: z.array(z.string().uuid()).min(1).max(MAX_REORDER_IDS),
    /**
     * Phase 29.6: which gallery is being reordered. Absent or `null` = the general gallery, so every
     * pre-29.6 caller keeps its exact behaviour. `ordered_ids` must be the complete order of THAT
     * gallery: naming a general photo while reordering a section (or the reverse) is rejected the
     * same way another location's id always was.
     */
    section_id: z.string().uuid().nullable().optional(),
  })
  .strict()
  .refine((data) => new Set(data.ordered_ids).size === data.ordered_ids.length, {
    message: "ordered_ids must not contain duplicate ids.",
    path: ["ordered_ids"],
  });

export type ReorderMediaInput = z.infer<typeof reorderMediaSchema>;

/**
 * Phase 29.5: `updateMediaSchema` is REMOVED along with
 * `PATCH /v1/locations/:id/media/:mediaId`.
 *
 * It accepted a single raw `position` and renumbered nothing else, so a two-item swap required two
 * independent requests and sat on a duplicate position in between. `reorderMediaSchema` above states
 * the gallery's complete order in one request and is the supported ordering mechanism. Do not
 * reintroduce a single-item position endpoint.
 */

const uuid = z.string().uuid();

export const locationMediaParamsSchema = z.object({
  id: uuid,
  mediaId: uuid,
});
export type LocationMediaParams = z.infer<typeof locationMediaParamsSchema>;

export const locationIdOnlyParamSchema = z.object({ id: uuid });
export type LocationIdOnlyParam = z.infer<typeof locationIdOnlyParamSchema>;
