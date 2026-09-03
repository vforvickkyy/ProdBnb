import { Request, Response } from "express";
import { created, ok } from "../../utils/respond";
import { assignRole, removeRole } from "./roles.service";
import { AssignRoleInput, RoleParam } from "./roles.schema";

export async function postMyRole(req: Request, res: Response): Promise<void> {
  const userId = req.user!.id;
  const supabase = req.supabase!;
  const { role } = req.valid!.body as AssignRoleInput;

  const roles = await assignRole(supabase, userId, role);

  created(res, { roles });
}

export async function deleteMyRole(req: Request, res: Response): Promise<void> {
  const userId = req.user!.id;
  const supabase = req.supabase!;
  const { role } = req.valid!.params as RoleParam;

  const roles = await removeRole(supabase, userId, role);

  ok(res, { roles });
}
