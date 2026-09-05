import { env } from "../../config/env";

// Read-only, sourced entirely from already-validated `env` -- never a raw
// dump, never any key/secret value, only booleans/enums an admin needs to
// confirm the deployment is configured the way they expect (Phase 14).
// Nothing here can leak a credential: R2/Cashfree/APNs fields below report
// only whether a value is present, never what it is.

export interface SystemStatus {
  environment: string;
  payments: {
    provider: string;
    mode: string;
  };
  notifications: {
    provider: string;
  };
  media: {
    configured: boolean;
  };
}

export function getSystemStatus(): SystemStatus {
  return {
    environment: env.NODE_ENV,
    payments: {
      provider: env.PAYMENT_PROVIDER,
      mode: env.CASHFREE_ENV,
    },
    notifications: {
      provider: env.NOTIFICATION_PROVIDER,
    },
    media: {
      configured: Boolean(env.R2_ACCOUNT_ID && env.R2_BUCKET_NAME && env.R2_ACCESS_KEY_ID),
    },
  };
}
