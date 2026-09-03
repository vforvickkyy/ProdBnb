import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Mirrors tests/payments.test.ts's mocking approach exactly.
const mockState = vi.hoisted(() => ({
  orderStatus: new Map<string, "pending" | "success" | "failed">(),
  refundStatus: "success" as "pending" | "success" | "failed",
}));

vi.mock("../src/modules/payments/providers/CashfreeProvider", () => ({
  CashfreeProvider: class {
    name = "cashfree" as const;
    async createOrder(input: { merchantOrderId: string }) {
      mockState.orderStatus.set(input.merchantOrderId, "pending");
      return {
        providerReferenceId: `cf_${input.merchantOrderId}`,
        status: "pending" as const,
        checkout: { payment_session_id: `session_${input.merchantOrderId}`, order_id: input.merchantOrderId },
        raw: { mocked: true, secret_should_not_leak: "SHOULD_NOT_APPEAR" },
      };
    }
    async fetchOrderStatus(providerOrderId: string) {
      const status = mockState.orderStatus.get(providerOrderId) ?? "pending";
      return { status, providerReferenceId: `cf_${providerOrderId}`, raw: { mocked: true } };
    }
    async createRefund(input: { merchantRefundId: string }) {
      return { providerReferenceId: `cf_${input.merchantRefundId}`, status: mockState.refundStatus, raw: { mocked: true } };
    }
    verifyAndParseWebhook(): never {
      throw new Error("not used by tests/admin-payments.test.ts");
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

async function grantAdmin(user: TestUser): Promise<void> {
  const { error } = await adminClient.from("user_roles").insert({ user_id: user.id, role: "admin" });
  if (error) throw error;
}

async function publish(locationId: string): Promise<void> {
  const { error } = await adminClient.from("locations").update({ status: "published" }).eq("id", locationId);
  if (error) throw error;
}

let hour = 9;
async function createPaidBooking(host: TestUser, booker: TestUser): Promise<{ paymentId: string; bookingId: string; amount: number }> {
  const loc = await request(app)
    .post("/v1/locations")
    .set(authHeader(host))
    .send({ title: "Admin Payment Test Location", city: "London", country: "UK" });
  const locationId = loc.body.data.id as string;
  await request(app)
    .post(`/v1/locations/${locationId}/availability/rules`)
    .set(authHeader(host))
    .send({ day_of_week: "monday", start_time: "09:00", end_time: "18:00" });
  await request(app)
    .post(`/v1/locations/${locationId}/pricing`)
    .set(authHeader(host))
    .send({ booking_type: "hourly", amount_minor_units: 10000 });
  await publish(locationId);

  const h = hour++;
  const booking = await request(app)
    .post("/v1/bookings")
    .set(authHeader(booker))
    .send({
      location_id: locationId,
      start_at: `2026-10-05T${String(h).padStart(2, "0")}:00:00Z`,
      end_at: `2026-10-05T${String(h + 1).padStart(2, "0")}:00:00Z`,
    });
  const bookingId = booking.body.data.id as string;

  const create = await request(app)
    .post(`/v1/bookings/${bookingId}/payment`)
    .set(authHeader(booker))
    .send({ customer_phone: "9876543210" });
  const paymentId = create.body.data.payment_id as string;
  const providerOrderId = create.body.data.checkout.order_id as string;
  mockState.orderStatus.set(providerOrderId, "success");
  await request(app).post(`/v1/payments/${paymentId}/verify`).set(authHeader(booker));

  return { paymentId, bookingId, amount: create.body.data.amount_minor_units as number };
}

describe("admin: payments & refunds", () => {
  let admin: TestUser;
  let booker: TestUser;
  let host: TestUser;

  beforeAll(async () => {
    admin = await createTestUser();
    booker = await createTestUser();
    host = await createTestUser();
    await grantAdmin(admin);
    await grantRole(booker, "booker");
    await grantRole(host, "host");
  });

  afterAll(async () => {
    await deleteTestUser(admin.id);
    await deleteTestUser(booker.id);
    await deleteTestUser(host.id);
  });

  describe("authorization", () => {
    it("rejects booker/host from every admin payment endpoint, admin succeeds", async () => {
      for (const nonAdmin of [booker, host]) {
        const payments = await request(app).get("/v1/admin/payments").set(authHeader(nonAdmin));
        expect(payments.status).toBe(403);
        const refunds = await request(app).get("/v1/admin/refunds").set(authHeader(nonAdmin));
        expect(refunds.status).toBe(403);
      }
      const res = await request(app).get("/v1/admin/payments").set(authHeader(admin));
      expect(res.status).toBe(200);
    });
  });

  describe("listing", () => {
    it("lists every payment regardless of owner, filterable by status/booking_id", async () => {
      const { paymentId, bookingId } = await createPaidBooking(host, booker);

      const all = await request(app).get("/v1/admin/payments").set(authHeader(admin)).query({ pageSize: 100 });
      expect(all.body.data.map((p: { id: string }) => p.id)).toContain(paymentId);

      const filtered = await request(app)
        .get("/v1/admin/payments")
        .set(authHeader(admin))
        .query({ booking_id: bookingId, status: "success" });
      expect(filtered.body.data.map((p: { id: string }) => p.id)).toContain(paymentId);

      const detail = await request(app).get(`/v1/admin/payments/${paymentId}`).set(authHeader(admin));
      expect(detail.status).toBe(200);
      expect(detail.body.data.status).toBe("success");
    });

    it("never leaks the Cashfree secret or raw provider payloads through any admin response", async () => {
      const { paymentId } = await createPaidBooking(host, booker);
      const list = await request(app).get("/v1/admin/payments").set(authHeader(admin));
      const detail = await request(app).get(`/v1/admin/payments/${paymentId}`).set(authHeader(admin));
      for (const res of [list, detail]) {
        const serialized = JSON.stringify(res.body);
        expect(serialized).not.toContain(env.CASHFREE_SECRET_KEY);
        expect(serialized).not.toContain("SHOULD_NOT_APPEAR");
        expect(serialized).not.toContain("provider_raw");
      }
    });
  });

  describe("admin-created refunds", () => {
    it("issues a refund through the existing PaymentService (not Cashfree directly) and writes an audit entry", async () => {
      mockState.refundStatus = "success";
      const { paymentId, amount } = await createPaidBooking(host, booker);

      const refund = await request(app).post(`/v1/admin/payments/${paymentId}/refunds`).set(authHeader(admin)).send({});
      expect(refund.status).toBe(201);
      expect(refund.body.data.amount_minor_units).toBe(amount);

      const payment = await request(app).get(`/v1/admin/payments/${paymentId}`).set(authHeader(admin));
      expect(payment.body.data.status).toBe("refunded");

      const list = await request(app).get("/v1/admin/refunds").set(authHeader(admin)).query({ status: "success" });
      expect(list.body.data.map((r: { id: string }) => r.id)).toContain(refund.body.data.id);

      const audit = await request(app)
        .get("/v1/admin/audit-log")
        .set(authHeader(admin))
        .query({ target_type: "payment", target_id: paymentId });
      expect(audit.body.data).toHaveLength(1);
      expect(audit.body.data[0].action).toBe("ADMIN_CREATED_REFUND");
      expect(audit.body.data[0].admin_id).toBe(admin.id);
    });

    it("a non-admin cannot create a refund via the admin route", async () => {
      const { paymentId } = await createPaidBooking(host, booker);
      const res = await request(app).post(`/v1/admin/payments/${paymentId}/refunds`).set(authHeader(booker)).send({});
      expect(res.status).toBe(403);
    });
  });
});
