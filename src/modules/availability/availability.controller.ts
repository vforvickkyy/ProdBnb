import { Request, Response } from "express";
import { callerHasRole } from "../../middleware/requireRole";
import { created, ok } from "../../utils/respond";
import { getAvailability } from "./availability.service";
import {
  AvailabilityQuery,
  BlockParams,
  CreateBlockInput,
  CreateOverrideInput,
  CreateRuleInput,
  LocationIdParam,
  OverrideParams,
  RuleParams,
  UpdateBlockInput,
  UpdateOverrideInput,
  UpdateRuleInput,
} from "./availability.schema";
import { createBlock, deleteBlock, listBlocks, updateBlock } from "./blocks.service";
import { createOverride, deleteOverride, listOverrides, updateOverride } from "./overrides.service";
import { createRule, deleteRule, listRules, updateRule } from "./rules.service";

async function isCallerAdmin(req: Request): Promise<boolean> {
  return callerHasRole(req.supabase!, req.user!.id, "admin");
}

// --- public computed availability ---

export async function getAvailabilityHandler(req: Request, res: Response): Promise<void> {
  const { id } = req.valid!.params as LocationIdParam;
  const query = req.valid!.query as AvailabilityQuery;
  const { days, timezone } = await getAvailability(req.supabase!, id, query);
  ok(res, days, 200, { from: query.from, to: query.to, timezone });
}

// --- rules ---

export async function getRulesHandler(req: Request, res: Response): Promise<void> {
  const { id } = req.valid!.params as LocationIdParam;
  const isAdmin = await isCallerAdmin(req);
  const rules = await listRules(req.supabase!, req.user!.id, isAdmin, id);
  ok(res, rules);
}

export async function postRuleHandler(req: Request, res: Response): Promise<void> {
  const { id } = req.valid!.params as LocationIdParam;
  const input = req.valid!.body as CreateRuleInput;
  const isAdmin = await isCallerAdmin(req);
  const rule = await createRule(req.supabase!, req.user!.id, isAdmin, id, input);
  created(res, rule);
}

export async function patchRuleHandler(req: Request, res: Response): Promise<void> {
  const { id, ruleId } = req.valid!.params as RuleParams;
  const input = req.valid!.body as UpdateRuleInput;
  const isAdmin = await isCallerAdmin(req);
  const rule = await updateRule(req.supabase!, req.user!.id, isAdmin, id, ruleId, input);
  ok(res, rule);
}

export async function deleteRuleHandler(req: Request, res: Response): Promise<void> {
  const { id, ruleId } = req.valid!.params as RuleParams;
  const isAdmin = await isCallerAdmin(req);
  await deleteRule(req.supabase!, req.user!.id, isAdmin, id, ruleId);
  ok(res, { id: ruleId, deleted: true });
}

// --- overrides ---

export async function getOverridesHandler(req: Request, res: Response): Promise<void> {
  const { id } = req.valid!.params as LocationIdParam;
  const isAdmin = await isCallerAdmin(req);
  const overrides = await listOverrides(req.supabase!, req.user!.id, isAdmin, id);
  ok(res, overrides);
}

export async function postOverrideHandler(req: Request, res: Response): Promise<void> {
  const { id } = req.valid!.params as LocationIdParam;
  const input = req.valid!.body as CreateOverrideInput;
  const isAdmin = await isCallerAdmin(req);
  const override = await createOverride(req.supabase!, req.user!.id, isAdmin, id, input);
  created(res, override);
}

export async function patchOverrideHandler(req: Request, res: Response): Promise<void> {
  const { id, overrideId } = req.valid!.params as OverrideParams;
  const input = req.valid!.body as UpdateOverrideInput;
  const isAdmin = await isCallerAdmin(req);
  const override = await updateOverride(req.supabase!, req.user!.id, isAdmin, id, overrideId, input);
  ok(res, override);
}

export async function deleteOverrideHandler(req: Request, res: Response): Promise<void> {
  const { id, overrideId } = req.valid!.params as OverrideParams;
  const isAdmin = await isCallerAdmin(req);
  await deleteOverride(req.supabase!, req.user!.id, isAdmin, id, overrideId);
  ok(res, { id: overrideId, deleted: true });
}

// --- blocks ---

export async function getBlocksHandler(req: Request, res: Response): Promise<void> {
  const { id } = req.valid!.params as LocationIdParam;
  const isAdmin = await isCallerAdmin(req);
  const blocks = await listBlocks(req.supabase!, req.user!.id, isAdmin, id);
  ok(res, blocks);
}

export async function postBlockHandler(req: Request, res: Response): Promise<void> {
  const { id } = req.valid!.params as LocationIdParam;
  const input = req.valid!.body as CreateBlockInput;
  const isAdmin = await isCallerAdmin(req);
  const block = await createBlock(req.supabase!, req.user!.id, isAdmin, id, input);
  created(res, block);
}

export async function patchBlockHandler(req: Request, res: Response): Promise<void> {
  const { id, blockId } = req.valid!.params as BlockParams;
  const input = req.valid!.body as UpdateBlockInput;
  const isAdmin = await isCallerAdmin(req);
  const block = await updateBlock(req.supabase!, req.user!.id, isAdmin, id, blockId, input);
  ok(res, block);
}

export async function deleteBlockHandler(req: Request, res: Response): Promise<void> {
  const { id, blockId } = req.valid!.params as BlockParams;
  const isAdmin = await isCallerAdmin(req);
  await deleteBlock(req.supabase!, req.user!.id, isAdmin, id, blockId);
  ok(res, { id: blockId, deleted: true });
}
