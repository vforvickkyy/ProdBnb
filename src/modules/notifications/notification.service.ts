import { SupabaseClient } from "@supabase/supabase-js";
import { NotFoundError } from "../../errors/AppError";
import { adminClient } from "../../lib/supabase";
import {
  ListNotificationsQuery,
  NotificationEntityType,
  NotificationType,
  PreferenceCategory,
} from "./notification.schema";
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
  new_message: "message",
};

interface NotifyParams {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  /**
   * What this notification is about, and what the client deep-links to.
   *
   * Phase 27-8 replaced a required `bookingId` with this pair. Phase 8 could
   * assume every notification was about a booking; a message notification is
   * about a conversation, and hardcoding the entity meant every future
   * notification type would need its own migration and its own special case.
   */
  entityType: NotificationEntityType;
  entityId: string;
  data?: Record<string, unknown>;
  /**
   * Idempotency key, unique per (user_id, source_event_id).
   *
   * The convention is `<trigger>:<trigger id>:<type>` -- the id of the thing
   * that CAUSED the event, which is not always `entityId`. notifyPaymentSuccess
   * has always used `payment:<payment_id>:...` while its entity is the booking,
   * and notifyNewMessage uses `message:<message_id>:...` while its entity is
   * the conversation. Keying a message notification on the conversation instead
   * would collapse every message in a thread into ONE notification, forever.
   */
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
      entity_type: params.entityType,
      entity_id: params.entityId,
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
  const data = pushDataFor(notification);
  // Messaging groups by conversation so a busy thread is one notification-centre
  // entry rather than thirty banners. Null for every other type, which keeps
  // their `aps` object byte-identical to Phase 8.
  const threadId = notification.entity_type === "conversation" ? notification.entity_id : null;

  for (const device of devices) {
    // ONE TRY PER DEVICE, deliberately.
    //
    // Before Phase 27-8 this loop body was unguarded, so a failed
    // delivery-attempt INSERT threw, unwound all the way out to safeNotify(),
    // and every device LATER IN THE LIST silently received nothing. Nothing
    // user-visible broke -- which is exactly what made it hard to notice. One
    // device's bookkeeping failure must never suppress another device's push,
    // and messaging is what makes multi-device fan-out routine rather than rare.
    try {
      const result = await provider.send({
        deviceToken: device.device_token,
        environment: (device.environment as "sandbox" | "production" | null) ?? null,
        title: notification.title,
        body: notification.body,
        data,
        threadId,
      });

      // Logging is best-effort: losing the audit row is strictly better than
      // losing the delivery, and provider.send() has already happened by here.
      const { error: attemptError } = await adminClient.from("notification_delivery_attempts").insert({
        notification_id: notification.id,
        device_id: device.id,
        provider: provider.name,
        status: result.status,
        provider_message_id: result.providerMessageId,
        error_reason: result.errorReason,
      });
      if (attemptError) {
        console.error(`Failed to log delivery attempt (device=${device.id}):`, attemptError);
      }

      if (result.status === "invalid_token") {
        const { error: deactivateError } = await adminClient
          .from("user_devices")
          .update({ is_active: false })
          .eq("id", device.id);
        if (deactivateError) {
          console.error(`Failed to deactivate invalid device (device=${device.id}):`, deactivateError);
        }
      }
    } catch (err) {
      console.error(`Push delivery failed for device ${device.id}:`, err);
    }
  }
}

/**
 * The flattened custom keys that ride alongside `aps` and become the iOS
 * `userInfo` bag. The shape is fixed by the client: Phase 26-K's
 * `NotificationPayload` reads these exact `prodbnb_*` names, and
 * `NotificationRouter` deep-links on them.
 *
 * The entity-specific id is emitted under BOTH `prodbnb_entity_id` and a
 * type-specific alias, because the router reads the alias
 * (`payload.bookingID` / `payload.conversationID`) rather than the generic one.
 *
 * `notification.data` is deliberately NOT spread in wholesale. It holds
 * internal values under non-prefixed keys (`payment_id`), none of which the
 * client reads, and merging it would silently change the payload of every
 * booking and payment push that has already shipped. Only `message_id` is
 * lifted out, and only for a conversation.
 */
function pushDataFor(notification: NotificationDetail): Record<string, string> {
  const data: Record<string, string> = {
    prodbnb_type: notification.type,
    prodbnb_entity_type: notification.entity_type,
    prodbnb_entity_id: notification.entity_id,
  };

  if (notification.entity_type === "conversation") {
    data.prodbnb_conversation_id = notification.entity_id;
    const messageId = notification.data?.message_id;
    if (typeof messageId === "string") {
      data.prodbnb_message_id = messageId;
    }
  } else {
    data.prodbnb_booking_id = notification.entity_id;
  }

  return data;
}

/** Wraps `notify()` so a notification failure can never fail its caller. */
async function safeNotify(params: NotifyParams): Promise<void> {
  try {
    await notify(params);
  } catch (err) {
    console.error(
      `Failed to create/deliver notification (type=${params.type}, ${params.entityType}=${params.entityId}):`,
      err
    );
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
    entityType: "booking",
    entityId: bookingId,
    sourceEventId: `booking:${bookingId}:booking_request_received`,
  });
}

export function notifyBookingConfirmed(bookerId: string, bookingId: string): Promise<void> {
  return safeNotify({
    userId: bookerId,
    type: "booking_confirmed",
    title: "Booking confirmed",
    body: "Your booking has been confirmed.",
    entityType: "booking",
    entityId: bookingId,
    sourceEventId: `booking:${bookingId}:booking_confirmed`,
  });
}

export function notifyBookingDeclined(bookerId: string, bookingId: string): Promise<void> {
  return safeNotify({
    userId: bookerId,
    type: "booking_declined",
    title: "Booking declined",
    body: "Your booking request was declined.",
    entityType: "booking",
    entityId: bookingId,
    sourceEventId: `booking:${bookingId}:booking_declined`,
  });
}

export function notifyBookingCancelled(recipientId: string, bookingId: string): Promise<void> {
  return safeNotify({
    userId: recipientId,
    type: "booking_cancelled",
    title: "Booking cancelled",
    body: "A booking has been cancelled.",
    entityType: "booking",
    entityId: bookingId,
    sourceEventId: `booking:${bookingId}:booking_cancelled`,
  });
}

export function notifyPaymentSuccess(bookerId: string, bookingId: string, paymentId: string): Promise<void> {
  return safeNotify({
    userId: bookerId,
    type: "payment_success",
    title: "Payment successful",
    body: "Your payment was successful.",
    entityType: "booking",
    entityId: bookingId,
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
    entityType: "booking",
    entityId: bookingId,
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
    entityType: "booking",
    entityId: bookingId,
    data: { payment_id: paymentId },
    sourceEventId: `payment:${paymentId}:refund_processed`,
  });
}

// ---------------------------------------------------------------------------
// Messaging (Phase 27-8)
// ---------------------------------------------------------------------------

/**
 * Notifies the OTHER participant that a message was sent.
 *
 * Called from sendMessage() after the message row has already committed. Like
 * every notifyX() above it goes through safeNotify(), so the durable message
 * stands whether or not anyone was ever told about it -- Realtime (Phase 27-6)
 * and the history endpoint both remain able to deliver it.
 *
 * RECIPIENT RESOLUTION is structural rather than a filter: the recipient is
 * computed as "the participant who is not the sender", so a sender cannot be
 * notified of their own message by any code path. `conversations` does not
 * store the host -- it is derived through `locations.host_id`, which has had no
 * `authenticated` grant since Phase 12 -- so this reads through adminClient.
 * That is also necessary rather than convenient: the recipient's profile is
 * frequently unreadable by the sender (Phase 27-3 established that a host
 * cannot read a booker's profile at all).
 *
 * PRIVACY (decision N-1): this function never receives the message text. It
 * takes a message id, and the push carries the sender's NAME and nothing else.
 * A push is rendered on a locked screen and mirrored to paired devices, and
 * ProdBnb messages carry rates, addresses, schedules and client names -- so the
 * body is a fixed string, matching the deliberately generic copy Phase 8 chose
 * for bookings and payments. The client opens the thread and reads the real
 * message from the authoritative API.
 */
export async function notifyNewMessage(senderId: string, conversationId: string, messageId: string): Promise<void> {
  try {
    const { data: conversation, error } = await adminClient
      .from("conversations")
      .select("booker_id, locations!inner(host_id)")
      .eq("id", conversationId)
      .maybeSingle();
    if (error) {
      throw error;
    }
    if (!conversation) {
      return; // conversation vanished between insert and notify -- nothing to do
    }

    const bookerId = conversation.booker_id as string;
    const hostId = (conversation.locations as unknown as { host_id: string } | null)?.host_id;
    if (!hostId) {
      return;
    }

    const recipientId = senderId === bookerId ? hostId : bookerId;
    // A self-conversation is refused at creation (Phase 27-3), but never notify
    // someone about their own message even if an older row exists.
    if (recipientId === senderId) {
      return;
    }

    await safeNotify({
      userId: recipientId,
      type: "new_message",
      title: await senderDisplayName(senderId),
      body: "Sent you a message.",
      entityType: "conversation",
      entityId: conversationId,
      data: { message_id: messageId },
      // Keyed on the MESSAGE, not the conversation -- see NotifyParams. This
      // also composes with Phase 27-4's send idempotency: a retried POST
      // returns the same message id, so it yields the same key.
      sourceEventId: `message:${messageId}:new_message`,
    });
  } catch (err) {
    // Mirrors safeNotify(): resolving the recipient must be as incapable of
    // failing a message send as delivering to them is.
    console.error(`Failed to notify new message (conversation=${conversationId}, message=${messageId}):`, err);
  }
}

/**
 * The push title: who it is from. Falls back through the parts of the name that
 * exist -- `profiles.first_name` and `last_name` are both nullable -- and then
 * to a generic string, so a profile with no name at all still produces a
 * sensible notification rather than an empty title.
 */
async function senderDisplayName(senderId: string): Promise<string> {
  const { data } = await adminClient.from("profiles").select("first_name, last_name").eq("id", senderId).maybeSingle();

  const first = (data?.first_name as string | null)?.trim();
  const last = (data?.last_name as string | null)?.trim();

  if (first && last) return `${first} ${last}`;
  if (first) return first;
  if (last) return last;
  return "New message";
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
