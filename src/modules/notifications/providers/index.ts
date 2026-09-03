import { env } from "../../../config/env";
import { APNsProvider } from "./APNsProvider";
import { DisabledProvider } from "./DisabledProvider";
import { NotificationProvider } from "./NotificationProvider";

let instance: NotificationProvider | undefined;

/**
 * Resolves the single active NotificationProvider from env.NOTIFICATION_PROVIDER.
 * notification.service.ts (and everything above it) only ever imports this
 * function, never a concrete provider class directly -- switching providers
 * is a config change here, not a code change anywhere else.
 */
export function getNotificationProvider(): NotificationProvider {
  if (!instance) {
    switch (env.NOTIFICATION_PROVIDER) {
      case "apns":
        instance = new APNsProvider();
        break;
      case "disabled":
        instance = new DisabledProvider();
        break;
      default:
        throw new Error(`Unknown NOTIFICATION_PROVIDER '${env.NOTIFICATION_PROVIDER as string}'.`);
    }
  }
  return instance;
}
