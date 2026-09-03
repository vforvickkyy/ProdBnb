import { createHmac, randomUUID } from "crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "../src/config/env";
import { createApp } from "../src/app";
import { adminClient, createTestUser, deleteTestUser, TestUser } from "./setup";

// Deliberately does NOT mock CashfreeProvider -- webhook signature
// verification is pure local HMAC computation with no network call
// involved (see CashfreeProvider#verifyAndParseWebhook), so this file
// exercises the real adapter code, not a fake, matching the Phase 7 plan's
// "webhook signature verification itself is tested against the real
// CashfreeProvider code path" requirement.

const app = createApp();
const WEBHOOK_PATH = "/v1/payments/webhooks/cashfree";

function sign(rawBody: string, timestamp: string): string {
  return createHmac("sha256", env.CASHFREE_SECRET_KEY).update(timestamp + rawBody).digest("base64");
}

async function postWebhook(payload: unknown, opts: { timestamp?: string; signature?: string; skipSignature?: boolean } = {}) {
  const rawBody = JSON.stringify(payload);
  const timestamp = opts.timestamp ?? String(Math.floor(Date.now() / 1000));
  const signature = opts.signature ?? sign(rawBody, timestamp);

  const req = request(app).post(WEBHOOK_PATH).set("Content-Type", "application/json");
  if (!opts.skipSignature) {
    req.set("x-webhook-timestamp", timestamp).set("x-webhook-signature", signature);
  }
  return req.send(rawBody);
}

function paymentSuccessPayload(orderId: string, cfPaymentId: string, amountMajorUnits: number) {
  return {
    type: "PAYMENT_SUCCESS_WEBHOOK",
    event_time: new Date().toISOString(),
    data: {
      order: { order_id: orderId, order_amount: amountMajorUnits, order_currency: "INR" },
      payment: { cf_payment_id: cfPaymentId, payment_status: "SUCCESS", payment_amount: amountMajorUnits, payment_currency: "INR" },
    },
  };
}

function paymentFailedPayload(orderId: string) {
  return {
    type: "PAYMENT_FAILED_WEBHOOK",
    event_time: new Date().toISOString(),
    data: {
      order: { order_id: orderId },
      payment: { cf_payment_id: `cf_pay_${orderId}`, payment_status: "FAILED" },
    },
  };
}

function refundStatusPayload(orderId: string, refundId: string, amountMajorUnits: number, status: "SUCCESS" | "FAILED" = "SUCCESS") {
  return {
    type: "REFUND_STATUS_WEBHOOK",
    event_time: new Date().toISOString(),
    data: {
      refund: {
        order_id: orderId,
        refund_id: refundId,
        cf_refund_id: `cf_${refundId}`,
        refund_amount: amountMajorUnits,
        refund_status: status,
      },
    },
  };
}

async function seedPayment(bookingId: string, amountMinorUnits: number, status: "created" | "pending" | "success" = "pending") {
  const id = randomUUID();
  const providerOrderId = `pb_${id.replace(/-/g, "")}`;
  const { error } = await adminClient.from("payments").insert({
    id,
    booking_id: bookingId,
    provider: "cashfree",
    provider_order_id: providerOrderId,
    status,
    amount_minor_units: amountMinorUnits,
    currency: "INR",
  });
  if (error) throw error;
  return { id, providerOrderId };
}

async function paymentStatus(id: string): Promise<string> {
  const { data, error } = await adminClient.from("payments").select("status").eq("id", id).single();
  if (error) throw error;
  return data.status;
}

function authHeader(user: TestUser): { Authorization: string } {
  return { Authorization: `Bearer ${user.accessToken}` };
}

describe("payment webhooks (Cashfree)", () => {
  let host: TestUser;
  let booker: TestUser;
  let locationId: string;
  let nextHour = 9; // 2026-10-05 (a Monday) has an open 09:00-18:00 window

  beforeAll(async () => {
    host = await createTestUser();
    booker = await createTestUser();
    await request(app).post("/v1/me/roles").set(authHeader(host)).send({ role: "host" });
    await request(app).post("/v1/me/roles").set(authHeader(booker)).send({ role: "booker" });

    const loc = await request(app)
      .post("/v1/locations")
      .set(authHeader(host))
      .send({ title: "Webhook Test Location", city: "London", country: "UK" });
    locationId = loc.body.data.id as string;
    await request(app)
      .post(`/v1/locations/${locationId}/availability/rules`)
      .set(authHeader(host))
      .send({ day_of_week: "monday", start_time: "09:00", end_time: "18:00" });
    await request(app).post(`/v1/locations/${locationId}/pricing`).set(authHeader(host)).send({ booking_type: "hourly", amount_minor_units: 10_000 });
    const { error } = await adminClient.from("locations").update({ status: "published" }).eq("id", locationId);
    if (error) throw error;
  });

  afterAll(async () => {
    await deleteTestUser(host.id);
    await deleteTestUser(booker.id);
  });

  /**
   * A fresh booking per test, in its own hour slot -- `payments` only
   * allows one in-flight (created/pending) row per booking (the partial
   * unique index), and several tests here deliberately leave a seeded
   * payment non-terminal (e.g. after a rejected signature). Sharing one
   * booking across tests would make those collide with each other.
   */
  async function createFreshBooking(): Promise<string> {
    const hour = nextHour++;
    const start = `2026-10-05T${String(hour).padStart(2, "0")}:00:00Z`;
    const end = `2026-10-05T${String(hour + 1).padStart(2, "0")}:00:00Z`;
    const res = await request(app)
      .post("/v1/bookings")
      .set(authHeader(booker))
      .send({ location_id: locationId, start_at: start, end_at: end });
    expect(res.status).toBe(201);
    return res.body.data.id as string;
  }

  it("accepts a correctly-signed PAYMENT_SUCCESS_WEBHOOK and flips the payment to success", async () => {
    const { id, providerOrderId } = await seedPayment(await createFreshBooking(), 10_000);
    const res = await postWebhook(paymentSuccessPayload(providerOrderId, "cf_pay_1", 100));
    expect(res.status).toBe(200);
    expect(await paymentStatus(id)).toBe("success");
  });

  it("rejects an invalid signature before touching the database", async () => {
    const { id, providerOrderId } = await seedPayment(await createFreshBooking(), 10_000);
    const res = await postWebhook(paymentSuccessPayload(providerOrderId, "cf_pay_2", 100), { signature: "bm90LWEtcmVhbC1zaWduYXR1cmU=" });
    expect(res.status).toBe(401);
    expect(await paymentStatus(id)).toBe("pending"); // untouched
  });

  it("rejects a request with no signature headers at all", async () => {
    const { providerOrderId } = await seedPayment(await createFreshBooking(), 10_000);
    const res = await postWebhook(paymentSuccessPayload(providerOrderId, "cf_pay_3", 100), { skipSignature: true });
    expect(res.status).toBe(401);
  });

  it("an exact duplicate delivery is a safe no-op, not double-processed", async () => {
    const { id, providerOrderId } = await seedPayment(await createFreshBooking(), 10_000);
    const payload = paymentSuccessPayload(providerOrderId, "cf_pay_4", 100);
    const timestamp = String(Math.floor(Date.now() / 1000));

    const first = await postWebhook(payload, { timestamp });
    expect(first.status).toBe(200);
    const second = await postWebhook(payload, { timestamp }); // byte-identical redelivery
    expect(second.status).toBe(200);

    expect(await paymentStatus(id)).toBe("success");

    const { data, error } = await adminClient
      .from("payment_webhook_events")
      .select("id")
      .eq("payment_id", id);
    if (error) throw error;
    expect(data).toHaveLength(1); // not two ledger rows for the same byte-identical body
  });

  it("a payment already at a terminal status never regresses from a later/duplicate event", async () => {
    const { id, providerOrderId } = await seedPayment(await createFreshBooking(), 10_000);
    const success = await postWebhook(paymentSuccessPayload(providerOrderId, "cf_pay_5", 100));
    expect(success.status).toBe(200);
    expect(await paymentStatus(id)).toBe("success");

    // A late/duplicate FAILED delivery for the same order must not undo it.
    const failed = await postWebhook(paymentFailedPayload(providerOrderId));
    expect(failed.status).toBe(200);
    expect(await paymentStatus(id)).toBe("success");
  });

  it("acknowledges (200) a validly-signed but unrecognized event type without changing anything", async () => {
    const { id, providerOrderId } = await seedPayment(await createFreshBooking(), 10_000);
    const res = await postWebhook({
      type: "PAYMENT_CHARGES_WEBHOOK",
      event_time: new Date().toISOString(),
      data: { order: { order_id: providerOrderId }, payment: { payment_status: "SUCCESS" } },
    });
    expect(res.status).toBe(200);
    expect(await paymentStatus(id)).toBe("pending"); // unrecognized -- no state change applied
  });

  it("a webhook for an unknown order_id is acknowledged safely without erroring", async () => {
    const res = await postWebhook(paymentSuccessPayload("pb_does_not_exist_anywhere", "cf_pay_x", 100));
    expect(res.status).toBe(200);
  });

  it("a REFUND_STATUS_WEBHOOK moves the refund and recomputes the parent payment to refunded", async () => {
    const { id: paymentId, providerOrderId } = await seedPayment(await createFreshBooking(), 10_000, "success");
    const refundId = randomUUID();
    const providerRefundId = `pbr_${refundId.replace(/-/g, "")}`;
    const { error } = await adminClient.from("payment_refunds").insert({
      id: refundId,
      payment_id: paymentId,
      provider_refund_id: providerRefundId,
      status: "pending",
      amount_minor_units: 10_000,
    });
    if (error) throw error;

    const res = await postWebhook(refundStatusPayload(providerOrderId, providerRefundId, 100, "SUCCESS"));
    expect(res.status).toBe(200);

    const { data: refund, error: refundError } = await adminClient
      .from("payment_refunds")
      .select("status")
      .eq("id", refundId)
      .single();
    if (refundError) throw refundError;
    expect(refund.status).toBe("success");

    expect(await paymentStatus(paymentId)).toBe("refunded");
  });
});
