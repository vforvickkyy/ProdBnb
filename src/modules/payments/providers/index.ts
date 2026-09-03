import { env } from "../../../config/env";
import { CashfreeProvider } from "./CashfreeProvider";
import { PaymentProvider } from "./PaymentProvider";

let instance: PaymentProvider | undefined;

/**
 * Resolves the single active PaymentProvider from env.PAYMENT_PROVIDER.
 * payment.service.ts (and everything above it -- controllers, routes) only
 * ever imports this function, never a concrete provider class directly, so
 * switching the active provider is a config change here, not a code change
 * anywhere else.
 */
export function getPaymentProvider(): PaymentProvider {
  if (!instance) {
    switch (env.PAYMENT_PROVIDER) {
      case "cashfree":
        instance = new CashfreeProvider();
        break;
      default:
        throw new Error(`Unknown PAYMENT_PROVIDER '${env.PAYMENT_PROVIDER as string}'.`);
    }
  }
  return instance;
}
