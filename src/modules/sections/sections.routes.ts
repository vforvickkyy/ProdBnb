import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { optionalAuth } from "../../middleware/optionalAuth";
import { validate } from "../../middleware/validate";
import { locationIdOnlyParamSchema } from "../media/media.schema";
import {
  deleteSectionHandler,
  getSectionDetail,
  getSectionMedia,
  getSections,
  patchSection,
  postSection,
} from "./sections.controller";
import { createSectionSchema, locationSectionParamsSchema, updateSectionSchema } from "./sections.schema";

export const sectionsRouter = Router();

// Ownership of :id is checked in the service layer (the same 404-vs-403 idiom
// as locations PATCH/DELETE and the whole media module) -- "do you own this
// location" is the real boundary, not "do you hold the host role somewhere".

// Reads are optionalAuth and mirror GET /v1/locations/:id exactly: a published
// location's sections are public, a draft's are visible only to its owner and
// to admins.
sectionsRouter.get(
  "/locations/:id/sections",
  optionalAuth,
  validate({ params: locationIdOnlyParamSchema }),
  getSections
);

sectionsRouter.get(
  "/locations/:id/sections/:sectionId",
  optionalAuth,
  validate({ params: locationSectionParamsSchema }),
  getSectionDetail
);

// One section's gallery, position-ordered. The general gallery stays at
// GET /v1/locations/:id/media, which returns section_id IS NULL only.
sectionsRouter.get(
  "/locations/:id/sections/:sectionId/media",
  optionalAuth,
  validate({ params: locationSectionParamsSchema }),
  getSectionMedia
);

sectionsRouter.post(
  "/locations/:id/sections",
  requireAuth,
  validate({ params: locationIdOnlyParamSchema, body: createSectionSchema }),
  postSection
);

sectionsRouter.patch(
  "/locations/:id/sections/:sectionId",
  requireAuth,
  validate({ params: locationSectionParamsSchema, body: updateSectionSchema }),
  patchSection
);

// Refuses a section that still holds media (409). Deleting a section must never
// delete photos: that is the only path that also removes the R2 object.
sectionsRouter.delete(
  "/locations/:id/sections/:sectionId",
  requireAuth,
  validate({ params: locationSectionParamsSchema }),
  deleteSectionHandler
);
