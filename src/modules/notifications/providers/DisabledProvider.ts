import { NotificationProvider, SendPushInput, SendPushResult } from "./NotificationProvider";

/**
 * The default provider (NOTIFICATION_PROVIDER=disabled) -- used whenever no
 * Apple Developer credentials are configured. Every send is recorded as an
 * explicit, honest `skipped` outcome, never silently reported as `sent`
 * (Phase 8 plan §10: never pretend a push was delivered). This is what
 * keeps the entire notification system -- creation, idempotency, multi-
 * device fan-out, preferences -- fully testable with zero Apple credentials.
 */
export class DisabledProvider implements NotificationProvider {
  readonly name = "disabled" as const;

  async send(_input: SendPushInput): Promise<SendPushResult> {
    return { status: "skipped", providerMessageId: null, errorReason: "No notification provider configured." };
  }
}
