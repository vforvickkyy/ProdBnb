import { z } from "zod";

const uuid = z.string().uuid();

export const adminUserIdParamSchema = z.object({ id: uuid });
export type AdminUserIdParam = z.infer<typeof adminUserIdParamSchema>;

export const suspendUserSchema = z
  .object({ reason: z.string().trim().min(1).max(500) })
  .strict();
export type SuspendUserInput = z.infer<typeof suspendUserSchema>;

// No fields required — restoring/approving is never required to justify
// itself the way a rejection/suspension is (Phase 11 plan §16).
export const noBodySchema = z.object({}).strict().default({});
export type NoBodyInput = z.infer<typeof noBodySchema>;

export const rejectLocationSchema = z
  .object({ reason: z.string().trim().min(1).max(1000) })
  .strict();
export type RejectLocationInput = z.infer<typeof rejectLocationSchema>;

export const suspendLocationSchema = z
  .object({ reason: z.string().trim().min(1).max(1000) })
  .strict();
export type SuspendLocationInput = z.infer<typeof suspendLocationSchema>;

export const adminListPaymentsQuerySchema = z.object({
  status: z.enum(["created", "pending", "success", "failed", "cancelled", "refunded", "partially_refunded"]).optional(),
  provider: z.enum(["cashfree"]).optional(),
  booking_id: uuid.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type AdminListPaymentsQuery = z.infer<typeof adminListPaymentsQuerySchema>;

export const adminListRefundsQuerySchema = z.object({
  status: z.enum(["pending", "success", "failed", "cancelled"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type AdminListRefundsQuery = z.infer<typeof adminListRefundsQuerySchema>;

export const deliveryAttemptsQuerySchema = z
  .object({
    notification_id: uuid.optional(),
    booking_id: uuid.optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .refine((d) => d.notification_id !== undefined || d.booking_id !== undefined, {
    message: "Provide notification_id or booking_id.",
  });
export type DeliveryAttemptsQuery = z.infer<typeof deliveryAttemptsQuerySchema>;

export const auditLogQuerySchema = z.object({
  target_type: z.enum(["location", "user", "booking", "payment"]).optional(),
  target_id: uuid.optional(),
  admin_id: uuid.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type AuditLogQuery = z.infer<typeof auditLogQuerySchema>;
