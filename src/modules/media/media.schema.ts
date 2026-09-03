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

export const completeUploadSchema = z
  .object({
    position: z.number().int().min(0).optional(),
  })
  .strict();

export type CompleteUploadInput = z.infer<typeof completeUploadSchema>;

export const updateMediaSchema = z
  .object({
    position: z.number().int().min(0),
  })
  .strict();

export type UpdateMediaInput = z.infer<typeof updateMediaSchema>;

const uuid = z.string().uuid();

export const locationMediaParamsSchema = z.object({
  id: uuid,
  mediaId: uuid,
});
export type LocationMediaParams = z.infer<typeof locationMediaParamsSchema>;

export const locationIdOnlyParamSchema = z.object({ id: uuid });
export type LocationIdOnlyParam = z.infer<typeof locationIdOnlyParamSchema>;
