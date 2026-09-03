import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Mirrors tests/media.test.ts's approach to mocking src/lib/r2 -- the
// Cashfree ADAPTER is mocked here (no real network calls), while
// tests/payments-webhooks.test.ts leaves CashfreeProvider un-mocked, since
// webhook signature verification is pure local HMAC computation with no
// network involved and deserves real coverage.
const mockState = vi.hoisted(() => ({
  orderStatus: new Map<string, "pending" | "success" | "failed" | "cancelled">(),
  fetchStatusCallCounts: new Map<string, number>(),
  refundStatus: "success" as "pending" | "success" | "failed",
  createOrderShouldThrow: false,
}));

vi.mock("../src/modules/payments/providers/CashfreeProvider", () => ({
  CashfreeProvider: class {
    name = "cashfree" as const;

    async createOrder(input: { merchantOrderId: string }) {
      if (mockState.createOrderShouldThrow) {
        throw new Error("simulated Cashfree outage");
      }
      mockState.orderStatus.set(input.merchantOrderId, "pending");
      return {
        providerReferenceId: `cf_${input.merchantOrderId}`,
        status: "pending" as const,
        checkout: { payment_session_id: `session_${input.merchantOrderId}`, order_id: input.merchantOrderId },
        raw: { mocked: true, secret_should_not_leak: "CASHFREE_SECRET_KEY_TEST_MOCK_VALUE" },
      };
    }

    async fetchOrderStatus(providerOrderId: string) {
      mockState.fetchStatusCallCounts.set(providerOrderId, (mockState.fetchStatusCallCounts.get(providerOrderId) ?? 0) + 1);
      const status = mockState.orderStatus.get(providerOrderId) ?? "pending";
      return { status, providerReferenceId: `cf_${providerOrderId}`, raw: { mocked: true } };
    }

    async createRefund(input: { merchantRefundId: string }) {
      return { providerReferenceId: `cf_${input.merchantRefundId}`, status: mockState.refundStatus, raw: { mocked: true } };
    }

    verifyAndParseWebhook(): never {
      throw new Error("not used by tests/payments.test.ts");
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

    it("rejects a second in-flight payment for the same booking", async () => {
      const locationId = await createBookableLocation(host);
      const booking = await createBooking(booker, locationId);

      const first = await request(app)
        .post(`/v1/bookings/${booking.id}/payment`)
        .set(authHeader(booker))
        .send({ customer_phone: "9876543210" });
      expect(first.status).toBe(201);

      const second = await request(app)
        .post(`/v1/bookings/${booking.id}/payment`)
        .set(authHeader(booker))
        .send({ customer_phone: "9876543210" });
      expect(second.status).toBe(409);
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
      const callsAfterFirst = mockState.fetchStatusCallCounts.get(providerOrderId);

      mockState.orderStatus.set(providerOrderId, "success"); // even if the provider "changes its mind"
      const second = await request(app).post(`/v1/payments/${paymentId}/verify`).set(authHeader(booker));
      expect(second.body.data.status).toBe("failed"); // stays failed -- terminal, never regresses/flips
      expect(mockState.fetchStatusCallCounts.get(providerOrderId)).toBe(callsAfterFirst); // provider not re-queried
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
