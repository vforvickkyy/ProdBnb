import { z } from "zod";

// Validation accepts all three roles (including 'admin') so that a
// self-service request for 'admin' fails with a deliberate 403 from the
// service layer, rather than a generic 400 that would look like a typo.
export const marketplaceRoleSchema = z.enum(["booker", "host", "admin"]);

export const assignRoleBodySchema = z
  .object({
    role: marketplaceRoleSchema,
  })
  .strict();

export const roleParamSchema = z.object({
  role: marketplaceRoleSchema,
});

export type AssignRoleInput = z.infer<typeof assignRoleBodySchema>;
export type RoleParam = z.infer<typeof roleParamSchema>;
