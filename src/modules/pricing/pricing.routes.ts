import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { optionalAuth } from "../../middleware/optionalAuth";
import { validate } from "../../middleware/validate";
import { deletePricingHandler, getPricing, patchPricing, postPricing } from "./pricing.controller";
import { createPricingSchema, locationIdParamSchema, pricingParamsSchema, updatePricingSchema } from "./pricing.schema";

export const pricingRouter = Router();

// Public if the location is published; owner/admin also see inactive rows —
// same visibility idiom as GET /v1/locations/:id.
pricingRouter.get("/locations/:id/pricing", optionalAuth, validate({ params: locationIdParamSchema }), getPricing);

pricingRouter.post(
  "/locations/:id/pricing",
  requireAuth,
  validate({ params: locationIdParamSchema, body: createPricingSchema }),
  postPricing
);

pricingRouter.patch(
  "/locations/:id/pricing/:pricingId",
  requireAuth,
  validate({ params: pricingParamsSchema, body: updatePricingSchema }),
  patchPricing
);

pricingRouter.delete(
  "/locations/:id/pricing/:pricingId",
  requireAuth,
  validate({ params: pricingParamsSchema }),
  deletePricingHandler
);
