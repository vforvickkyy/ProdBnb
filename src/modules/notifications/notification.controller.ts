import { Request, Response } from "express";
import { ok } from "../../utils/respond";
import { ListNotificationsQuery, NotificationIdParam, UpdatePreferencesInput } from "./notification.schema";
import { getNotification, listNotifications, markAllNotificationsRead, markNotificationRead } from "./notification.service";
import { getPreferences, updatePreferences } from "./preferences.service";

export async function getNotifications(req: Request, res: Response): Promise<void> {
  const query = req.valid!.query as ListNotificationsQuery;
  const { data, total } = await listNotifications(req.supabase!, query);
  ok(res, data, 200, { page: query.page, pageSize: query.pageSize, total });
}

export async function getNotificationDetail(req: Request, res: Response): Promise<void> {
  const { id } = req.valid!.params as NotificationIdParam;
  const notification = await getNotification(req.supabase!, id);
  ok(res, notification);
}

export async function postMarkRead(req: Request, res: Response): Promise<void> {
  const { id } = req.valid!.params as NotificationIdParam;
  const notification = await markNotificationRead(req.supabase!, id);
  ok(res, notification);
}

export async function postMarkAllRead(req: Request, res: Response): Promise<void> {
  const count = await markAllNotificationsRead(req.supabase!, req.user!.id);
  ok(res, { marked_read: count });
}

export async function getNotificationPreferences(req: Request, res: Response): Promise<void> {
  const preferences = await getPreferences(req.supabase!, req.user!.id);
  ok(res, preferences);
}

export async function patchNotificationPreferences(req: Request, res: Response): Promise<void> {
  const input = req.valid!.body as UpdatePreferencesInput;
  const preferences = await updatePreferences(req.supabase!, req.user!.id, input);
  ok(res, preferences);
}
