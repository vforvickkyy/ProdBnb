import { createHmac, timingSafeEqual } from "crypto";
import { env } from "../../../config/env";
import { UnauthenticatedError } from "../../../errors/AppError";
import {
  CreateOrderInput,
  CreateOrderResult,
  CreateRefundInput,
  FetchOrderStatusResult,
  NormalizedPaymentStatus,
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

interface CashfreeOrderResponse {
  cf_order_id?: string;
  order_id: string;
  order_status: string;
  payment_session_id?: string;
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

  async fetchOrderStatus(providerOrderId: string): Promise<FetchOrderStatusResult> {
    const body = await this.request<CashfreeOrderResponse>(`/pg/orders/${encodeURIComponent(providerOrderId)}`, {
      method: "GET",
    });
    return {
      status: mapOrderStatus(body.order_status),
      providerReferenceId: body.cf_order_id ?? null,
      raw: body,
    };
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
        payment?: { cf_payment_id?: string | number; payment_status?: string; payment_amount?: number };
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
      const eventType = type === "PAYMENT_SUCCESS_WEBHOOK" ? "PAYMENT_SUCCESS" : "PAYMENT_FAILED";
      return {
        type: eventType,
        providerOrderId: orderId,
        providerPaymentId: payload.data?.payment?.cf_payment_id != null ? String(payload.data.payment.cf_payment_id) : null,
        providerRefundId: null,
        amountMinorUnits:
          payload.data?.payment?.payment_amount != null ? Math.round(payload.data.payment.payment_amount * 100) : null,
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
        amountMinorUnits: refund.refund_amount != null ? Math.round(refund.refund_amount * 100) : null,
        raw: payload,
      };
    }

    // Signature was valid but this is an event type ProdBnb doesn't act on
    // yet (e.g. PAYMENT_CHARGES_WEBHOOK) -- acknowledge, don't apply state.
    return null;
  }
}
