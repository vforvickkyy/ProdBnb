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
  // Phase 27-8. Only ONE messaging type, deliberately: the backend has no
  // event that distinguishes a reply from a first message, so the
  // `message_reply` key iOS already defines has no producer here and adding it
  // would be a promise the system does not keep.
  "new_message",
]);
export type NotificationType = z.infer<typeof notificationTypeSchema>;

/**
 * What a notification is *about*, and what the client deep-links to. Mirrors
 * the `notifications_entity_type_check` CHECK exactly (Phase 8 + Phase 27-8).
 *
 * Kept as its own schema rather than an inline union so that widening it is a
 * single edit in one place that the database constraint can be diffed against.
 */
export const notificationEntityTypeSchema = z.enum(["booking", "conversation"]);
export type NotificationEntityType = z.infer<typeof notificationEntityTypeSchema>;

export const notificationIdParamSchema = z.object({ id: uuid });
export type NotificationIdParam = z.infer<typeof notificationIdParamSchema>;

export const listNotificationsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  unread: z.coerce.boolean().optional(),
});
export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;

export const preferenceCategorySchema = z.enum(["booking", "payment", "message"]);
export type PreferenceCategory = z.infer<typeof preferenceCategorySchema>;

export const updatePreferencesSchema = z
  .object({
    booking: z.boolean().optional(),
    payment: z.boolean().optional(),
    // Phase 27-8. Defaults to enabled like the other two -- a missing row means
    // enabled (preferences.service.ts), so adding the category opted every
    // existing user in without a backfill.
    message: z.boolean().optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, { message: "Provide at least one preference to update." });
export type UpdatePreferencesInput = z.infer<typeof updatePreferencesSchema>;
