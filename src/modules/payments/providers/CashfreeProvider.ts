import { createHmac, timingSafeEqual } from "crypto";
import { env } from "../../../config/env";
import { UnauthenticatedError } from "../../../errors/AppError";
import {
  CreateOrderInput,
  CreateOrderResult,
  CreateRefundInput,
  FetchOrderResult,
  NormalizedPaymentStatus,
  ProviderAttempt,
  ProviderAttemptStatus,
  NormalizedRefundStatus,
  NormalizedWebhookEvent,
  PaymentProvider,
  RefundResult,
  VerifyWebhookInput,
} from "./PaymentProvider";

// Test/sandbox only this phase -- env.CASHFREE_ENV's schema (src/config/env.ts)
// only accepts "test" today. Adding "production" later is a conscious,
// separate change to both that schema and this map, never a silent flip.
const HOSTS: Record<string, string> = {
  test: "https://sandbox.cashfree.com",
};

/** Cashfree order_id / customer_id charset is alphanumeric(+underscore) only -- strip UUID dashes. */
function sanitizeId(id: string): string {
  return id.replace(/-/g, "");
}

/**
 * Cashfree's API is decimal-major-unit (rupees), unlike ProdBnb's own
 * integer-minor-unit (paise) storage -- this is the one deliberate
 * boundary crossing. `.toFixed(2)` avoids a raw `minorUnits / 100` handing
 * Cashfree a float like `25.509999999999998` for an exact ₹25.51.
 */
function toMajorUnits(minorUnits: number): number {
  return Number((minorUnits / 100).toFixed(2));
}

/**
 * The inverse crossing, for reading a provider-reported amount back. Rounds
 * rather than truncates so a float like `4999.999999` coming back over JSON
 * for an exact ₹5,000.00 doesn't verify as 499999 != 500000 and get a
 * legitimate payment rejected as an amount mismatch.
 */
function toMinorUnits(majorUnits: unknown): number | null {
  const n = typeof majorUnits === "string" ? Number(majorUnits) : majorUnits;
  if (typeof n !== "number" || !Number.isFinite(n)) {
    return null;
  }
  return Math.round(n * 100);
}

function mapOrderStatus(orderStatus: string): NormalizedPaymentStatus {
  switch (orderStatus) {
    case "PAID":
      return "success";
    case "ACTIVE":
      return "pending";
    case "EXPIRED":
      return "failed";
    case "TERMINATED":
    case "TERMINATION_REQUESTED":
      return "cancelled";
    default:
      return "pending";
  }
}

function mapRefundStatus(refundStatus: string | undefined): NormalizedRefundStatus {
  switch (refundStatus) {
    case "SUCCESS":
      return "success";
    case "FAILED":
      return "failed";
    case "CANCELLED":
      return "cancelled";
    default:
      // Cashfree's exact refund_status enum wasn't fully confirmed against
      // live docs at implementation time (only SUCCESS was) -- treat
      // anything unrecognized as still-pending rather than guessing wrong
      // in either a false-success or false-failure direction.
      return "pending";
  }
}

/**
 * Cashfree's attempt-level status enum (Phase 26-H.9D). All seven documented values are handled
 * explicitly -- including `NOT_ATTEMPTED` and `VOID`, which are easy to forget and would otherwise
 * fall through to a wrong answer.
 *
 * Anything unrecognised maps to `unknown` rather than being coerced: a future provider value must
 * never be able to settle or fail a payment by accident.
 */
function mapAttemptStatus(paymentStatus: unknown): ProviderAttemptStatus {
  switch (paymentStatus) {
    case "SUCCESS":
      return "success";
    case "PENDING":
      return "pending";
    case "FAILED":
      return "failed";
    case "USER_DROPPED":
      return "dropped";
    case "CANCELLED":
      return "cancelled";
    case "VOID":
      return "void";
    case "NOT_ATTEMPTED":
      return "notAttempted";
    default:
      return "unknown";
  }
}

/** Statuses that mean "this attempt is over and did not pay" -- worth explaining, never terminal. */
const UNSUCCESSFUL_ATTEMPT_STATUSES = new Set<ProviderAttemptStatus>(["failed", "dropped", "cancelled", "void"]);

interface CashfreeAttemptResponse {
  cf_payment_id?: string | number;
  payment_status?: string;
  payment_amount?: number | string;
  payment_currency?: string;
  payment_time?: string;
  payment_completion_time?: string;
  payment_group?: string;
  error_details?: { error_code?: string; error_description?: string };
}

/**
 * Projects a provider attempt down to the few fields reconciliation actually needs.
 *
 * Everything omitted here is omitted deliberately: `payment_method`, `payment_gateway_details`,
 * `authorization`, `bank_reference` and `auth_id` carry instrument and banking detail that ProdBnb
 * has no reason to hold. Dropping it at the boundary is what keeps it out of `provider_raw`, out
 * of logs, and out of any API response.
 */
function toProviderAttempt(attempt: CashfreeAttemptResponse): ProviderAttempt {
  return {
    id: attempt.cf_payment_id != null ? String(attempt.cf_payment_id) : null,
    status: mapAttemptStatus(attempt.payment_status),
    rawStatus: typeof attempt.payment_status === "string" ? attempt.payment_status : null,
    amountMinorUnits: toMinorUnits(attempt.payment_amount),
    currency: attempt.payment_currency ?? null,
    attemptedAt: attempt.payment_time ?? null,
    completedAt: attempt.payment_completion_time ?? null,
    method: attempt.payment_group ?? null,
    errorCode: attempt.error_details?.error_code ?? null,
    errorDescription: attempt.error_details?.error_description ?? null,
  };
}

/**
 * Newest first, deterministically.
 *
 * Cashfree does not document the array's ordering, so relying on it would be a latent,
 * data-dependent bug. Sorts a **copy**, falls back to the attempt id when timestamps are equal or
 * missing, so the same set always produces the same answer however the API happened to return it.
 */
function sortAttemptsNewestFirst(attempts: ProviderAttempt[]): ProviderAttempt[] {
  return [...attempts].sort((a, b) => {
    const at = a.attemptedAt ? Date.parse(a.attemptedAt) : NaN;
    const bt = b.attemptedAt ? Date.parse(b.attemptedAt) : NaN;
    const aValid = Number.isFinite(at);
    const bValid = Number.isFinite(bt);
    if (aValid && bValid && at !== bt) {
      return bt - at;
    }
    // A dated attempt always outranks an undated one, so missing timestamps cannot reorder.
    if (aValid !== bValid) {
      return aValid ? -1 : 1;
    }
    return (b.id ?? "").localeCompare(a.id ?? "");
  });
}

/**
 * Picks the attempt that settles the order, and the one worth explaining.
 *
 * **A `SUCCESS` anywhere wins, regardless of age.** An order carrying an old success and a newer
 * pending attempt is paid -- money already moved, and a later stray attempt must never downgrade
 * that. This is the same rule the client already applies when choosing among a booking's payment
 * attempts, so the two agree by construction.
 */
function selectAttempts(attempts: ProviderAttempt[]): {
  settledAttempt: ProviderAttempt | null;
  lastAttempt: ProviderAttempt | null;
} {
  const ordered = sortAttemptsNewestFirst(attempts);

  const settled = ordered.find((a) => a.status === "success") ?? null;
  if (settled) {
    return { settledAttempt: settled, lastAttempt: settled };
  }

  const pending = ordered.find((a) => a.status === "pending") ?? null;
  if (pending) {
    return { settledAttempt: null, lastAttempt: pending };
  }

  const unsuccessful = ordered.find((a) => UNSUCCESSFUL_ATTEMPT_STATUSES.has(a.status)) ?? null;
  // `notAttempted`/`unknown` deliberately yield no advisory: neither tells the payer anything
  // true, and an unknown value must not imply an outcome.
  return { settledAttempt: null, lastAttempt: unsuccessful };
}

interface CashfreeOrderResponse {
  cf_order_id?: string;
  order_id: string;
  order_status: string;
  payment_session_id?: string;
  order_amount?: number | string;
  order_currency?: string;
}

interface CashfreeRefundResponse {
  cf_refund_id?: string;
  refund_id: string;
  refund_status?: string;
}

export class CashfreeProvider implements PaymentProvider {
  readonly name = "cashfree" as const;

  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor() {
    const host = HOSTS[env.CASHFREE_ENV];
    if (!host) {
      throw new Error(`No Cashfree host configured for CASHFREE_ENV='${env.CASHFREE_ENV}'.`);
    }
    this.baseUrl = host;
    this.headers = {
      "x-api-version": env.CASHFREE_API_VERSION,
      "x-client-id": env.CASHFREE_APP_ID,
      "x-client-secret": env.CASHFREE_SECRET_KEY,
      "Content-Type": "application/json",
    };
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, { ...init, headers: { ...this.headers, ...init.headers } });
    const body = await res.json();
    if (!res.ok) {
      const message = (body as { message?: string })?.message ?? `Cashfree request failed (${res.status}).`;
      throw new Error(`Cashfree API error: ${message}`);
    }
    return body as T;
  }

  async createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
    const body = await this.request<CashfreeOrderResponse>("/pg/orders", {
      method: "POST",
      body: JSON.stringify({
        order_id: input.merchantOrderId,
        order_amount: toMajorUnits(input.amountMinorUnits),
        order_currency: input.currency,
        customer_details: {
          customer_id: sanitizeId(input.customer.id),
          customer_phone: input.customer.phone,
          ...(input.customer.email ? { customer_email: input.customer.email } : {}),
        },
        order_meta: {
          return_url: input.returnUrl,
          notify_url: input.notifyUrl,
        },
      }),
    });

    return {
      providerReferenceId: body.cf_order_id ?? null,
      status: mapOrderStatus(body.order_status),
      checkout: { payment_session_id: body.payment_session_id ?? null, order_id: body.order_id },
      raw: body,
    };
  }

  async fetchOrder(providerOrderId: string): Promise<FetchOrderResult> {
    const body = await this.request<CashfreeOrderResponse>(`/pg/orders/${encodeURIComponent(providerOrderId)}`, {
      method: "GET",
    });

    const result: FetchOrderResult = {
      status: mapOrderStatus(body.order_status),
      providerReferenceId: body.cf_order_id ?? null,
      // Cashfree mints a NEW payment_session_id on every order fetch. It is a
      // different token than the one create returned, but it addresses this
      // same order_id -- which is exactly what lets an abandoned checkout be
      // resumed instead of duplicated.
      checkout: { payment_session_id: body.payment_session_id ?? null, order_id: body.order_id },
      amountMinorUnits: toMinorUnits(body.order_amount),
      currency: body.order_currency ?? null,
      raw: body,
    };

    // Attempt-level enrichment (Phase 26-H.9D), only for an order that is still open.
    //
    // PAID/EXPIRED/TERMINATED already answer the question completely, so asking again would be a
    // wasted round-trip on the common settled path. ACTIVE is the only ambiguous case: the order
    // is open, and *why* it is still open (nothing tried yet, a try in flight, or a try that
    // failed) is exactly what the order-level status cannot say.
    if (body.order_status === "ACTIVE") {
      const attempts = await this.fetchAttempts(providerOrderId);
      if (attempts) {
        const { settledAttempt, lastAttempt } = selectAttempts(attempts);
        result.settledAttempt = settledAttempt;
        result.lastAttempt = lastAttempt;
      }
    }

    return result;
  }

  /**
   * Reads the order's payment attempts. **Best-effort by contract** (Phase 26-H.9D).
   *
   * Returns `null` on any failure -- transport error, non-2xx, malformed or non-array body -- and
   * the caller then simply behaves exactly as it did before 9D. This is deliberate: the attempts
   * read is enrichment, and a verification that used to succeed must not start failing because an
   * *additional* call did. A missing advisory is cosmetic; a failed verification is a regression.
   *
   * Logs the failure without any payload, so an attempt's instrument data can never reach a log.
   */
  private async fetchAttempts(providerOrderId: string): Promise<ProviderAttempt[] | null> {
    try {
      const body = await this.request<unknown>(`/pg/orders/${encodeURIComponent(providerOrderId)}/payments`, {
        method: "GET",
      });
      if (!Array.isArray(body)) {
        console.error("Cashfree attempts response was not an array; falling back to order-level status.");
        return null;
      }
      return body.map((attempt) => toProviderAttempt((attempt ?? {}) as CashfreeAttemptResponse));
    } catch (err) {
      // Message only -- never the response body.
      console.error("Cashfree attempts lookup failed; falling back to order-level status:", (err as Error).message);
      return null;
    }
  }

  /**
   * Cashfree has no DELETE for orders -- terminating is a status PATCH, and it
   * legitimately refuses on an order that is already PAID or already
   * terminated. `payment.service.ts` treats a throw here as non-fatal.
   */
  async terminateOrder(providerOrderId: string): Promise<void> {
    await this.request<CashfreeOrderResponse>(`/pg/orders/${encodeURIComponent(providerOrderId)}`, {
      method: "PATCH",
      body: JSON.stringify({ order_status: "TERMINATED" }),
    });
  }

  async createRefund(input: CreateRefundInput): Promise<RefundResult> {
    const body = await this.request<CashfreeRefundResponse>(`/pg/orders/${encodeURIComponent(input.providerOrderId)}/refunds`, {
      method: "POST",
      body: JSON.stringify({
        refund_id: input.merchantRefundId,
        refund_amount: toMajorUnits(input.amountMinorUnits),
        ...(input.reason ? { refund_note: input.reason } : {}),
      }),
    });

    return {
      providerReferenceId: body.cf_refund_id ?? null,
      status: mapRefundStatus(body.refund_status),
      raw: body,
    };
  }

  verifyAndParseWebhook(input: VerifyWebhookInput): NormalizedWebhookEvent | null {
    const timestamp = input.headers["x-webhook-timestamp"];
    const signature = input.headers["x-webhook-signature"];

    if (typeof timestamp !== "string" || typeof signature !== "string") {
      throw new UnauthenticatedError("Missing Cashfree webhook signature headers.");
    }

    const expected = createHmac("sha256", env.CASHFREE_SECRET_KEY)
      .update(timestamp + input.rawBody)
      .digest("base64");

    const expectedBuf = Buffer.from(expected);
    const actualBuf = Buffer.from(signature);
    const isValid = expectedBuf.length === actualBuf.length && timingSafeEqual(expectedBuf, actualBuf);

    if (!isValid) {
      throw new UnauthenticatedError("Invalid Cashfree webhook signature.");
    }

    const payload = JSON.parse(input.rawBody) as {
      type?: string;
      data?: {
        order?: { order_id?: string };
        payment?: {
          cf_payment_id?: string | number;
          payment_status?: string;
          payment_amount?: number;
          payment_currency?: string;
        };
        refund?: {
          order_id?: string;
          refund_id?: string;
          cf_refund_id?: string | number;
          refund_status?: string;
          refund_amount?: number;
        };
      };
    };

    const type = payload.type ?? "";

    if (type === "PAYMENT_SUCCESS_WEBHOOK" || type === "PAYMENT_FAILED_WEBHOOK" || type === "PAYMENT_USER_DROPPED_WEBHOOK") {
      const orderId = payload.data?.order?.order_id;
      if (!orderId) {
        return null;
      }
      const eventType =
        type === "PAYMENT_SUCCESS_WEBHOOK"
          ? "PAYMENT_SUCCESS"
          : type === "PAYMENT_USER_DROPPED_WEBHOOK"
            ? "PAYMENT_USER_DROPPED"
            : "PAYMENT_FAILED";
      return {
        type: eventType,
        providerOrderId: orderId,
        providerPaymentId: payload.data?.payment?.cf_payment_id != null ? String(payload.data.payment.cf_payment_id) : null,
        providerRefundId: null,
        amountMinorUnits: toMinorUnits(payload.data?.payment?.payment_amount),
        currency: payload.data?.payment?.payment_currency ?? null,
        raw: payload,
      };
    }

    if (type.startsWith("REFUND")) {
      const refund = payload.data?.refund;
      const orderId = refund?.order_id;
      if (!refund || !orderId) {
        return null;
      }
      const status = mapRefundStatus(refund.refund_status);
      const eventType = status === "success" ? "REFUND_SUCCESS" : status === "failed" ? "REFUND_FAILED" : "REFUND_CREATED";
      return {
        type: eventType,
        providerOrderId: orderId,
        providerPaymentId: null,
        providerRefundId: refund.refund_id ?? null,
        amountMinorUnits: toMinorUnits(refund.refund_amount),
        currency: null,
        raw: payload,
      };
    }

    // Signature was valid but this is an event type ProdBnb doesn't act on
    // yet (e.g. PAYMENT_CHARGES_WEBHOOK) -- acknowledge, don't apply state.
    return null;
  }
}
