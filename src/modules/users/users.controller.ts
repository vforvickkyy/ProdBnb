import { Request, Response } from "express";
import { ok } from "../../utils/respond";
import { listRoles } from "../roles/roles.service";
import { getProfile, listAllProfiles, updateProfile } from "./users.service";
import { ListUsersQuery, UpdateProfileInput } from "./users.schema";

export async function getMe(req: Request, res: Response): Promise<void> {
  const userId = req.user!.id;
  const supabase = req.supabase!;

  const [profile, roles] = await Promise.all([getProfile(supabase, userId), listRoles(supabase, userId)]);

  ok(res, { profile, roles });
}

export async function patchMe(req: Request, res: Response): Promise<void> {
  const userId = req.user!.id;
  const supabase = req.supabase!;
  const patch = req.valid!.body as UpdateProfileInput;

  const profile = await updateProfile(supabase, userId, patch);

  ok(res, { profile });
}

export async function listUsers(req: Request, res: Response): Promise<void> {
  const supabase = req.supabase!;
  const { page, pageSize } = req.valid!.query as ListUsersQuery;

  const { data, total } = await listAllProfiles(supabase, page, pageSize);

  ok(res, data, 200, { page, pageSize, total });
}
