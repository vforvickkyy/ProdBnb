import { SupabaseClient } from "@supabase/supabase-js";
import { NotFoundError } from "../../errors/AppError";
import { adminClient } from "../../lib/supabase";
import { ListNotificationsQuery, NotificationType, PreferenceCategory } from "./notification.schema";
import { isPushEnabled } from "./preferences.service";
import { getNotificationProvider } from "./providers";

const UNIQUE_VIOLATION = "23505";

const NOTIFICATION_COLUMNS = `
  id, user_id, type, title, body, entity_type, entity_id, data,
  read_at, created_at, updated_at
`;

export interface NotificationDetail {
  id: string;
  user_id: string;
  type: string;
  title: string;
  body: string;
  entity_type: string;
  entity_id: string;
  data: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
  updated_at: string;
}

// Which preference category gates push delivery for each type -- never
// consulted for whether to CREATE the in-app record, only whether to
// attempt a push (Phase 8 plan §5/§9).
const TYPE_CATEGORY: Record<NotificationType, PreferenceCategory> = {
  booking_request_received: "booking",
  booking_confirmed: "booking",
  booking_declined: "booking",
  booking_cancelled: "booking",
  payment_success: "payment",
  payment_failed: "payment",
  refund_processed: "payment",
};

interface NotifyParams {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  bookingId: string;
  data?: Record<string, unknown>;
  sourceEventId: string;
}

/**
 * The single place a notification is created and delivery is fanned out to
 * every active device. Idempotent via (user_id, source_event_id): a
 * duplicate call for the same logical event is a safe no-op -- no second
 * notification row, no second round of delivery attempts. Never throws --
 * every notifyX() wrapper below guarantees this, so a bug or a transient
 * failure here can never fail the booking/payment operation that triggered
 * it (Phase 8 plan §15).
 */
async function notify(params: NotifyParams): Promise<void> {
  const { data, error } = await adminClient
    .from("notifications")
    .insert({
      user_id: params.userId,
      type: params.type,
      title: params.title,
      body: params.body,
      entity_type: "booking",
      entity_id: params.bookingId,
      data: params.data ?? {},
      source_event_id: params.sourceEventId,
    })
    .select(NOTIFICATION_COLUMNS)
    .single();

  if (error) {
    if (error.code === UNIQUE_VIOLATION) {
      return; // already notified for this exact event -- no new delivery attempts either
    }
    throw error;
  }

  await deliverPush(data as NotificationDetail);
}

async function deliverPush(notification: NotificationDetail): Promise<void> {
  const category = TYPE_CATEGORY[notification.type as NotificationType];
  const pushEnabled = await isPushEnabled(notification.user_id, category);
  if (!pushEnabled) {
    return; // suppresses the push attempt only -- the notification row above already exists
  }

  const { data: devices, error } = await adminClient
    .from("user_devices")
    .select("id, device_token, environment")
    .eq("user_id", notification.user_id)
    .eq("is_active", true);
  if (error) {
    throw error;
  }
  if (!devices || devices.length === 0) {
    return;
  }

  const provider = getNotificationProvider();

  for (const device of devices) {
    const result = await provider.send({
      deviceToken: device.device_token,
      environment: (device.environment as "sandbox" | "production" | null) ?? null,
      title: notification.title,
      body: notification.body,
      data: {
        prodbnb_type: notification.type,
        prodbnb_entity_type: notification.entity_type,
        prodbnb_entity_id: notification.entity_id,
        prodbnb_booking_id: notification.entity_id, // entity is always the booking this phase
      },
    });

    const { error: attemptError } = await adminClient.from("notification_delivery_attempts").insert({
      notification_id: notification.id,
      device_id: device.id,
      provider: provider.name,
      status: result.status,
      provider_message_id: result.providerMessageId,
      error_reason: result.errorReason,
    });
    if (attemptError) {
      throw attemptError;
    }

    if (result.status === "invalid_token") {
      await adminClient.from("user_devices").update({ is_active: false }).eq("id", device.id);
    }
  }
}

/** Wraps `notify()` so a notification failure can never fail its caller. */
async function safeNotify(params: NotifyParams): Promise<void> {
  try {
    await notify(params);
  } catch (err) {
    console.error(`Failed to create/deliver notification (type=${params.type}, booking=${params.bookingId}):`, err);
  }
}

// ---------------------------------------------------------------------------
// Per-event helpers -- called from bookings.service.ts / payment.service.ts
// at the exact point each transition already commits. Deliberately generic
// copy: no location name, amount, or other booking/payment detail is put
// into the title/body (Phase 8 plan §11 — don't put private data into a
// push unnecessarily; the client looks up full details via bookingId).
// ---------------------------------------------------------------------------

export function notifyBookingRequestReceived(hostId: string, bookingId: string): Promise<void> {
  return safeNotify({
    userId: hostId,
    type: "booking_request_received",
    title: "New booking request",
    body: "You have a new booking request.",
    bookingId,
    sourceEventId: `booking:${bookingId}:booking_request_received`,
  });
}

export function notifyBookingConfirmed(bookerId: string, bookingId: string): Promise<void> {
  return safeNotify({
    userId: bookerId,
    type: "booking_confirmed",
    title: "Booking confirmed",
    body: "Your booking has been confirmed.",
    bookingId,
    sourceEventId: `booking:${bookingId}:booking_confirmed`,
  });
}

export function notifyBookingDeclined(bookerId: string, bookingId: string): Promise<void> {
  return safeNotify({
    userId: bookerId,
    type: "booking_declined",
    title: "Booking declined",
    body: "Your booking request was declined.",
    bookingId,
    sourceEventId: `booking:${bookingId}:booking_declined`,
  });
}

export function notifyBookingCancelled(recipientId: string, bookingId: string): Promise<void> {
  return safeNotify({
    userId: recipientId,
    type: "booking_cancelled",
    title: "Booking cancelled",
    body: "A booking has been cancelled.",
    bookingId,
    sourceEventId: `booking:${bookingId}:booking_cancelled`,
  });
}

export function notifyPaymentSuccess(bookerId: string, bookingId: string, paymentId: string): Promise<void> {
  return safeNotify({
    userId: bookerId,
    type: "payment_success",
    title: "Payment successful",
    body: "Your payment was successful.",
    bookingId,
    data: { payment_id: paymentId },
    sourceEventId: `payment:${paymentId}:payment_success`,
  });
}

export function notifyPaymentFailed(bookerId: string, bookingId: string, paymentId: string): Promise<void> {
  return safeNotify({
    userId: bookerId,
    type: "payment_failed",
    title: "Payment failed",
    body: "Your payment could not be completed.",
    bookingId,
    data: { payment_id: paymentId },
    sourceEventId: `payment:${paymentId}:payment_failed`,
  });
}

export function notifyRefundProcessed(bookerId: string, bookingId: string, paymentId: string): Promise<void> {
  return safeNotify({
    userId: bookerId,
    type: "refund_processed",
    title: "Refund processed",
    body: "Your refund has been processed.",
    bookingId,
    data: { payment_id: paymentId },
    sourceEventId: `payment:${paymentId}:refund_processed`,
  });
}

// ---------------------------------------------------------------------------
// Read-side: in-app notification list / read state.
// ---------------------------------------------------------------------------

export interface PaginatedNotifications {
  data: NotificationDetail[];
  total: number;
}

export async function listNotifications(supabase: SupabaseClient, query: ListNotificationsQuery): Promise<PaginatedNotifications> {
  const from = (query.page - 1) * query.pageSize;
  const to = from + query.pageSize - 1;

  let request = supabase.from("notifications").select(NOTIFICATION_COLUMNS, { count: "exact" });
  if (query.unread === true) {
    request = request.is("read_at", null);
  }

  const { data, error, count } = await request.order("created_at", { ascending: false }).range(from, to);
  if (error) {
    throw error;
  }

  return { data: (data ?? []) as NotificationDetail[], total: count ?? 0 };
}

export async function getNotification(supabase: SupabaseClient, id: string): Promise<NotificationDetail> {
  const { data, error } = await supabase.from("notifications").select(NOTIFICATION_COLUMNS).eq("id", id).maybeSingle();
  if (error) {
    throw error;
  }
  if (!data) {
    throw new NotFoundError("Notification not found.");
  }
  return data as NotificationDetail;
}

export async function markNotificationRead(supabase: SupabaseClient, id: string): Promise<NotificationDetail> {
  const current = await getNotification(supabase, id);
  if (current.read_at) {
    return current; // idempotent -- already read
  }

  const { data, error } = await supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("id", id)
    .select(NOTIFICATION_COLUMNS)
    .single();
  if (error || !data) {
    throw error ?? new Error("Failed to mark notification read.");
  }
  return data as NotificationDetail;
}

export async function markAllNotificationsRead(supabase: SupabaseClient, userId: string): Promise<number> {
  const { data, error } = await supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("user_id", userId)
    .is("read_at", null)
    .select("id");
  if (error) {
    throw error;
  }
  return (data ?? []).length;
}
