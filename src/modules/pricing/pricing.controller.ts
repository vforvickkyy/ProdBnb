import { Request, Response } from "express";
import { callerHasRole } from "../../middleware/requireRole";
import { created, ok } from "../../utils/respond";
import { createPricing, deletePricing, listPricing, updatePricing } from "./pricing.service";
import { CreatePricingInput, LocationIdParam, PricingParams, UpdatePricingInput } from "./pricing.schema";

async function isCallerAdmin(req: Request): Promise<boolean> {
  if (!req.user) {
    return false;
  }
  return callerHasRole(req.supabase!, req.user.id, "admin");
}

export async function getPricing(req: Request, res: Response): Promise<void> {
  const { id } = req.valid!.params as LocationIdParam;
  const pricing = await listPricing(req.supabase!, req.user?.id, id);
  ok(res, pricing);
}

export async function postPricing(req: Request, res: Response): Promise<void> {
  const { id } = req.valid!.params as LocationIdParam;
  const input = req.valid!.body as CreatePricingInput;
  const isAdmin = await isCallerAdmin(req);
  const pricing = await createPricing(req.supabase!, req.user!.id, isAdmin, id, input);
  created(res, pricing);
}

export async function patchPricing(req: Request, res: Response): Promise<void> {
  const { id, pricingId } = req.valid!.params as PricingParams;
  const input = req.valid!.body as UpdatePricingInput;
  const isAdmin = await isCallerAdmin(req);
  const pricing = await updatePricing(req.supabase!, req.user!.id, isAdmin, id, pricingId, input);
  ok(res, pricing);
}

export async function deletePricingHandler(req: Request, res: Response): Promise<void> {
  const { id, pricingId } = req.valid!.params as PricingParams;
  const isAdmin = await isCallerAdmin(req);
  await deletePricing(req.supabase!, req.user!.id, isAdmin, id, pricingId);
  ok(res, { id: pricingId, deleted: true });
}
