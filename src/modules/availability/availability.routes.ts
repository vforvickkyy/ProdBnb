import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { optionalAuth } from "../../middleware/optionalAuth";
import { validate } from "../../middleware/validate";
import {
  deleteBlockHandler,
  deleteOverrideHandler,
  deleteRuleHandler,
  getAvailabilityHandler,
  getBlocksHandler,
  getOverridesHandler,
  getRulesHandler,
  patchBlockHandler,
  patchOverrideHandler,
  patchRuleHandler,
  postBlockHandler,
  postOverrideHandler,
  postRuleHandler,
} from "./availability.controller";
import {
  availabilityQuerySchema,
  blockParamsSchema,
  createBlockSchema,
  createOverrideSchema,
  createRuleSchema,
  locationIdParamSchema,
  overrideParamsSchema,
  ruleParamsSchema,
  updateBlockSchema,
  updateOverrideSchema,
  updateRuleSchema,
} from "./availability.schema";

export const availabilityRouter = Router();

// Public computed availability: published is public, draft/etc. is
// owner/admin only — same visibility idiom as GET /v1/locations/:id.
availabilityRouter.get(
  "/locations/:id/availability",
  optionalAuth,
  validate({ params: locationIdParamSchema, query: availabilityQuerySchema }),
  getAvailabilityHandler
);

// --- weekly rules (owner/admin only — ownership checked in the service layer) ---

availabilityRouter.get(
  "/locations/:id/availability/rules",
  requireAuth,
  validate({ params: locationIdParamSchema }),
  getRulesHandler
);
availabilityRouter.post(
  "/locations/:id/availability/rules",
  requireAuth,
  validate({ params: locationIdParamSchema, body: createRuleSchema }),
  postRuleHandler
);
availabilityRouter.patch(
  "/locations/:id/availability/rules/:ruleId",
  requireAuth,
  validate({ params: ruleParamsSchema, body: updateRuleSchema }),
  patchRuleHandler
);
availabilityRouter.delete(
  "/locations/:id/availability/rules/:ruleId",
  requireAuth,
  validate({ params: ruleParamsSchema }),
  deleteRuleHandler
);

// --- date overrides ---

availabilityRouter.get(
  "/locations/:id/availability/overrides",
  requireAuth,
  validate({ params: locationIdParamSchema }),
  getOverridesHandler
);
availabilityRouter.post(
  "/locations/:id/availability/overrides",
  requireAuth,
  validate({ params: locationIdParamSchema, body: createOverrideSchema }),
  postOverrideHandler
);
availabilityRouter.patch(
  "/locations/:id/availability/overrides/:overrideId",
  requireAuth,
  validate({ params: overrideParamsSchema, body: updateOverrideSchema }),
  patchOverrideHandler
);
availabilityRouter.delete(
  "/locations/:id/availability/overrides/:overrideId",
  requireAuth,
  validate({ params: overrideParamsSchema }),
  deleteOverrideHandler
);

// --- blocked periods ---

availabilityRouter.get(
  "/locations/:id/blocks",
  requireAuth,
  validate({ params: locationIdParamSchema }),
  getBlocksHandler
);
availabilityRouter.post(
  "/locations/:id/blocks",
  requireAuth,
  validate({ params: locationIdParamSchema, body: createBlockSchema }),
  postBlockHandler
);
availabilityRouter.patch(
  "/locations/:id/blocks/:blockId",
  requireAuth,
  validate({ params: blockParamsSchema, body: updateBlockSchema }),
  patchBlockHandler
);
availabilityRouter.delete(
  "/locations/:id/blocks/:blockId",
  requireAuth,
  validate({ params: blockParamsSchema }),
  deleteBlockHandler
);
