import { z } from "zod";

export const updateProfileSchema = z
  .object({
    first_name: z.string().trim().min(1).max(100).optional(),
    last_name: z.string().trim().min(1).max(100).optional(),
    avatar_url: z.string().url().optional().nullable(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: "Provide at least one field to update.",
  });

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

export const listUsersQuerySchema = z.object({
  // Admin-only in practice (GET /v1/admin/users is this schema's only
  // consumer) — matches by first/last name (profiles has no email column by
  // design, see docs/DATABASE.md; email lookups use the Supabase Admin Auth
  // API instead, see src/modules/admin/users.service.ts).
  search: z.string().trim().min(1).max(200).optional(),
  role: z.enum(["booker", "host", "admin"]).optional(),
  status: z.enum(["active", "suspended", "deleted"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;
