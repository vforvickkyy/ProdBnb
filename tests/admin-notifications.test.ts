import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

describe("admin: notification delivery diagnostics", () => {
  let admin: TestUser;
  let booker: TestUser;
  let host: TestUser;
  let bookingId: string;

  beforeAll(async () => {
    admin = await createTestUser();
    booker = await createTestUser();
    host = await createTestUser();
    await grantAdmin(admin);
    await grantRole(booker, "booker");
    await grantRole(host, "host");

    await request(app).post("/v1/devices").set(authHeader(host)).send({ device_token: "admin-diag-tok", platform: "ios" });

    const loc = await request(app)
      .post("/v1/locations")
      .set(authHeader(host))
      .send({ title: "Admin Notif Diagnostics Location", city: "London", country: "UK" });
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

    const booking = await request(app)
      .post("/v1/bookings")
      .set(authHeader(booker))
      .send({ location_id: locationId, start_at: "2026-10-05T09:00:00Z", end_at: "2026-10-05T10:00:00Z" });
    bookingId = booking.body.data.id as string;
  });

  afterAll(async () => {
    await deleteTestUser(admin.id);
    await deleteTestUser(booker.id);
    await deleteTestUser(host.id);
  });

  it("rejects booker/host, admin succeeds", async () => {
    for (const nonAdmin of [booker, host]) {
      const res = await request(app).get("/v1/admin/notifications/delivery-attempts").set(authHeader(nonAdmin)).query({ booking_id: bookingId });
      expect(res.status).toBe(403);
    }
    const res = await request(app).get("/v1/admin/notifications/delivery-attempts").set(authHeader(admin)).query({ booking_id: bookingId });
    expect(res.status).toBe(200);
  });

  it("requires either notification_id or booking_id", async () => {
    const res = await request(app).get("/v1/admin/notifications/delivery-attempts").set(authHeader(admin));
    expect(res.status).toBe(400);
  });

  it("returns diagnostics (status/provider/error_reason) via booking_id, honestly 'skipped' under the disabled provider", async () => {
    const res = await request(app).get("/v1/admin/notifications/delivery-attempts").set(authHeader(admin)).query({ booking_id: bookingId });
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    const attempt = res.body.data[0];
    expect(attempt.status).toBe("skipped");
    expect(attempt.provider).toBe("disabled");
    expect(attempt).toHaveProperty("error_reason");
    // Diagnostics only -- never the notification's own title/body content.
    expect(attempt).not.toHaveProperty("title");
    expect(attempt).not.toHaveProperty("body");
  });

  it("returns an empty page for a booking with no notification, rather than every attempt in the table", async () => {
    const res = await request(app)
      .get("/v1/admin/notifications/delivery-attempts")
      .set(authHeader(admin))
      .query({ booking_id: "00000000-0000-0000-0000-000000000000" });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it("filters via notification_id directly too", async () => {
    const { data: notif, error } = await adminClient
      .from("notifications")
      .select("id")
      .eq("entity_type", "booking")
      .eq("entity_id", bookingId)
      .eq("type", "booking_request_received")
      .single();
    if (error) throw error;

    const res = await request(app)
      .get("/v1/admin/notifications/delivery-attempts")
      .set(authHeader(admin))
      .query({ notification_id: notif.id });
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    expect(res.body.data.every((a: { notification_id: string }) => a.notification_id === notif.id)).toBe(true);
  });
});
