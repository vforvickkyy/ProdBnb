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

const dateTimeFilter = z.string().datetime({ offset: true });

export const adminListPaymentsQuerySchema = z
  .object({
    status: z.enum(["created", "pending", "success", "failed", "cancelled", "refunded", "partially_refunded"]).optional(),
    provider: z.enum(["cashfree"]).optional(),
    booking_id: uuid.optional(),
    // Filters on the payment's own created_at (Phase 14) -- unlike bookings,
    // a payment has no separate "when does this happen" date, so created_at
    // is the natural and only reasonable filter here.
    created_after: dateTimeFilter.optional(),
    created_before: dateTimeFilter.optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .refine((d) => !d.created_after || !d.created_before || d.created_before >= d.created_after, {
    message: "created_before must not be earlier than created_after.",
    path: ["created_before"],
  });
export type AdminListPaymentsQuery = z.infer<typeof adminListPaymentsQuerySchema>;

export const adminListRefundsQuerySchema = z.object({
  status: z.enum(["pending", "success", "failed", "cancelled"]).optional(),
  // Lets an admin jump straight to "every refund for this payment" instead
  // of paging through an unfiltered list client-side (Phase 14).
  payment_id: uuid.optional(),
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

// Mirrors audit.service.ts's AuditAction union exactly (not imported from
// there -- audit.service.ts already imports AuditLogQuery from this file,
// and importing the type back would create a circular dependency; the two
// lists are small and only change together, at the same migration that
// extends admin_audit_log's own CHECK constraint).
export const auditActionSchema = z.enum([
  "ADMIN_APPROVED_LOCATION",
  "ADMIN_REJECTED_LOCATION",
  "ADMIN_SUSPENDED_LOCATION",
  "ADMIN_RESTORED_LOCATION",
  "ADMIN_UPDATED_LOCATION_STATUS",
  "ADMIN_SUSPENDED_USER",
  "ADMIN_RESTORED_USER",
  "ADMIN_CANCELLED_BOOKING",
  "ADMIN_CREATED_REFUND",
]);

export const auditLogQuerySchema = z
  .object({
    target_type: z.enum(["location", "user", "booking", "payment"]).optional(),
    target_id: uuid.optional(),
    admin_id: uuid.optional(),
    // Phase 14: finding "every rejection this week" required pulling every
    // page and filtering client-side without these.
    action: auditActionSchema.optional(),
    created_after: dateTimeFilter.optional(),
    created_before: dateTimeFilter.optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .refine((d) => !d.created_after || !d.created_before || d.created_before >= d.created_after, {
    message: "created_before must not be earlier than created_after.",
    path: ["created_before"],
  });
export type AuditLogQuery = z.infer<typeof auditLogQuerySchema>;
