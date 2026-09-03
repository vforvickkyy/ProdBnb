import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import { deleteMyRole, postMyRole } from "./roles.controller";
import { assignRoleBodySchema, roleParamSchema } from "./roles.schema";

export const rolesRouter = Router();

rolesRouter.post("/me/roles", requireAuth, validate({ body: assignRoleBodySchema }), postMyRole);
rolesRouter.delete("/me/roles/:role", requireAuth, validate({ params: roleParamSchema }), deleteMyRole);
