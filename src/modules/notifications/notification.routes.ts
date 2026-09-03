import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import {
  getNotificationDetail,
  getNotificationPreferences,
  getNotifications,
  patchNotificationPreferences,
  postMarkAllRead,
  postMarkRead,
} from "./notification.controller";
import { listNotificationsQuerySchema, notificationIdParamSchema, updatePreferencesSchema } from "./notification.schema";

export const notificationsRouter = Router();

notificationsRouter.get("/notifications", requireAuth, validate({ query: listNotificationsQuerySchema }), getNotifications);

notificationsRouter.get(
  "/notifications/:id",
  requireAuth,
  validate({ params: notificationIdParamSchema }),
  getNotificationDetail
);

notificationsRouter.post(
  "/notifications/:id/read",
  requireAuth,
  validate({ params: notificationIdParamSchema }),
  postMarkRead
);

notificationsRouter.post("/notifications/read-all", requireAuth, postMarkAllRead);

notificationsRouter.get("/notification-preferences", requireAuth, getNotificationPreferences);

notificationsRouter.patch(
  "/notification-preferences",
  requireAuth,
  validate({ body: updatePreferencesSchema }),
  patchNotificationPreferences
);
