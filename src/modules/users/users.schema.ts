import { z } from "zod";

/**
 * Deliberately permissive (Phase 26-MB). ProdBnb is used internationally, so
 * this validates *shape*, not country: digits with the punctuation people
 * actually type, optionally led by `+`. It rejects obvious nonsense (letters,
 * an empty string) without refusing a legitimate number from anywhere.
 *
 * Explicitly NOT reused from `payment.schema.ts`, whose `/^\d{10}$/` is
 * Cashfree's own India-only requirement for an order payload — applying that
 * to a user profile would lock out every non-Indian number.
 *
 * The only transformation is `.trim()`, which is this codebase's convention
 * for every free-text field. The number is otherwise stored exactly as typed:
 * no E.164 normalisation, no stripping of spaces or dashes, so what a user
 * reads back is what they entered.
 */
const profilePhoneSchema = z
  .string()
  .trim()
  .min(5, "Enter a valid phone number.")
  .max(32, "Enter a valid phone number.")
  // Allowed characters only. `+` is permitted at the start only (it is outside
  // the character class), which is where a country code prefix belongs.
  .regex(/^\+?[0-9\s().-]+$/, "Enter a valid phone number.")
  // ...and it must actually contain a number. The character check alone would
  // accept punctuation-only input such as "(((((", and a leading-digit regex
  // would wrongly reject the very common "(555) 123-4567".
  .refine((value) => (value.match(/\d/g) ?? []).length >= 5, "Enter a valid phone number.");

/**
 * One optional address part. `null` clears it; an empty string is rejected
 * rather than silently treated as a clear, so "I meant to erase this" and "my
 * form submitted a blank field" can't be confused for one another.
 */
const addressPart = (max: number) => z.string().trim().min(1).max(max).optional().nullable();

export const updateProfileSchema = z
  .object({
    first_name: z.string().trim().min(1).max(100).optional(),
    last_name: z.string().trim().min(1).max(100).optional(),
    avatar_url: z.string().url().optional().nullable(),
    // Phase 26-MB. Every field optional and nullable: omit to leave alone,
    // send null to clear. The object stays `.strict()`, so an unknown profile
    // field is still a 400 — adding these does not widen what is writable
    // beyond exactly these names.
    phone: profilePhoneSchema.optional().nullable(),
    address_line1: addressPart(200),
    address_line2: addressPart(200),
    address_city: addressPart(120),
    address_region: addressPart(120),
    address_country: addressPart(120),
    address_postal_code: addressPart(20),
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
