import { z } from "zod";

const uuid = z.string().uuid();

export const notificationTypeSchema = z.enum([
  "booking_request_received",
  "booking_confirmed",
  "booking_declined",
  "booking_cancelled",
  "payment_success",
  "payment_failed",
  "refund_processed",
]);
export type NotificationType = z.infer<typeof notificationTypeSchema>;

export const notificationIdParamSchema = z.object({ id: uuid });
export type NotificationIdParam = z.infer<typeof notificationIdParamSchema>;

export const listNotificationsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  unread: z.coerce.boolean().optional(),
});
export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;

export const preferenceCategorySchema = z.enum(["booking", "payment"]);
export type PreferenceCategory = z.infer<typeof preferenceCategorySchema>;

export const updatePreferencesSchema = z
  .object({
    booking: z.boolean().optional(),
    payment: z.boolean().optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, { message: "Provide at least one preference to update." });
export type UpdatePreferencesInput = z.infer<typeof updatePreferencesSchema>;
