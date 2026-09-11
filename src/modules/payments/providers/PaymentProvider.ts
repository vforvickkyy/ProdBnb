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

/**
 * One payment *attempt* against an order, in provider-neutral terms (Phase 26-H.9D).
 *
 * An order and an attempt are different things. A provider order is the thing being paid for and
 * stays open until it is paid, expires or is terminated; an attempt is one try at paying it. A
 * single order legitimately carries several attempts -- a failed card, then a successful UPI --
 * which is why an attempt failing says nothing final about the order.
 */
export type ProviderAttemptStatus =
  | "success"
  | "pending"
  | "failed"
  /** The payer abandoned this attempt without completing it. */
  | "dropped"
  | "cancelled"
  | "void"
  /** The provider created an attempt record but nothing was ever tried against it. */
  | "notAttempted"
  /** A value this build does not recognise. Never coerced into a known one. */
  | "unknown";

/**
 * The **reduced projection** of an attempt that crosses into the generic layer.
 *
 * Deliberately narrow (Phase 26-H.9D): a real provider attempt payload also carries instrument
 * data -- card BIN and last four, network, bank, UPI handle, gateway details, authorization -- and
 * none of that is needed to reconcile a payment. Keeping it out of this type is what keeps it out
 * of the database and the logs.
 */
export interface ProviderAttempt {
  /** The provider's own id for this attempt (Cashfree's `cf_payment_id`). */
  id: string | null;
  status: ProviderAttemptStatus;
  /** The provider's raw status string, kept only so an unrecognised value is diagnosable. */
  rawStatus: string | null;
  amountMinorUnits: number | null;
  currency: string | null;
  /** ISO-8601, as the provider reported it. */
  attemptedAt: string | null;
  completedAt: string | null;
  /** e.g. "upi", "debit_card" -- coarse method family, never instrument detail. */
  method: string | null;
  /** Provider error code, for diagnostics. Never shown to a payer verbatim. */
  errorCode: string | null;
  errorDescription: string | null;
}

export interface FetchOrderResult {
  status: NormalizedPaymentStatus;
  providerReferenceId: string | null;
  /**
   * A **fresh** provider-shaped checkout payload for this same order -- the
   * thing that makes resuming an abandoned attempt possible without creating a
   * second order (Phase 26-H). For Cashfree the provider re-issues a new
   * `payment_session_id` on every order fetch; it is a different token each
   * time but addresses the identical order, so handing it back is a resume,
   * never a duplicate charge.
   *
   * Only meaningful while the order is still payable (`pending`).
   */
  checkout: Record<string, unknown>;
  /**
   * What the PROVIDER says this order is for, used to verify against what
   * ProdBnb recorded before any payment is allowed to reach `success`
   * (Phase 26-H). `null` when the provider does not report it -- which for a
   * real provider response it always does; see `assertProviderAmountMatches`.
   */
  amountMinorUnits: number | null;
  currency: string | null;
  /**
   * A successful attempt found against an order the provider still reports as open
   * (Phase 26-H.9D). Lets a payment settle from the strongest available evidence rather than
   * waiting for order-level status or a webhook that may never arrive.
   *
   * **Optional on purpose:** a provider that does not expose attempts, and every existing test
   * double, simply omits it and behaves exactly as before.
   */
  settledAttempt?: ProviderAttempt | null;
  /**
   * The most recent attempt worth *explaining* when the order is still open and unpaid --
   * typically a failed or abandoned try.
   *
   * Advisory only. It must never drive a status transition: while the order is still open the
   * payer can attempt again, so a failed attempt is not a failed payment.
   */
  lastAttempt?: ProviderAttempt | null;
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
  /**
   * The payer abandoned checkout without completing. Distinguished from
   * `PAYMENT_FAILED` (Phase 26-H) for one reason only: the payer has left, so
   * the still-payable provider order can be safely terminated before ProdBnb
   * records a terminal `failed` -- see `payment.service.ts#handleWebhook`.
   * A `PAYMENT_FAILED` (e.g. a card decline) means the payer is very likely
   * still sitting in checkout about to try another instrument, so that one is
   * deliberately NOT terminated.
   */
  | "PAYMENT_USER_DROPPED"
  | "REFUND_CREATED"
  | "REFUND_SUCCESS"
  | "REFUND_FAILED";

export interface NormalizedWebhookEvent {
  type: NormalizedWebhookEventType;
  providerOrderId: string;
  providerPaymentId: string | null;
  providerRefundId: string | null;
  amountMinorUnits: number | null;
  /** ISO-4217 code the provider reports for this event, when it reports one. */
  currency: string | null;
  raw: unknown;
}

export interface VerifyWebhookInput {
  rawBody: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface PaymentProvider {
  readonly name: PaymentProviderName;
  createOrder(input: CreateOrderInput): Promise<CreateOrderResult>;
  /**
   * The authoritative server-side read of an order: its status, what the
   * provider believes it is for, and a fresh checkout payload for resuming it.
   * Replaces Phase 7's `fetchOrderStatus` (Phase 26-H) -- one call now answers
   * "did this succeed", "for how much" and "can the payer resume", instead of
   * needing a separate round-trip for each.
   */
  fetchOrder(providerOrderId: string): Promise<FetchOrderResult>;
  /**
   * Makes an abandoned order genuinely unpayable, so ProdBnb recording a
   * terminal `failed` is not a lie about a provider order that is still live
   * (Phase 26-H). Best-effort by contract: callers must tolerate it throwing,
   * since a provider may legitimately refuse (e.g. the order was in fact just
   * paid), and reconciliation is what settles that -- not this call.
   */
  terminateOrder(providerOrderId: string): Promise<void>;
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
