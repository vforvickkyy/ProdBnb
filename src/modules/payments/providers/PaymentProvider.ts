// The provider-agnostic contract every payment provider adapter implements.
// Deliberately small (create/fetch/refund/verify-webhook only) -- add a
// method here only when a real ProdBnb use case needs it, not because a
// provider's API happens to offer it.
//
// Adding a second provider (e.g. Razorpay) later means: one new value in
// PaymentProviderName, one new adapter file implementing this same
// interface, one new CHECK-constraint value on payments.provider /
// payment_webhook_events.provider (a small additive migration), and wiring
// it into providers/index.ts. Nothing in payment.service.ts, the routes, or
// the database's core shape changes.

export type PaymentProviderName = "cashfree";

export type NormalizedPaymentStatus =
  | "created"
  | "pending"
  | "success"
  | "failed"
  | "cancelled"
  | "refunded"
  | "partially_refunded";

export type NormalizedRefundStatus = "pending" | "success" | "failed" | "cancelled";

export interface CreateOrderInput {
  /** The order id WE generate (payments.provider_order_id) -- never provider-generated. */
  merchantOrderId: string;
  amountMinorUnits: number;
  currency: string;
  customer: {
    id: string;
    email: string | null;
    phone: string;
  };
  /** Where the client is redirected after a hosted/browser checkout completes. */
  returnUrl: string;
  /** This server's own webhook endpoint -- always server-constructed, never client-influenced. */
  notifyUrl: string;
}

export interface CreateOrderResult {
  providerReferenceId: string | null;
  status: NormalizedPaymentStatus;
  /** Opaque, provider-shaped checkout payload -- e.g. { payment_session_id, order_id } for Cashfree. */
  checkout: Record<string, unknown>;
  raw: unknown;
}

export interface FetchOrderStatusResult {
  status: NormalizedPaymentStatus;
  providerReferenceId: string | null;
  raw: unknown;
}

export interface CreateRefundInput {
  providerOrderId: string;
  /** The refund id WE generate (payment_refunds.provider_refund_id). */
  merchantRefundId: string;
  amountMinorUnits: number;
  reason?: string;
}

export interface RefundResult {
  providerReferenceId: string | null;
  status: NormalizedRefundStatus;
  raw: unknown;
}

export type NormalizedWebhookEventType =
  | "PAYMENT_PENDING"
  | "PAYMENT_SUCCESS"
  | "PAYMENT_FAILED"
  | "REFUND_CREATED"
  | "REFUND_SUCCESS"
  | "REFUND_FAILED";

export interface NormalizedWebhookEvent {
  type: NormalizedWebhookEventType;
  providerOrderId: string;
  providerPaymentId: string | null;
  providerRefundId: string | null;
  amountMinorUnits: number | null;
  raw: unknown;
}

export interface VerifyWebhookInput {
  rawBody: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface PaymentProvider {
  readonly name: PaymentProviderName;
  createOrder(input: CreateOrderInput): Promise<CreateOrderResult>;
  fetchOrderStatus(providerOrderId: string): Promise<FetchOrderStatusResult>;
  createRefund(input: CreateRefundInput): Promise<RefundResult>;
  /**
   * Verifies the provider's signature and normalizes the event. Throws an
   * AppError (401) on an invalid/missing signature -- never returns a
   * "verified: false" value, so a caller can't accidentally forget to check
   * one. Returns `null` (still a successfully-verified call) for an
   * authentic webhook whose event type ProdBnb doesn't act on -- the caller
   * should acknowledge it (200) without applying any state change.
   */
  verifyAndParseWebhook(input: VerifyWebhookInput): NormalizedWebhookEvent | null;
}
