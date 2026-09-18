import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Mirrors tests/payments.test.ts's mocking approach -- payment/refund
// integration tests below need a payment to actually reach success/failed,
// which means mocking Cashfree's network calls exactly the same way.
const mockState = vi.hoisted(() => ({
  orderStatus: new Map<string, "pending" | "success" | "failed">(),
  orderAmounts: new Map<string, { amountMinorUnits: number; currency: string }>(),
  refundStatus: "success" as "pending" | "success" | "failed",
}));

vi.mock("../src/modules/payments/providers/CashfreeProvider", () => ({
  CashfreeProvider: class {
    name = "cashfree" as const;
    async createOrder(input: { merchantOrderId: string; amountMinorUnits: number; currency: string }) {
      mockState.orderStatus.set(input.merchantOrderId, "pending");
      mockState.orderAmounts.set(input.merchantOrderId, {
        amountMinorUnits: input.amountMinorUnits,
        currency: input.currency,
      });
      return {
        providerReferenceId: `cf_${input.merchantOrderId}`,
        status: "pending" as const,
        checkout: { payment_session_id: `session_${input.merchantOrderId}`, order_id: input.merchantOrderId },
        raw: { mocked: true },
      };
    }
    async fetchOrder(providerOrderId: string) {
      const status = mockState.orderStatus.get(providerOrderId) ?? "pending";
      const recorded = mockState.orderAmounts.get(providerOrderId);
      return {
        status,
        providerReferenceId: `cf_${providerOrderId}`,
        checkout: { payment_session_id: `session_${providerOrderId}`, order_id: providerOrderId },
        // Reports what was actually recorded, so Phase 26-H's amount/currency
        // verification passes exactly as it does against the real provider.
        amountMinorUnits: recorded?.amountMinorUnits ?? null,
        currency: recorded?.currency ?? null,
        raw: { mocked: true },
      };
    }
    async terminateOrder(providerOrderId: string) {
      mockState.orderStatus.set(providerOrderId, "cancelled");
    }
    async createRefund(input: { merchantRefundId: string }) {
      return { providerReferenceId: `cf_${input.merchantRefundId}`, status: mockState.refundStatus, raw: { mocked: true } };
    }
    verifyAndParseWebhook(): never {
      throw new Error("not used by tests/notifications.test.ts");
    }
  },
}));

import { createApp } from "../src/app";
import { notifyBookingConfirmed } from "../src/modules/notifications/notification.service";
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

const MON = "2026-10-05";
// Resets per location (not a single file-wide counter) -- each test calls
// createBookableLocation() to get its own fresh, independent location, so
// there's no cross-location interval conflict in reusing hour 9 each time.
let nextHour = 9;

async function createBookableLocation(owner: TestUser, opts: { instant?: boolean } = {}): Promise<string> {
  const res = await request(app)
    .post("/v1/locations")
    .set(authHeader(owner))
    .send({ title: "Notif Test Location", city: "London", country: "UK", instant_booking_enabled: opts.instant ?? false });
  expect(res.status).toBe(201);
  const locationId = res.body.data.id as string;
  await addRule(locationId, owner, "monday", "09:00", "18:00");
  await addHourlyPricing(locationId, owner);
  await publish(locationId);
  nextHour = 9;
  return locationId;
}

async function createBooking(booker: TestUser, locationId: string): Promise<{ id: string }> {
  const hour = nextHour++;
  const res = await request(app)
    .post("/v1/bookings")
    .set(authHeader(booker))
    .send({
      location_id: locationId,
      start_at: `${MON}T${String(hour).padStart(2, "0")}:00:00Z`,
      end_at: `${MON}T${String(hour + 1).padStart(2, "0")}:00:00Z`,
    });
  expect(res.status).toBe(201);
  return { id: res.body.data.id as string };
}

async function notificationsFor(user: TestUser, type?: string) {
  const res = await request(app).get("/v1/notifications").set(authHeader(user)).query({ pageSize: 100 });
  expect(res.status).toBe(200);
  return type ? res.body.data.filter((n: { type: string }) => n.type === type) : res.body.data;
}

describe("notifications", () => {
  let host: TestUser;
  let booker: TestUser;
  let otherBooker: TestUser;

  beforeAll(async () => {
    host = await createTestUser();
    booker = await createTestUser();
    otherBooker = await createTestUser();
    await grantRole(host, "host");
    await grantRole(booker, "booker");
    await grantRole(otherBooker, "booker");
  });

  afterAll(async () => {
    await deleteTestUser(host.id);
    await deleteTestUser(booker.id);
    await deleteTestUser(otherBooker.id);
  });

  describe("booking lifecycle integration", () => {
    it("createBooking notifies the host with booking_request_received", async () => {
      const locationId = await createBookableLocation(host);
      const booking = await createBooking(booker, locationId);

      const hostNotifs = await notificationsFor(host, "booking_request_received");
      expect(hostNotifs.some((n: { entity_id: string }) => n.entity_id === booking.id)).toBe(true);
    });

    it("confirmBooking notifies the booker with booking_confirmed", async () => {
      const locationId = await createBookableLocation(host);
      const booking = await createBooking(booker, locationId);
      await request(app).post(`/v1/bookings/${booking.id}/confirm`).set(authHeader(host));

      const bookerNotifs = await notificationsFor(booker, "booking_confirmed");
      expect(bookerNotifs.some((n: { entity_id: string }) => n.entity_id === booking.id)).toBe(true);
    });

    it("an instant-booking location fires BOTH booking_request_received (host) and booking_confirmed (booker) at creation", async () => {
      const locationId = await createBookableLocation(host, { instant: true });
      const booking = await createBooking(booker, locationId);

      const hostNotifs = await notificationsFor(host, "booking_request_received");
      expect(hostNotifs.some((n: { entity_id: string }) => n.entity_id === booking.id)).toBe(true);
      const bookerNotifs = await notificationsFor(booker, "booking_confirmed");
      expect(bookerNotifs.some((n: { entity_id: string }) => n.entity_id === booking.id)).toBe(true);
    });

    it("rejectBooking notifies the booker with booking_declined", async () => {
      const locationId = await createBookableLocation(host);
      const booking = await createBooking(booker, locationId);
      await request(app).post(`/v1/bookings/${booking.id}/reject`).set(authHeader(host));

      const bookerNotifs = await notificationsFor(booker, "booking_declined");
      expect(bookerNotifs.some((n: { entity_id: string }) => n.entity_id === booking.id)).toBe(true);
    });

    it("cancelBooking by the booker notifies the host; by the host notifies the booker", async () => {
      const locationId = await createBookableLocation(host);

      const byBooker = await createBooking(booker, locationId);
      await request(app).post(`/v1/bookings/${byBooker.id}/cancel`).set(authHeader(booker));
      const hostNotifs = await notificationsFor(host, "booking_cancelled");
      expect(hostNotifs.some((n: { entity_id: string }) => n.entity_id === byBooker.id)).toBe(true);

      const byHost = await createBooking(booker, locationId);
      await request(app).post(`/v1/bookings/${byHost.id}/cancel`).set(authHeader(host));
      const bookerNotifs = await notificationsFor(booker, "booking_cancelled");
      expect(bookerNotifs.some((n: { entity_id: string }) => n.entity_id === byHost.id)).toBe(true);
    });
  });

  describe("payment/refund integration", () => {
    it("a payment reaching success notifies the booker with payment_success", async () => {
      const locationId = await createBookableLocation(host);
      const booking = await createBooking(booker, locationId);
      const create = await request(app)
        .post(`/v1/bookings/${booking.id}/payment`)
        .set(authHeader(booker))
        .send({ customer_phone: "9876543210" });
      const providerOrderId = create.body.data.checkout.order_id as string;
      mockState.orderStatus.set(providerOrderId, "success");
      await request(app).post(`/v1/payments/${create.body.data.payment_id}/verify`).set(authHeader(booker));

      const notifs = await notificationsFor(booker, "payment_success");
      expect(notifs.some((n: { entity_id: string }) => n.entity_id === booking.id)).toBe(true);
    });

    it("a payment reaching failed notifies the booker with payment_failed", async () => {
      const locationId = await createBookableLocation(host);
      const booking = await createBooking(booker, locationId);
      const create = await request(app)
        .post(`/v1/bookings/${booking.id}/payment`)
        .set(authHeader(booker))
        .send({ customer_phone: "9876543210" });
      const providerOrderId = create.body.data.checkout.order_id as string;
      mockState.orderStatus.set(providerOrderId, "failed");
      await request(app).post(`/v1/payments/${create.body.data.payment_id}/verify`).set(authHeader(booker));

      const notifs = await notificationsFor(booker, "payment_failed");
      expect(notifs.some((n: { entity_id: string }) => n.entity_id === booking.id)).toBe(true);
    });

    it("a full refund notifies the booker with refund_processed", async () => {
      mockState.refundStatus = "success";
      const locationId = await createBookableLocation(host);
      const booking = await createBooking(booker, locationId);
      const create = await request(app)
        .post(`/v1/bookings/${booking.id}/payment`)
        .set(authHeader(booker))
        .send({ customer_phone: "9876543210" });
      const providerOrderId = create.body.data.checkout.order_id as string;
      mockState.orderStatus.set(providerOrderId, "success");
      await request(app).post(`/v1/payments/${create.body.data.payment_id}/verify`).set(authHeader(booker));

      const admin = await createTestUser();
      await adminClient.from("user_roles").insert({ user_id: admin.id, role: "admin" });
      await request(app).post(`/v1/payments/${create.body.data.payment_id}/refunds`).set(authHeader(admin)).send({});
      await deleteTestUser(admin.id);

      const notifs = await notificationsFor(booker, "refund_processed");
      expect(notifs.some((n: { entity_id: string }) => n.entity_id === booking.id)).toBe(true);
    });
  });

  describe("idempotency & multi-device fan-out", () => {
    it("calling the same notify event twice produces exactly one notification row", async () => {
      const locationId = await createBookableLocation(host);
      const booking = await createBooking(booker, locationId);

      await notifyBookingConfirmed(booker.id, booking.id);
      await notifyBookingConfirmed(booker.id, booking.id);

      const { data, error } = await adminClient
        .from("notifications")
        .select("id")
        .eq("user_id", booker.id)
        .eq("entity_id", booking.id)
        .eq("type", "booking_confirmed");
      if (error) throw error;
      // Both direct calls share the same deterministic source_event_id
      // ("booking:<id>:booking_confirmed") -- the second insert collides
      // with the first and is silently dropped, exactly one row survives.
      expect(data).toHaveLength(1);
    });

    it("a user with two active devices gets one delivery attempt per device, not duplicated", async () => {
      await request(app).post("/v1/devices").set(authHeader(host)).send({ device_token: "tok-fanout-1", platform: "ios" });
      await request(app).post("/v1/devices").set(authHeader(host)).send({ device_token: "tok-fanout-2", platform: "android" });

      const locationId = await createBookableLocation(host);
      const booking = await createBooking(booker, locationId);

      const { data: notif, error } = await adminClient
        .from("notifications")
        .select("id")
        .eq("user_id", host.id)
        .eq("entity_id", booking.id)
        .eq("type", "booking_request_received")
        .single();
      if (error) throw error;

      const { data: attempts, error: attemptsError } = await adminClient
        .from("notification_delivery_attempts")
        .select("id, status, device_id")
        .eq("notification_id", notif.id);
      if (attemptsError) throw attemptsError;
      expect(attempts).toHaveLength(2);
      expect(attempts!.every((a) => a.status === "skipped")).toBe(true); // NOTIFICATION_PROVIDER=disabled
      const deviceIds = new Set(attempts!.map((a) => a.device_id));
      expect(deviceIds.size).toBe(2);
    });
  });

  describe("preferences", () => {
    it("defaults to enabled for a fresh user with no preference rows", async () => {
      const res = await request(app).get("/v1/notification-preferences").set(authHeader(otherBooker));
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ booking: true, payment: true, message: true });
    });

    it("updates and persists a preference", async () => {
      const patch = await request(app).patch("/v1/notification-preferences").set(authHeader(otherBooker)).send({ payment: false });
      expect(patch.status).toBe(200);
      expect(patch.body.data).toEqual({ booking: true, payment: false, message: true });

      const get = await request(app).get("/v1/notification-preferences").set(authHeader(otherBooker));
      expect(get.body.data).toEqual({ booking: true, payment: false, message: true });
    });

    it("a disabled category suppresses push delivery but NEVER the in-app notification itself", async () => {
      const disabledUser = await createTestUser();
      await grantRole(disabledUser, "host");
      await request(app).patch("/v1/notification-preferences").set(authHeader(disabledUser)).send({ booking: false });
      await request(app).post("/v1/devices").set(authHeader(disabledUser)).send({ device_token: "tok-suppressed", platform: "ios" });

      const locationId = await createBookableLocation(disabledUser);
      const booking = await createBooking(booker, locationId);

      // The in-app record must still exist.
      const notifs = await notificationsFor(disabledUser, "booking_request_received");
      const mine = notifs.find((n: { entity_id: string }) => n.entity_id === booking.id);
      expect(mine).toBeDefined();

      // But no delivery attempt was made for it.
      const { data: attempts, error } = await adminClient
        .from("notification_delivery_attempts")
        .select("id")
        .eq("notification_id", mine.id);
      if (error) throw error;
      expect(attempts).toHaveLength(0);

      await deleteTestUser(disabledUser.id);
    });

    it("rejects an empty preference update body", async () => {
      const res = await request(app).patch("/v1/notification-preferences").set(authHeader(otherBooker)).send({});
      expect(res.status).toBe(400);
    });
  });

  describe("API: listing, detail, read state, security", () => {
    it("rejects unauthenticated access to every endpoint", async () => {
      const list = await request(app).get("/v1/notifications");
      expect(list.status).toBe(401);
      const readAll = await request(app).post("/v1/notifications/read-all");
      expect(readAll.status).toBe(401);
    });

    it("a booker cannot read or mark-read another user's notification", async () => {
      const locationId = await createBookableLocation(host);
      const booking = await createBooking(booker, locationId);

      const bookerNotifs = await request(app).get("/v1/notifications").set(authHeader(booker)).query({ pageSize: 100 });
      const own = bookerNotifs.body.data.find((n: { entity_id: string }) => n.entity_id === booking.id);
      expect(own).toBeUndefined(); // booker gets no notification for their own booking creation

      const hostNotifs = await request(app).get("/v1/notifications").set(authHeader(host)).query({ pageSize: 100 });
      const hostOwn = hostNotifs.body.data.find((n: { entity_id: string }) => n.entity_id === booking.id);
      expect(hostOwn).toBeDefined();

      const crossRead = await request(app).get(`/v1/notifications/${hostOwn.id}`).set(authHeader(booker));
      expect(crossRead.status).toBe(404);

      const crossMarkRead = await request(app).post(`/v1/notifications/${hostOwn.id}/read`).set(authHeader(booker));
      expect(crossMarkRead.status).toBe(404);
    });

    it("marks a single notification read, idempotently", async () => {
      const locationId = await createBookableLocation(host);
      const booking = await createBooking(booker, locationId);
      const list = await request(app).get("/v1/notifications").set(authHeader(host)).query({ pageSize: 100 });
      const target = list.body.data.find((n: { entity_id: string }) => n.entity_id === booking.id);
      expect(target.read_at).toBeNull();

      const first = await request(app).post(`/v1/notifications/${target.id}/read`).set(authHeader(host));
      expect(first.status).toBe(200);
      expect(first.body.data.read_at).not.toBeNull();

      const second = await request(app).post(`/v1/notifications/${target.id}/read`).set(authHeader(host));
      expect(second.status).toBe(200);
      expect(second.body.data.read_at).toBe(first.body.data.read_at); // unchanged, idempotent
    });

    it("?unread=true filters to only unread notifications", async () => {
      const freshUser = await createTestUser();
      await grantRole(freshUser, "host");
      const locationId = await createBookableLocation(freshUser);
      const booking = await createBooking(booker, locationId);

      const all = await request(app).get("/v1/notifications").set(authHeader(freshUser)).query({ pageSize: 100 });
      const target = all.body.data.find((n: { entity_id: string }) => n.entity_id === booking.id);
      await request(app).post(`/v1/notifications/${target.id}/read`).set(authHeader(freshUser));

      const unread = await request(app).get("/v1/notifications").set(authHeader(freshUser)).query({ unread: "true", pageSize: 100 });
      expect(unread.body.data.some((n: { id: string }) => n.id === target.id)).toBe(false);

      await deleteTestUser(freshUser.id);
    });

    it("read-all marks every unread notification for the caller read", async () => {
      const freshUser = await createTestUser();
      await grantRole(freshUser, "host");
      const locationId = await createBookableLocation(freshUser);
      await createBooking(booker, locationId);
      await createBooking(booker, locationId);

      const before = await request(app).get("/v1/notifications").set(authHeader(freshUser)).query({ unread: "true", pageSize: 100 });
      expect(before.body.data.length).toBeGreaterThanOrEqual(2);

      const readAll = await request(app).post("/v1/notifications/read-all").set(authHeader(freshUser));
      expect(readAll.status).toBe(200);
      expect(readAll.body.data.marked_read).toBe(before.body.data.length);

      const after = await request(app).get("/v1/notifications").set(authHeader(freshUser)).query({ unread: "true", pageSize: 100 });
      expect(after.body.data).toHaveLength(0);

      await deleteTestUser(freshUser.id);
    });
  });

  // =========================================================================
  // Phase 29.12 -- soft delete.
  //
  // The rule under test throughout: DELETE /v1/notifications/:id removes the
  // notification from every user-facing read path while the ROW survives, so
  // that (a) the append-only delivery audit keeps its FK target and (b) the
  // (user_id, source_event_id) idempotency key keeps colliding, which is what
  // stops a retried source event from resurrecting a deleted notification.
  // =========================================================================
  describe("soft delete", () => {
    /** A fresh host with exactly one notification of their own, plus its id. */
    async function userWithOneNotification(): Promise<{ user: TestUser; notificationId: string }> {
      const user = await createTestUser();
      await grantRole(user, "host");
      const locationId = await createBookableLocation(user);
      const booking = await createBooking(booker, locationId);
      const list = await request(app).get("/v1/notifications").set(authHeader(user)).query({ pageSize: 100 });
      const target = list.body.data.find((n: { entity_id: string }) => n.entity_id === booking.id);
      expect(target).toBeDefined();
      return { user, notificationId: target.id as string };
    }

    it("soft-deletes the caller's own notification and hides it from the list", async () => {
      const { user, notificationId } = await userWithOneNotification();

      const del = await request(app).delete(`/v1/notifications/${notificationId}`).set(authHeader(user));
      expect(del.status).toBe(200);

      const after = await request(app).get("/v1/notifications").set(authHeader(user)).query({ pageSize: 100 });
      expect(after.body.data.some((n: { id: string }) => n.id === notificationId)).toBe(false);

      await deleteTestUser(user.id);
    });

    it("the row survives -- deletion is an UPDATE, never a DELETE", async () => {
      const { user, notificationId } = await userWithOneNotification();
      await request(app).delete(`/v1/notifications/${notificationId}`).set(authHeader(user));

      const { data, error } = await adminClient
        .from("notifications")
        .select("id, deleted_at, read_at, source_event_id")
        .eq("id", notificationId)
        .single();
      if (error) throw error;
      expect(data.id).toBe(notificationId);
      expect(data.deleted_at).not.toBeNull();
      expect(data.source_event_id).not.toBeNull(); // idempotency key retained

      await deleteTestUser(user.id);
    });

    it("a deleted notification is excluded from the unread query AND the unread count", async () => {
      const { user, notificationId } = await userWithOneNotification();

      // meta.total on the unread filter is exactly what the iOS bell badge reads.
      const before = await request(app)
        .get("/v1/notifications")
        .set(authHeader(user))
        .query({ unread: "true", pageSize: 1 });
      expect(before.body.meta.total).toBeGreaterThanOrEqual(1);

      await request(app).delete(`/v1/notifications/${notificationId}`).set(authHeader(user));

      const afterList = await request(app)
        .get("/v1/notifications")
        .set(authHeader(user))
        .query({ unread: "true", pageSize: 100 });
      expect(afterList.body.data.some((n: { id: string }) => n.id === notificationId)).toBe(false);

      const afterCount = await request(app)
        .get("/v1/notifications")
        .set(authHeader(user))
        .query({ unread: "true", pageSize: 1 });
      expect(afterCount.body.meta.total).toBe(before.body.meta.total - 1);

      await deleteTestUser(user.id);
    });

    it("a deleted notification is excluded from the detail endpoint", async () => {
      const { user, notificationId } = await userWithOneNotification();

      const before = await request(app).get(`/v1/notifications/${notificationId}`).set(authHeader(user));
      expect(before.status).toBe(200);

      await request(app).delete(`/v1/notifications/${notificationId}`).set(authHeader(user));

      const after = await request(app).get(`/v1/notifications/${notificationId}`).set(authHeader(user));
      expect(after.status).toBe(404);

      await deleteTestUser(user.id);
    });

    it("mark-read on a deleted notification is a 404, not a resurrection", async () => {
      const { user, notificationId } = await userWithOneNotification();
      await request(app).delete(`/v1/notifications/${notificationId}`).set(authHeader(user));

      const read = await request(app).post(`/v1/notifications/${notificationId}/read`).set(authHeader(user));
      expect(read.status).toBe(404);

      const list = await request(app).get("/v1/notifications").set(authHeader(user)).query({ pageSize: 100 });
      expect(list.body.data.some((n: { id: string }) => n.id === notificationId)).toBe(false);

      await deleteTestUser(user.id);
    });

    it("read-all ignores deleted notifications and never brings them back", async () => {
      const user = await createTestUser();
      await grantRole(user, "host");
      const locationId = await createBookableLocation(user);
      await createBooking(booker, locationId);
      await createBooking(booker, locationId);

      const before = await request(app).get("/v1/notifications").set(authHeader(user)).query({ unread: "true", pageSize: 100 });
      const unreadBefore = before.body.data.length;
      expect(unreadBefore).toBeGreaterThanOrEqual(2);
      const doomed = before.body.data[0].id as string;

      await request(app).delete(`/v1/notifications/${doomed}`).set(authHeader(user));

      const readAll = await request(app).post("/v1/notifications/read-all").set(authHeader(user));
      expect(readAll.status).toBe(200);
      // The deleted one is NOT counted -- it was excluded from the update.
      expect(readAll.body.data.marked_read).toBe(unreadBefore - 1);

      const after = await request(app).get("/v1/notifications").set(authHeader(user)).query({ pageSize: 100 });
      expect(after.body.data.some((n: { id: string }) => n.id === doomed)).toBe(false);

      // And the deleted row was never marked read behind the scenes.
      const { data, error } = await adminClient.from("notifications").select("read_at").eq("id", doomed).single();
      if (error) throw error;
      expect(data.read_at).toBeNull();

      await deleteTestUser(user.id);
    });

    it("MANDATORY REGRESSION: a notification with delivery-attempt rows can be soft-deleted, and the audit survives", async () => {
      // This is the case a hard DELETE cannot serve:
      // notification_delivery_attempts.notification_id references
      // notifications(id) with NO `on delete` clause, so removing the row
      // would raise FK violation 23503 for every notification that was ever
      // pushed to a device.
      const user = await createTestUser();
      await grantRole(user, "host");
      await request(app).post("/v1/devices").set(authHeader(user)).send({ device_token: "tok-softdelete-1", platform: "ios" });

      const locationId = await createBookableLocation(user);
      const booking = await createBooking(booker, locationId);

      const { data: notif, error } = await adminClient
        .from("notifications")
        .select("id")
        .eq("user_id", user.id)
        .eq("entity_id", booking.id)
        .eq("type", "booking_request_received")
        .single();
      if (error) throw error;

      const { data: attemptsBefore, error: beforeError } = await adminClient
        .from("notification_delivery_attempts")
        .select("id")
        .eq("notification_id", notif.id);
      if (beforeError) throw beforeError;
      expect(attemptsBefore!.length).toBeGreaterThanOrEqual(1); // the FK that would block a hard delete

      const del = await request(app).delete(`/v1/notifications/${notif.id}`).set(authHeader(user));
      expect(del.status).toBe(200); // no 23503, no 500

      const list = await request(app).get("/v1/notifications").set(authHeader(user)).query({ pageSize: 100 });
      expect(list.body.data.some((n: { id: string }) => n.id === notif.id)).toBe(false);

      const { data: attemptsAfter, error: afterError } = await adminClient
        .from("notification_delivery_attempts")
        .select("id")
        .eq("notification_id", notif.id);
      if (afterError) throw afterError;
      expect(attemptsAfter!.length).toBe(attemptsBefore!.length); // audit intact

      await deleteTestUser(user.id);
    });

    it("soft deletion does NOT free the idempotency key -- a retried source event cannot resurrect it", async () => {
      const locationId = await createBookableLocation(host);
      const booking = await createBooking(booker, locationId);

      await notifyBookingConfirmed(booker.id, booking.id);
      const list = await request(app).get("/v1/notifications").set(authHeader(booker)).query({ pageSize: 100 });
      const target = list.body.data.find(
        (n: { entity_id: string; type: string }) => n.entity_id === booking.id && n.type === "booking_confirmed"
      );
      expect(target).toBeDefined();

      await request(app).delete(`/v1/notifications/${target.id}`).set(authHeader(booker));

      // Re-fire the exact same source event. The surviving row still owns
      // (user_id, source_event_id), so the insert collides and is dropped.
      await notifyBookingConfirmed(booker.id, booking.id);

      const after = await request(app).get("/v1/notifications").set(authHeader(booker)).query({ pageSize: 100 });
      expect(
        after.body.data.some((n: { entity_id: string; type: string }) => n.entity_id === booking.id && n.type === "booking_confirmed")
      ).toBe(false);

      const { data, error } = await adminClient
        .from("notifications")
        .select("id")
        .eq("user_id", booker.id)
        .eq("entity_id", booking.id)
        .eq("type", "booking_confirmed");
      if (error) throw error;
      expect(data).toHaveLength(1); // still exactly one row, still deleted
    });

    it("deleting an already-deleted notification is idempotent, not an error", async () => {
      const { user, notificationId } = await userWithOneNotification();

      const first = await request(app).delete(`/v1/notifications/${notificationId}`).set(authHeader(user));
      expect(first.status).toBe(200);

      const { data: afterFirst } = await adminClient
        .from("notifications")
        .select("deleted_at")
        .eq("id", notificationId)
        .single();

      const second = await request(app).delete(`/v1/notifications/${notificationId}`).set(authHeader(user));
      expect(second.status).toBe(200); // not 404, not 500

      const { data: afterSecond } = await adminClient
        .from("notifications")
        .select("deleted_at")
        .eq("id", notificationId)
        .single();
      expect(afterSecond!.deleted_at).toBe(afterFirst!.deleted_at); // not re-stamped

      await deleteTestUser(user.id);
    });

    it("a user cannot delete another user's notification", async () => {
      const { user, notificationId } = await userWithOneNotification();

      const cross = await request(app).delete(`/v1/notifications/${notificationId}`).set(authHeader(otherBooker));
      expect(cross.status).toBe(404); // indistinguishable from "no such id" -- not an existence oracle

      // And it is genuinely untouched.
      const { data, error } = await adminClient.from("notifications").select("deleted_at").eq("id", notificationId).single();
      if (error) throw error;
      expect(data.deleted_at).toBeNull();

      const stillThere = await request(app).get("/v1/notifications").set(authHeader(user)).query({ pageSize: 100 });
      expect(stillThere.body.data.some((n: { id: string }) => n.id === notificationId)).toBe(true);

      await deleteTestUser(user.id);
    });

    it("rejects unauthenticated deletion", async () => {
      const { user, notificationId } = await userWithOneNotification();

      const res = await request(app).delete(`/v1/notifications/${notificationId}`);
      expect(res.status).toBe(401);

      const { data, error } = await adminClient.from("notifications").select("deleted_at").eq("id", notificationId).single();
      if (error) throw error;
      expect(data.deleted_at).toBeNull();

      await deleteTestUser(user.id);
    });

    it("rejects a malformed notification id", async () => {
      const res = await request(app).delete("/v1/notifications/not-a-uuid").set(authHeader(booker));
      expect(res.status).toBe(400);
    });

    it("repeated list/refresh never resurrects a deleted notification", async () => {
      const { user, notificationId } = await userWithOneNotification();
      await request(app).delete(`/v1/notifications/${notificationId}`).set(authHeader(user));

      // The iOS client re-reads the whole page on pull-to-refresh and on every
      // foreground push arrival -- the exact path that would expose a fake,
      // in-memory-only delete.
      for (let i = 0; i < 3; i += 1) {
        const res = await request(app).get("/v1/notifications").set(authHeader(user)).query({ pageSize: 100 });
        expect(res.status).toBe(200);
        expect(res.body.data.some((n: { id: string }) => n.id === notificationId)).toBe(false);
      }

      await deleteTestUser(user.id);
    });
  });
});
