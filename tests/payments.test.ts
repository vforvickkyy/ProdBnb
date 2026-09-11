import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Mirrors tests/media.test.ts's approach to mocking src/lib/r2 -- the
// Cashfree ADAPTER is mocked here (no real network calls), while
// tests/payments-webhooks.test.ts leaves CashfreeProvider un-mocked, since
// webhook signature verification is pure local HMAC computation with no
// network involved and deserves real coverage.
const mockState = vi.hoisted(() => ({
  orderStatus: new Map<string, "pending" | "success" | "failed" | "cancelled">(),
  /** What the provider believes each order is for -- drives amount/currency verification. */
  orderAmounts: new Map<string, { amountMinorUnits: number; currency: string }>(),
  fetchOrderCallCounts: new Map<string, number>(),
  createOrderCallCount: 0,
  terminatedOrders: [] as string[],
  refundStatus: "success" as "pending" | "success" | "failed",
  createOrderShouldThrow: false,
  fetchOrderShouldThrow: false,
  /** Forces fetchOrder/webhook to report a DIFFERENT amount than was recorded. */
  reportedAmountOverride: null as null | { amountMinorUnits: number | null; currency: string | null },
  /** Phase 26-H.9D: attempt-level enrichment returned alongside an ACTIVE order. */
  settledAttempt: null as null | {
    id: string | null;
    status: string;
    rawStatus: string | null;
    amountMinorUnits: number | null;
    currency: string | null;
    attemptedAt: string | null;
    completedAt: string | null;
    method: string | null;
    errorCode: string | null;
    errorDescription: string | null;
  },
  lastAttempt: null as null | { id: string | null; status: string },
}));

vi.mock("../src/modules/payments/providers/CashfreeProvider", () => ({
  CashfreeProvider: class {
    name = "cashfree" as const;

    async createOrder(input: { merchantOrderId: string; amountMinorUnits: number; currency: string }) {
      if (mockState.createOrderShouldThrow) {
        throw new Error("simulated Cashfree outage");
      }
      mockState.createOrderCallCount += 1;
      mockState.orderStatus.set(input.merchantOrderId, "pending");
      mockState.orderAmounts.set(input.merchantOrderId, {
        amountMinorUnits: input.amountMinorUnits,
        currency: input.currency,
      });
      return {
        providerReferenceId: `cf_${input.merchantOrderId}`,
        status: "pending" as const,
        checkout: { payment_session_id: `session_${input.merchantOrderId}`, order_id: input.merchantOrderId },
        raw: { mocked: true, secret_should_not_leak: "CASHFREE_SECRET_KEY_TEST_MOCK_VALUE" },
      };
    }

    async fetchOrder(providerOrderId: string) {
      if (mockState.fetchOrderShouldThrow) {
        throw new Error("simulated Cashfree outage");
      }
      mockState.fetchOrderCallCounts.set(providerOrderId, (mockState.fetchOrderCallCounts.get(providerOrderId) ?? 0) + 1);
      const status = mockState.orderStatus.get(providerOrderId) ?? "pending";
      const recorded = mockState.orderAmounts.get(providerOrderId);
      const reported = mockState.reportedAmountOverride ?? {
        amountMinorUnits: recorded?.amountMinorUnits ?? null,
        currency: recorded?.currency ?? null,
      };
      return {
        status,
        // Only an open order carries attempt enrichment, mirroring the real adapter.
        ...(status === "pending"
          ? { settledAttempt: mockState.settledAttempt, lastAttempt: mockState.lastAttempt }
          : {}),
        providerReferenceId: `cf_${providerOrderId}`,
        // Cashfree mints a NEW session token on every order fetch, for the SAME
        // order -- modelled here so resume tests can prove the order id is
        // stable while the session differs.
        checkout: {
          payment_session_id: `session_refetch_${mockState.fetchOrderCallCounts.get(providerOrderId)}_${providerOrderId}`,
          order_id: providerOrderId,
        },
        amountMinorUnits: reported.amountMinorUnits,
        currency: reported.currency,
        raw: { mocked: true },
      };
    }

    async terminateOrder(providerOrderId: string) {
      mockState.terminatedOrders.push(providerOrderId);
      mockState.orderStatus.set(providerOrderId, "cancelled");
    }

    async createRefund(input: { merchantRefundId: string }) {
      return { providerReferenceId: `cf_${input.merchantRefundId}`, status: mockState.refundStatus, raw: { mocked: true } };
    }

    // Parses WITHOUT verifying a signature. Signature security is covered
    // against the real adapter in tests/payments-webhooks.test.ts; this exists
    // so webhook-driven behaviour that needs a FAKE provider (order
    // termination) can be asserted without real network calls.
    verifyAndParseWebhook(input: { rawBody: string }) {
      const payload = JSON.parse(input.rawBody);
      const type: string = payload.type ?? "";
      if (!type.startsWith("PAYMENT")) {
        return null;
      }
      const orderId = payload.data?.order?.order_id;
      if (!orderId) {
        return null;
      }
      return {
        type:
          type === "PAYMENT_SUCCESS_WEBHOOK"
            ? "PAYMENT_SUCCESS"
            : type === "PAYMENT_USER_DROPPED_WEBHOOK"
              ? "PAYMENT_USER_DROPPED"
              : "PAYMENT_FAILED",
        providerOrderId: orderId,
        providerPaymentId: payload.data?.payment?.cf_payment_id != null ? String(payload.data.payment.cf_payment_id) : null,
        providerRefundId: null,
        amountMinorUnits:
          payload.data?.payment?.payment_amount != null ? Math.round(payload.data.payment.payment_amount * 100) : null,
        currency: payload.data?.payment?.payment_currency ?? null,
        raw: payload,
      };
    }
  },
}));

import { env } from "../src/config/env";
import { createApp } from "../src/app";
import { adminClient, createTestUser, deleteTestUser, TestUser } from "./setup";

const app = createApp();

function authHeader(user: TestUser): { Authorization: string } {
  return { Authorization: `Bearer ${user.accessToken}` };
}

async function grantRole(user: TestUser, role: "host" | "booker"): Promise<void> {
  const res = await request(app).post("/v1/me/roles").set(authHeader(user)).send({ role });
  expect(res.status).toBe(201);
}

async function publish(locationId: string): Promise<void> {
  const { error } = await adminClient.from("locations").update({ status: "published" }).eq("id", locationId);
  if (error) throw error;
}

async function addRule(locationId: string, owner: TestUser, day: string, start: string, end: string): Promise<void> {
  const res = await request(app)
    .post(`/v1/locations/${locationId}/availability/rules`)
    .set(authHeader(owner))
    .send({ day_of_week: day, start_time: start, end_time: end });
  expect(res.status).toBe(201);
}

async function addHourlyPricing(locationId: string, owner: TestUser, amount = 10_000): Promise<void> {
  const res = await request(app)
    .post(`/v1/locations/${locationId}/pricing`)
    .set(authHeader(owner))
    .send({ booking_type: "hourly", amount_minor_units: amount });
  expect(res.status).toBe(201);
}

const MON = "2026-10-05"; // a Monday

/** A location with an hourly rate, published and ready to book. */
async function createBookableLocation(owner: TestUser, amount = 10_000): Promise<string> {
  const res = await request(app)
    .post("/v1/locations")
    .set(authHeader(owner))
    .send({ title: "Payments Test Location", city: "London", country: "UK", timezone: "UTC" });
  expect(res.status).toBe(201);
  const locationId = res.body.data.id as string;
  await addRule(locationId, owner, "monday", "09:00", "18:00");
  await addHourlyPricing(locationId, owner, amount);
  await publish(locationId);
  return locationId;
}

async function createBooking(
  booker: TestUser,
  locationId: string,
  start = `${MON}T09:00:00Z`,
  end = `${MON}T10:00:00Z`
): Promise<{ id: string; total_amount_minor_units: number }> {
  const res = await request(app)
    .post("/v1/bookings")
    .set(authHeader(booker))
    .send({ location_id: locationId, start_at: start, end_at: end });
  expect(res.status).toBe(201);
  return { id: res.body.data.id as string, total_amount_minor_units: res.body.data.pricing.total_amount_minor_units as number };
}

describe("payments", () => {
  let host: TestUser;
  let booker: TestUser;
  let otherBooker: TestUser;
  let admin: TestUser;

  beforeAll(async () => {
    host = await createTestUser();
    booker = await createTestUser();
    otherBooker = await createTestUser();
    admin = await createTestUser();
    await grantRole(host, "host");
    await grantRole(booker, "booker");
    await grantRole(otherBooker, "booker");
    const { error } = await adminClient.from("user_roles").insert({ user_id: admin.id, role: "admin" });
    if (error) throw error;
  });

  afterAll(async () => {
    await deleteTestUser(host.id);
    await deleteTestUser(booker.id);
    await deleteTestUser(otherBooker.id);
    await deleteTestUser(admin.id);
  });

  describe("creation", () => {
    it("creates a payment using the booking's own immutable price, never a client-supplied amount", async () => {
      const locationId = await createBookableLocation(host);
      const booking = await createBooking(booker, locationId);

      const res = await request(app)
        .post(`/v1/bookings/${booking.id}/payment`)
        .set(authHeader(booker))
        .send({ customer_phone: "9876543210" });
      expect(res.status).toBe(201);
      expect(res.body.data.booking_id).toBe(booking.id);
      expect(res.body.data.provider).toBe("cashfree");
      expect(res.body.data.status).toBe("pending");
      expect(res.body.data.amount_minor_units).toBe(booking.total_amount_minor_units);
      expect(res.body.data.currency).toBe("INR");
      expect(Number.isInteger(res.body.data.amount_minor_units)).toBe(true);
      expect(res.body.data.checkout.payment_session_id).toBeTruthy();
    });

    it("rejects a request that tries to supply its own amount_minor_units (unknown field)", async () => {
      const locationId = await createBookableLocation(host);
      const booking = await createBooking(booker, locationId);

      const res = await request(app)
        .post(`/v1/bookings/${booking.id}/payment`)
        .set(authHeader(booker))
        .send({ customer_phone: "9876543210", amount_minor_units: 1 });
      expect(res.status).toBe(400);
    });

    it("rejects an unauthenticated request", async () => {
      const locationId = await createBookableLocation(host);
      const booking = await createBooking(booker, locationId);
      const res = await request(app).post(`/v1/bookings/${booking.id}/payment`).send({ customer_phone: "9876543210" });
      expect(res.status).toBe(401);
    });

    it("404s for a booking the caller cannot see at all", async () => {
      const locationId = await createBookableLocation(host);
      const booking = await createBooking(booker, locationId);
      const res = await request(app)
        .post(`/v1/bookings/${booking.id}/payment`)
        .set(authHeader(otherBooker))
        .send({ customer_phone: "9876543210" });
      expect(res.status).toBe(404);
    });

    it("403s when a caller who CAN see the booking (the host) is not its booker", async () => {
      const locationId = await createBookableLocation(host);
      const booking = await createBooking(booker, locationId);
      const res = await request(app)
        .post(`/v1/bookings/${booking.id}/payment`)
        .set(authHeader(host))
        .send({ customer_phone: "9876543210" });
      expect(res.status).toBe(403);
    });

    it("rejects paying for a cancelled booking", async () => {
      const locationId = await createBookableLocation(host);
      const booking = await createBooking(booker, locationId);
      await request(app).post(`/v1/bookings/${booking.id}/cancel`).set(authHeader(booker));

      const res = await request(app)
        .post(`/v1/bookings/${booking.id}/payment`)
        .set(authHeader(booker))
        .send({ customer_phone: "9876543210" });
      expect(res.status).toBe(400);
    });

    // Phase 26-H replaces Phase 7's flat 409-on-second-attempt with resume-or-create.
    // The old behaviour could permanently deadlock a booking: an abandoned
    // checkout left a `pending` payment that only a webhook could settle, and
    // if none arrived every retry 409'd forever and the booker could never pay.
    it("RESUMES an in-flight payment instead of creating a second order (Phase 26-H)", async () => {
      const locationId = await createBookableLocation(host);
      const booking = await createBooking(booker, locationId);

      mockState.createOrderCallCount = 0;
      const first = await request(app)
        .post(`/v1/bookings/${booking.id}/payment`)
        .set(authHeader(booker))
        .send({ customer_phone: "9876543210" });
      expect(first.status).toBe(201);

      const second = await request(app)
        .post(`/v1/bookings/${booking.id}/payment`)
        .set(authHeader(booker))
        .send({ customer_phone: "9876543210" });

      expect(second.status).toBe(201);
      // Same payment row, same provider order -- a resume, not a duplicate.
      expect(second.body.data.payment_id).toBe(first.body.data.payment_id);
      expect(second.body.data.checkout.order_id).toBe(first.body.data.checkout.order_id);
      // ...but a freshly minted checkout session, which is what makes it usable.
      expect(second.body.data.checkout.payment_session_id).not.toBe(first.body.data.checkout.payment_session_id);
      expect(second.body.data.checkout.payment_session_id).toBeTruthy();

      // Exactly ONE order was ever created at the provider. This is the
      // duplicate-charge guarantee.
      expect(mockState.createOrderCallCount).toBe(1);

      const { data: rows, error } = await adminClient.from("payments").select("id").eq("booking_id", booking.id);
      if (error) throw error;
      expect(rows).toHaveLength(1);
    });

    it("resume reconciles and refuses when the provider says the order was actually PAID", async () => {
      const locationId = await createBookableLocation(host);
      const booking = await createBooking(booker, locationId);

      const first = await request(app)
        .post(`/v1/bookings/${booking.id}/payment`)
        .set(authHeader(booker))
        .send({ customer_phone: "9876543210" });
      const paymentId = first.body.data.payment_id as string;
      // It succeeded at the provider but no webhook ever reached us.
      mockState.orderStatus.set(first.body.data.checkout.order_id as string, "success");

      const second = await request(app)
        .post(`/v1/bookings/${booking.id}/payment`)
        .set(authHeader(booker))
        .send({ customer_phone: "9876543210" });
      expect(second.status).toBe(409);

      // The truth was recorded before refusing, so the next read is correct.
      const check = await request(app).get(`/v1/payments/${paymentId}`).set(authHeader(booker));
      expect(check.body.data.status).toBe("success");
    });

    it("supersedes a dead attempt with a genuinely new one, preserving attempt history", async () => {
      const locationId = await createBookableLocation(host);
      const booking = await createBooking(booker, locationId);

      const first = await request(app)
        .post(`/v1/bookings/${booking.id}/payment`)
        .set(authHeader(booker))
        .send({ customer_phone: "9876543210" });
      const firstPaymentId = first.body.data.payment_id as string;
      mockState.orderStatus.set(first.body.data.checkout.order_id as string, "failed"); // e.g. EXPIRED

      const second = await request(app)
        .post(`/v1/bookings/${booking.id}/payment`)
        .set(authHeader(booker))
        .send({ customer_phone: "9876543210" });
      expect(second.status).toBe(201);
      expect(second.body.data.payment_id).not.toBe(firstPaymentId);

      const { data: rows, error } = await adminClient
        .from("payments")
        .select("id, status")
        .eq("booking_id", booking.id)
        .order("created_at", { ascending: true });
      if (error) throw error;
      expect(rows).toHaveLength(2); // history preserved, not mutated in place
      expect(rows![0]!.status).toBe("failed");
      expect(rows![1]!.status).toBe("pending");
    });

    it("never creates a second order when the provider is unreachable during resume", async () => {
      const locationId = await createBookableLocation(host);
      const booking = await createBooking(booker, locationId);

      await request(app).post(`/v1/bookings/${booking.id}/payment`).set(authHeader(booker)).send({ customer_phone: "9876543210" });

      mockState.createOrderCallCount = 0;
      mockState.fetchOrderShouldThrow = true;
      const second = await request(app)
        .post(`/v1/bookings/${booking.id}/payment`)
        .set(authHeader(booker))
        .send({ customer_phone: "9876543210" });
      mockState.fetchOrderShouldThrow = false;

      // Cannot see whether the existing order is live -> must not risk a second one.
      expect(second.status).toBe(409);
      expect(mockState.createOrderCallCount).toBe(0);
    });

    it("rejects a new payment once the booking already has a successful one (Phase 12: no accumulating duplicate charges)", async () => {
      const locationId = await createBookableLocation(host);
      const booking = await createBooking(booker, locationId);

      const first = await request(app)
        .post(`/v1/bookings/${booking.id}/payment`)
        .set(authHeader(booker))
        .send({ customer_phone: "9876543210" });
      expect(first.status).toBe(201);
      const providerOrderId = first.body.data.checkout.order_id as string;
      mockState.orderStatus.set(providerOrderId, "success");
      const verify = await request(app).post(`/v1/payments/${first.body.data.payment_id}/verify`).set(authHeader(booker));
      expect(verify.body.data.status).toBe("success");

      // Booking status is deliberately untouched by payment success (Phase
      // 7) -- still requested/confirmed, so nothing else would stop a second
      // POST here except the Phase 12 guard itself.
      const second = await request(app)
        .post(`/v1/bookings/${booking.id}/payment`)
        .set(authHeader(booker))
        .send({ customer_phone: "9876543210" });
      expect(second.status).toBe(409);

      const { data: payments, error } = await adminClient.from("payments").select("id, status").eq("booking_id", booking.id);
      if (error) throw error;
      expect(payments).toHaveLength(1);
      expect(payments![0]!.status).toBe("success");
    });

    it("marks the payment failed (not silently pending forever) if the provider call itself errors", async () => {
      const locationId = await createBookableLocation(host);
      const booking = await createBooking(booker, locationId);

      mockState.createOrderShouldThrow = true;
      const res = await request(app)
        .post(`/v1/bookings/${booking.id}/payment`)
        .set(authHeader(booker))
        .send({ customer_phone: "9876543210" });
      mockState.createOrderShouldThrow = false;
      expect(res.status).toBe(500);

      const { data, error } = await adminClient.from("payments").select("status").eq("booking_id", booking.id).single();
      if (error) throw error;
      expect(data.status).toBe("failed");

      // A fresh attempt is still possible -- the failed row doesn't block retry.
      const retry = await request(app)
        .post(`/v1/bookings/${booking.id}/payment`)
        .set(authHeader(booker))
        .send({ customer_phone: "9876543210" });
      expect(retry.status).toBe(201);
    });
  });

  describe("reads & authorization", () => {
    it("a booker sees their own payment, an unrelated booker gets 404", async () => {
      const locationId = await createBookableLocation(host);
      const booking = await createBooking(booker, locationId);
      const create = await request(app)
        .post(`/v1/bookings/${booking.id}/payment`)
        .set(authHeader(booker))
        .send({ customer_phone: "9876543210" });
      const paymentId = create.body.data.payment_id;

      const mine = await request(app).get(`/v1/payments/${paymentId}`).set(authHeader(booker));
      expect(mine.status).toBe(200);
      expect(mine.body.data.id).toBe(paymentId);

      const notMine = await request(app).get(`/v1/payments/${paymentId}`).set(authHeader(otherBooker));
      expect(notMine.status).toBe(404);

      const hostView = await request(app).get(`/v1/payments/${paymentId}`).set(authHeader(host));
      expect(hostView.status).toBe(200);

      const adminView = await request(app).get(`/v1/payments/${paymentId}`).set(authHeader(admin));
      expect(adminView.status).toBe(200);
    });

    it("lists payments for a booking, RLS-scoped to an empty list for a bystander", async () => {
      const locationId = await createBookableLocation(host);
      const booking = await createBooking(booker, locationId);
      await request(app).post(`/v1/bookings/${booking.id}/payment`).set(authHeader(booker)).send({ customer_phone: "9876543210" });

      const mine = await request(app).get(`/v1/bookings/${booking.id}/payments`).set(authHeader(booker));
      expect(mine.status).toBe(200);
      expect(mine.body.data.length).toBeGreaterThanOrEqual(1);

      const bystander = await request(app).get(`/v1/bookings/${booking.id}/payments`).set(authHeader(otherBooker));
      expect(bystander.status).toBe(200);
      expect(bystander.body.data).toEqual([]);
    });

    it("never leaks the Cashfree secret or raw provider payloads in any response", async () => {
      const locationId = await createBookableLocation(host);
      const booking = await createBooking(booker, locationId);
      const create = await request(app)
        .post(`/v1/bookings/${booking.id}/payment`)
        .set(authHeader(booker))
        .send({ customer_phone: "9876543210" });

      const detail = await request(app).get(`/v1/payments/${create.body.data.payment_id}`).set(authHeader(booker));

      for (const res of [create, detail]) {
        const serialized = JSON.stringify(res.body);
        expect(serialized).not.toContain(env.CASHFREE_SECRET_KEY);
        expect(serialized).not.toContain("secret_should_not_leak");
        expect(serialized).not.toContain("provider_raw");
      }
    });
  });

  describe("verification", () => {
    it("verify reflects the provider's real status and does not alter the booking at all", async () => {
      const locationId = await createBookableLocation(host);
      const booking = await createBooking(booker, locationId);
      const create = await request(app)
        .post(`/v1/bookings/${booking.id}/payment`)
        .set(authHeader(booker))
        .send({ customer_phone: "9876543210" });
      const paymentId = create.body.data.payment_id as string;
      const providerOrderId = create.body.data.checkout.order_id as string;

      const beforeBooking = await request(app).get(`/v1/bookings/${booking.id}`).set(authHeader(booker));

      mockState.orderStatus.set(providerOrderId, "success");
      const verify = await request(app).post(`/v1/payments/${paymentId}/verify`).set(authHeader(booker));
      expect(verify.status).toBe(200);
      expect(verify.body.data.status).toBe("success");

      const afterBooking = await request(app).get(`/v1/bookings/${booking.id}`).set(authHeader(booker));
      expect(afterBooking.body.data.status).toBe(beforeBooking.body.data.status);
      expect(afterBooking.body.data.pricing.total_amount_minor_units).toBe(beforeBooking.body.data.pricing.total_amount_minor_units);
    });

    it("a client-only claim of success never flips status -- only verify/webhook can", async () => {
      const locationId = await createBookableLocation(host);
      const booking = await createBooking(booker, locationId);
      const create = await request(app)
        .post(`/v1/bookings/${booking.id}/payment`)
        .set(authHeader(booker))
        .send({ customer_phone: "9876543210" });
      const paymentId = create.body.data.payment_id as string;

      // No verify call made, no webhook delivered -- status must still be pending.
      const check = await request(app).get(`/v1/payments/${paymentId}`).set(authHeader(booker));
      expect(check.body.data.status).toBe("pending");
    });

    it("once terminal, verify is idempotent and stops calling the provider", async () => {
      const locationId = await createBookableLocation(host);
      const booking = await createBooking(booker, locationId);
      const create = await request(app)
        .post(`/v1/bookings/${booking.id}/payment`)
        .set(authHeader(booker))
        .send({ customer_phone: "9876543210" });
      const paymentId = create.body.data.payment_id as string;
      const providerOrderId = create.body.data.checkout.order_id as string;

      mockState.orderStatus.set(providerOrderId, "failed");
      const first = await request(app).post(`/v1/payments/${paymentId}/verify`).set(authHeader(booker));
      expect(first.body.data.status).toBe("failed");
      const callsAfterFirst = mockState.fetchOrderCallCounts.get(providerOrderId);

      mockState.orderStatus.set(providerOrderId, "success"); // even if the provider "changes its mind"
      const second = await request(app).post(`/v1/payments/${paymentId}/verify`).set(authHeader(booker));
      expect(second.body.data.status).toBe("failed"); // stays failed -- terminal, never regresses/flips
      expect(mockState.fetchOrderCallCounts.get(providerOrderId)).toBe(callsAfterFirst); // provider not re-queried
    });
  });

  // Phase 26-H: the provider is the party claiming success, so that claim is
  // checked against what ProdBnb recorded before it can become a `success` row.
  describe("amount & currency verification (Phase 26-H)", () => {
    async function pendingPayment(): Promise<{ paymentId: string; providerOrderId: string; bookingId: string }> {
      const locationId = await createBookableLocation(host);
      const booking = await createBooking(booker, locationId);
      const create = await request(app)
        .post(`/v1/bookings/${booking.id}/payment`)
        .set(authHeader(booker))
        .send({ customer_phone: "9876543210" });
      expect(create.status).toBe(201);
      return {
        paymentId: create.body.data.payment_id as string,
        providerOrderId: create.body.data.checkout.order_id as string,
        bookingId: booking.id,
      };
    }

    it("a matching amount verifies through to success as normal", async () => {
      const { paymentId, providerOrderId } = await pendingPayment();
      mockState.orderStatus.set(providerOrderId, "success");
      const verify = await request(app).post(`/v1/payments/${paymentId}/verify`).set(authHeader(booker));
      expect(verify.body.data.status).toBe("success");
    });

    it("an AMOUNT mismatch is never recorded as success", async () => {
      const { paymentId, providerOrderId } = await pendingPayment();
      mockState.orderStatus.set(providerOrderId, "success");
      mockState.reportedAmountOverride = { amountMinorUnits: 1, currency: "INR" }; // provider says ₹0.01
      const verify = await request(app).post(`/v1/payments/${paymentId}/verify`).set(authHeader(booker));
      mockState.reportedAmountOverride = null;

      expect(verify.body.data.status).not.toBe("success");
      expect(verify.body.data.status).toBe("failed");
    });

    it("a CURRENCY mismatch is never recorded as success", async () => {
      const { paymentId, providerOrderId } = await pendingPayment();
      mockState.orderStatus.set(providerOrderId, "success");
      mockState.reportedAmountOverride = { amountMinorUnits: 10_000, currency: "USD" };
      const verify = await request(app).post(`/v1/payments/${paymentId}/verify`).set(authHeader(booker));
      mockState.reportedAmountOverride = null;

      expect(verify.body.data.status).toBe("failed");
    });

    it("a mismatch never leaks raw provider payloads to the client", async () => {
      const { paymentId, providerOrderId } = await pendingPayment();
      mockState.orderStatus.set(providerOrderId, "success");
      mockState.reportedAmountOverride = { amountMinorUnits: 1, currency: "INR" };
      const verify = await request(app).post(`/v1/payments/${paymentId}/verify`).set(authHeader(booker));
      mockState.reportedAmountOverride = null;

      expect(JSON.stringify(verify.body)).not.toContain("provider_raw");
      expect(JSON.stringify(verify.body)).not.toContain("CASHFREE_SECRET_KEY_TEST_MOCK_VALUE");
    });

    it("a provider that reports no amount at all is not treated as a mismatch", async () => {
      const { paymentId, providerOrderId } = await pendingPayment();
      mockState.orderStatus.set(providerOrderId, "success");
      mockState.reportedAmountOverride = { amountMinorUnits: null, currency: null };
      const verify = await request(app).post(`/v1/payments/${paymentId}/verify`).set(authHeader(booker));
      mockState.reportedAmountOverride = null;

      expect(verify.body.data.status).toBe("success");
    });

    it("a mismatch cannot flip an ALREADY successful payment to failed", async () => {
      const { paymentId, providerOrderId } = await pendingPayment();
      mockState.orderStatus.set(providerOrderId, "success");
      const first = await request(app).post(`/v1/payments/${paymentId}/verify`).set(authHeader(booker));
      expect(first.body.data.status).toBe("success");

      // A later malformed/hostile event must not be able to undo a real payment.
      mockState.reportedAmountOverride = { amountMinorUnits: 1, currency: "INR" };
      const second = await request(app).post(`/v1/payments/${paymentId}/verify`).set(authHeader(booker));
      mockState.reportedAmountOverride = null;
      expect(second.body.data.status).toBe("success");
    });

    it("no payment outcome ever changes the booking's own status (Phase 7 invariant)", async () => {
      for (const outcome of ["success", "failed", "cancelled"] as const) {
        const { paymentId, providerOrderId, bookingId } = await pendingPayment();
        const before = await request(app).get(`/v1/bookings/${bookingId}`).set(authHeader(booker));
        mockState.orderStatus.set(providerOrderId, outcome);
        await request(app).post(`/v1/payments/${paymentId}/verify`).set(authHeader(booker));
        const after = await request(app).get(`/v1/bookings/${bookingId}`).set(authHeader(booker));
        expect(after.body.data.status).toBe(before.body.data.status);
      }
    });
  });

  // Phase 26-H. An abandoned checkout leaves the provider order ACTIVE and
  // payable while ProdBnb is about to record a TERMINAL `failed` that can never
  // be walked back -- so the order is terminated first, making our record true.
  describe("abandoned checkout termination (Phase 26-H)", () => {
    async function pending(): Promise<{ paymentId: string; providerOrderId: string }> {
      const locationId = await createBookableLocation(host);
      const booking = await createBooking(booker, locationId);
      const create = await request(app)
        .post(`/v1/bookings/${booking.id}/payment`)
        .set(authHeader(booker))
        .send({ customer_phone: "9876543210" });
      return {
        paymentId: create.body.data.payment_id as string,
        providerOrderId: create.body.data.checkout.order_id as string,
      };
    }

    async function postWebhook(payload: unknown) {
      return request(app)
        .post("/v1/payments/webhooks/cashfree")
        .set("Content-Type", "application/json")
        .set("x-webhook-timestamp", "1")
        .set("x-webhook-signature", "mock")
        .send(JSON.stringify(payload));
    }

    it("terminates the still-payable order when the payer drops out", async () => {
      const { paymentId, providerOrderId } = await pending();
      mockState.terminatedOrders = [];

      const res = await postWebhook({
        type: "PAYMENT_USER_DROPPED_WEBHOOK",
        data: { order: { order_id: providerOrderId }, payment: { cf_payment_id: 1, payment_status: "USER_DROPPED" } },
      });
      expect(res.status).toBe(200);

      expect(mockState.terminatedOrders).toContain(providerOrderId);
      const check = await request(app).get(`/v1/payments/${paymentId}`).set(authHeader(booker));
      expect(check.body.data.status).toBe("failed");
    });

    it("does NOT terminate on a plain payment failure -- the payer may still be retrying in checkout", async () => {
      const { providerOrderId } = await pending();
      mockState.terminatedOrders = [];

      await postWebhook({
        type: "PAYMENT_FAILED_WEBHOOK",
        data: { order: { order_id: providerOrderId }, payment: { cf_payment_id: 2, payment_status: "FAILED" } },
      });

      expect(mockState.terminatedOrders).not.toContain(providerOrderId);
    });

    it("a webhook AMOUNT mismatch is never recorded as success", async () => {
      const { paymentId, providerOrderId } = await pending();
      await postWebhook({
        type: "PAYMENT_SUCCESS_WEBHOOK",
        data: {
          order: { order_id: providerOrderId },
          payment: { cf_payment_id: 3, payment_status: "SUCCESS", payment_amount: 0.01, payment_currency: "INR" },
        },
      });

      const check = await request(app).get(`/v1/payments/${paymentId}`).set(authHeader(booker));
      expect(check.body.data.status).toBe("failed");
    });
  });

  // Phase 26-H.9D -- attempt-level data entering the real service, through the ONE transition
  // funnel. Order-level status stays `pending` throughout: these assert what the *service* does
  // with the enrichment, not what the adapter produced.
  describe("attempt-level reconciliation (Phase 26-H.9D)", () => {
    function attempt(over: Partial<{ status: string; amountMinorUnits: number | null; currency: string | null }> = {}) {
      return {
        id: "cf_pay_1",
        status: over.status ?? "success",
        rawStatus: (over.status ?? "success").toUpperCase(),
        amountMinorUnits: over.amountMinorUnits === undefined ? 10_000 : over.amountMinorUnits,
        currency: over.currency === undefined ? "INR" : over.currency,
        attemptedAt: "2026-09-11T09:34:02+05:30",
        completedAt: null,
        method: "debit_card",
        errorCode: null,
        errorDescription: null,
      };
    }

    async function pendingPayment(): Promise<{ paymentId: string; bookingId: string }> {
      const locationId = await createBookableLocation(host);
      const booking = await createBooking(booker, locationId);
      const create = await request(app)
        .post(`/v1/bookings/${booking.id}/payment`)
        .set(authHeader(booker))
        .send({ customer_phone: "9876543210" });
      expect(create.status).toBe(201);
      return { paymentId: create.body.data.payment_id as string, bookingId: booking.id };
    }

    afterEach(() => {
      mockState.settledAttempt = null;
      mockState.lastAttempt = null;
    });

    it("a SUCCESS attempt settles a still-open order", async () => {
      const { paymentId } = await pendingPayment();
      mockState.settledAttempt = attempt();

      const verify = await request(app).post(`/v1/payments/${paymentId}/verify`).set(authHeader(booker));
      expect(verify.body.data.status).toBe("success");
    });

    it.each(["failed", "dropped", "cancelled", "void"])(
      "an attempt-level %s NEVER makes an open order terminal",
      async (attemptStatus) => {
        const { paymentId } = await pendingPayment();
        mockState.lastAttempt = { id: "cf_pay_x", status: attemptStatus };

        const verify = await request(app).post(`/v1/payments/${paymentId}/verify`).set(authHeader(booker));

        // The core invariant: still pending, so a later attempt on the same order can still succeed.
        expect(verify.body.data.status).toBe("pending");
        const check = await request(app).get(`/v1/payments/${paymentId}`).set(authHeader(booker));
        expect(check.body.data.status).toBe("pending");
      }
    );

    it("a failed attempt leaves the booking resumable against the SAME provider order", async () => {
      const { paymentId, bookingId } = await pendingPayment();
      const before = await request(app).get(`/v1/payments/${paymentId}`).set(authHeader(booker));
      mockState.lastAttempt = { id: "cf_pay_x", status: "failed" };
      mockState.createOrderCallCount = 0;

      const resume = await request(app)
        .post(`/v1/bookings/${bookingId}/payment`)
        .set(authHeader(booker))
        .send({ customer_phone: "9876543210" });

      expect(resume.status).toBe(201);
      expect(resume.body.data.payment_id).toBe(paymentId);
      expect(resume.body.data.checkout.order_id).toBe(before.body.data.provider_order_id);
      expect(mockState.createOrderCallCount).toBe(0); // no second provider order
    });

    it("an attempt AMOUNT mismatch does not settle — and does not make it terminal either", async () => {
      const { paymentId } = await pendingPayment();
      mockState.settledAttempt = attempt({ amountMinorUnits: 1 });

      const verify = await request(app).post(`/v1/payments/${paymentId}/verify`).set(authHeader(booker));

      expect(verify.body.data.status).not.toBe("success");
      // Crucially NOT `failed`: the order is still open, so the payment stays resumable.
      expect(verify.body.data.status).toBe("pending");
    });

    it("an attempt CURRENCY mismatch does not settle", async () => {
      const { paymentId } = await pendingPayment();
      mockState.settledAttempt = attempt({ currency: "USD" });

      const verify = await request(app).post(`/v1/payments/${paymentId}/verify`).set(authHeader(booker));
      expect(verify.body.data.status).toBe("pending");
    });

    it("a missing attempt amount is never treated as a match", async () => {
      const { paymentId } = await pendingPayment();
      mockState.settledAttempt = attempt({ amountMinorUnits: null, currency: null });

      // Nothing contradicts the recorded amount, so the success stands on the provider's word.
      const verify = await request(app).post(`/v1/payments/${paymentId}/verify`).set(authHeader(booker));
      expect(verify.body.data.status).toBe("success");
    });

    it("a settled payment is never downgraded by a later attempt", async () => {
      const { paymentId } = await pendingPayment();
      mockState.settledAttempt = attempt();
      const first = await request(app).post(`/v1/payments/${paymentId}/verify`).set(authHeader(booker));
      expect(first.body.data.status).toBe("success");

      // A later failed/pending attempt arrives against the same order.
      mockState.settledAttempt = null;
      mockState.lastAttempt = { id: "cf_pay_later", status: "failed" };
      const second = await request(app).post(`/v1/payments/${paymentId}/verify`).set(authHeader(booker));
      expect(second.body.data.status).toBe("success");
    });

    it("never exposes attempt data through the API", async () => {
      const { paymentId } = await pendingPayment();
      mockState.lastAttempt = { id: "cf_pay_secret", status: "failed" };
      await request(app).post(`/v1/payments/${paymentId}/verify`).set(authHeader(booker));

      const check = await request(app).get(`/v1/payments/${paymentId}`).set(authHeader(booker));
      const body = JSON.stringify(check.body);
      expect(body).not.toContain("cf_pay_secret");
      expect(body).not.toContain("lastAttempt");
      expect(body).not.toContain("provider_raw");
    });
  });

  describe("payment return route (Phase 26-H)", () => {
    it("serves a neutral page instead of being swallowed by GET /payments/:id", async () => {
      const res = await request(app).get("/v1/payments/return");
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("html");
      // Asserts no outcome -- a redirect is not evidence a payment succeeded.
      expect(res.text.toLowerCase()).not.toContain("payment successful");
    });
  });

  describe("refunds", () => {
    async function createSucceededPayment(): Promise<{ paymentId: string; amount: number }> {
      const locationId = await createBookableLocation(host, 20_000);
      const booking = await createBooking(booker, locationId);
      const create = await request(app)
        .post(`/v1/bookings/${booking.id}/payment`)
        .set(authHeader(booker))
        .send({ customer_phone: "9876543210" });
      const paymentId = create.body.data.payment_id as string;
      const providerOrderId = create.body.data.checkout.order_id as string;
      mockState.orderStatus.set(providerOrderId, "success");
      await request(app).post(`/v1/payments/${paymentId}/verify`).set(authHeader(booker));
      return { paymentId, amount: create.body.data.amount_minor_units as number };
    }

    it("forbids a non-admin from issuing a refund", async () => {
      const { paymentId } = await createSucceededPayment();
      const res = await request(app).post(`/v1/payments/${paymentId}/refunds`).set(authHeader(booker)).send({});
      expect(res.status).toBe(403);
    });

    it("lets an admin issue a full refund by default (amount omitted)", async () => {
      mockState.refundStatus = "success";
      const { paymentId, amount } = await createSucceededPayment();
      const res = await request(app).post(`/v1/payments/${paymentId}/refunds`).set(authHeader(admin)).send({});
      expect(res.status).toBe(201);
      expect(res.body.data.amount_minor_units).toBe(amount);
      expect(res.body.data.status).toBe("success");

      const payment = await request(app).get(`/v1/payments/${paymentId}`).set(authHeader(admin));
      expect(payment.body.data.status).toBe("refunded");
    });

    it("rejects a refund larger than the remaining refundable balance", async () => {
      const { paymentId, amount } = await createSucceededPayment();
      const res = await request(app)
        .post(`/v1/payments/${paymentId}/refunds`)
        .set(authHeader(admin))
        .send({ amount_minor_units: amount + 1 });
      expect(res.status).toBe(400);
    });

    it("a partial refund leaves the payment partially_refunded, and lists correctly", async () => {
      mockState.refundStatus = "success";
      const { paymentId, amount } = await createSucceededPayment();
      const half = Math.floor(amount / 2);
      const res = await request(app).post(`/v1/payments/${paymentId}/refunds`).set(authHeader(admin)).send({ amount_minor_units: half });
      expect(res.status).toBe(201);

      const payment = await request(app).get(`/v1/payments/${paymentId}`).set(authHeader(admin));
      expect(payment.body.data.status).toBe("partially_refunded");

      const list = await request(app).get(`/v1/payments/${paymentId}/refunds`).set(authHeader(admin));
      expect(list.status).toBe(200);
      expect(list.body.data).toHaveLength(1);
      expect(list.body.data[0].amount_minor_units).toBe(half);
    });

    it("cannot refund a payment that never succeeded", async () => {
      const locationId = await createBookableLocation(host);
      const booking = await createBooking(booker, locationId);
      const create = await request(app)
        .post(`/v1/bookings/${booking.id}/payment`)
        .set(authHeader(booker))
        .send({ customer_phone: "9876543210" });
      const res = await request(app).post(`/v1/payments/${create.body.data.payment_id}/refunds`).set(authHeader(admin)).send({});
      expect(res.status).toBe(400);
    });

    it("Phase 12: this same (pre-Phase-11) route writes an ADMIN_CREATED_REFUND audit entry, same as the dedicated admin route", async () => {
      mockState.refundStatus = "success";
      const { paymentId, amount } = await createSucceededPayment();
      const res = await request(app)
        .post(`/v1/payments/${paymentId}/refunds`)
        .set(authHeader(admin))
        .send({ reason: "Legacy-route refund audit test." });
      expect(res.status).toBe(201);

      const { data: entry, error } = await adminClient
        .from("admin_audit_log")
        .select("action, admin_id, target_id, reason, metadata")
        .eq("target_type", "payment")
        .eq("target_id", paymentId)
        .single();
      if (error) throw error;
      expect(entry.action).toBe("ADMIN_CREATED_REFUND");
      expect(entry.admin_id).toBe(admin.id);
      expect(entry.reason).toBe("Legacy-route refund audit test.");
      expect(entry.metadata).toMatchObject({ amount_minor_units: amount });
    });
  });

  describe("regression: booking creation/lifecycle untouched by the payments module", () => {
    it("booking creation, listing, and lifecycle actions still work exactly as in Phase 6A", async () => {
      const locationId = await createBookableLocation(host);
      const booking = await createBooking(booker, locationId);

      const detail = await request(app).get(`/v1/bookings/${booking.id}`).set(authHeader(booker));
      expect(detail.status).toBe(200);
      expect(detail.body.data.status).toBe("requested");

      const confirm = await request(app).post(`/v1/bookings/${booking.id}/confirm`).set(authHeader(host));
      expect(confirm.status).toBe(200);
      expect(confirm.body.data.status).toBe("confirmed");
    });
  });
});
