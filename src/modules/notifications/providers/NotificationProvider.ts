// The provider-agnostic contract every push provider adapter implements.
// Mirrors src/modules/payments/providers/PaymentProvider.ts's shape
// deliberately -- Phase 7 already solved the identical "one internal
// concept, swappable external provider" problem.
//
// Adding a real Android (FCM) or Web Push provider later means: one new
// value in NotificationProviderName, one new adapter file implementing this
// same interface, one small additive migration extending the `provider`
// CHECK constraint on notification_delivery_attempts, and wiring it into
// providers/index.ts. Nothing in notification.service.ts, the routes, or
// the database's core shape changes.

export type NotificationProviderName = "disabled" | "apns";

export type DeliveryStatus = "sent" | "failed" | "invalid_token" | "skipped";

export interface SendPushInput {
  deviceToken: string;
  /** Only meaningful for apns; ignored by providers that don't need it. */
  environment: "sandbox" | "production" | null;
  title: string;
  body: string;
  /** Flattened string map -- becomes the top-level custom userInfo keys (e.g. prodbnb_type). */
  data: Record<string, string>;
  /**
   * Groups related notifications into one thread in the OS notification centre
   * -- the conversation id, for messaging (Phase 27-8). Without it, thirty
   * messages in one thread are thirty separate banners.
   *
   * Declared HERE rather than read out of `data.prodbnb_conversation_id` inside
   * the APNs adapter, so the concept stays provider-agnostic: this maps to
   * APNs `aps.thread-id` and to FCM's notification tag, and a provider that has
   * no such concept simply ignores it. Optional, so every existing caller --
   * every booking and payment notification -- is unchanged and emits no
   * grouping key at all.
   */
  threadId?: string | null;
}

export interface SendPushResult {
  status: DeliveryStatus;
  providerMessageId: string | null;
  /** Normalized category, never a raw provider error/stack trace. */
  errorReason: string | null;
}

export interface NotificationProvider {
  readonly name: NotificationProviderName;
  send(input: SendPushInput): Promise<SendPushResult>;
}
