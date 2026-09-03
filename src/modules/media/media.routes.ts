import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { optionalAuth } from "../../middleware/optionalAuth";
import { validate } from "../../middleware/validate";
import { deleteMediaHandler, getMedia, patchMedia, postCompleteUpload, postRequestUpload } from "./media.controller";
import {
  completeUploadSchema,
  locationIdOnlyParamSchema,
  locationMediaParamsSchema,
  requestUploadSchema,
  updateMediaSchema,
} from "./media.schema";

export const mediaRouter = Router();

// Ownership of :id is checked in the service layer (same 404-vs-403 idiom as
// locations PATCH/DELETE) — no requireRole('host') gate, since "do you own
// this location" is the real boundary, not "do you hold the host role
// somewhere in general" (a booker owns no locations either way).

mediaRouter.post(
  "/locations/:id/media/upload",
  requireAuth,
  validate({ params: locationIdOnlyParamSchema, body: requestUploadSchema }),
  postRequestUpload
);

mediaRouter.post(
  "/locations/:id/media/:mediaId/complete",
  requireAuth,
  validate({ params: locationMediaParamsSchema, body: completeUploadSchema }),
  postCompleteUpload
);

// Public if the parent location is published; owner/admin otherwise — same
// visibility rule as GET /v1/locations/:id (RLS-enforced).
mediaRouter.get("/locations/:id/media", optionalAuth, validate({ params: locationIdOnlyParamSchema }), getMedia);

mediaRouter.patch(
  "/locations/:id/media/:mediaId",
  requireAuth,
  validate({ params: locationMediaParamsSchema, body: updateMediaSchema }),
  patchMedia
);

mediaRouter.delete(
  "/locations/:id/media/:mediaId",
  requireAuth,
  validate({ params: locationMediaParamsSchema }),
  deleteMediaHandler
);
