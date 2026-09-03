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
