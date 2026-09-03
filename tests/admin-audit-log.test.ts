import { createClient } from "@supabase/supabase-js";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

describe("admin: audit log", () => {
  let admin: TestUser;
  let booker: TestUser;
  let host: TestUser;
  let targetUserId: string;

  beforeAll(async () => {
    admin = await createTestUser();
    booker = await createTestUser();
    host = await createTestUser();
    await grantAdmin(admin);
    await grantRole(booker, "booker");
    await grantRole(host, "host");

    const target = await createTestUser();
    targetUserId = target.id;
    await request(app).post(`/v1/admin/users/${targetUserId}/suspend`).set(authHeader(admin)).send({ reason: "audit log test" });
  });

  afterAll(async () => {
    await deleteTestUser(admin.id);
    await deleteTestUser(booker.id);
    await deleteTestUser(host.id);
    await deleteTestUser(targetUserId);
  });

  it("rejects booker/host, admin succeeds", async () => {
    for (const nonAdmin of [booker, host]) {
      const res = await request(app).get("/v1/admin/audit-log").set(authHeader(nonAdmin));
      expect(res.status).toBe(403);
    }
    const res = await request(app).get("/v1/admin/audit-log").set(authHeader(admin));
    expect(res.status).toBe(200);
  });

  it("filters by target_type/target_id/admin_id", async () => {
    const res = await request(app)
      .get("/v1/admin/audit-log")
      .set(authHeader(admin))
      .query({ target_type: "user", target_id: targetUserId, admin_id: admin.id });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    const entry = res.body.data[0];
    expect(entry.action).toBe("ADMIN_SUSPENDED_USER");
    expect(entry.admin_id).toBe(admin.id);
    expect(entry.target_type).toBe("user");
    expect(entry.target_id).toBe(targetUserId);
    expect(entry.reason).toBe("audit log test");
    expect(entry.created_at).toBeTruthy();
  });

  it("cannot be spoofed or edited by any admin -- no client-writable path exists at all", async () => {
    // Even using an authenticated ADMIN's own bearer token directly against
    // PostgREST (bypassing this backend's controllers entirely, simulating
    // a malicious/compromised frontend), there is no INSERT/UPDATE/DELETE
    // grant on admin_audit_log for `authenticated` -- only service_role can
    // write it, and only this backend's own writeAuditLog() ever does.
    const adminScopedClient = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${admin.accessToken}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const fakeInsert = await adminScopedClient
      .from("admin_audit_log")
      .insert({ admin_id: admin.id, action: "ADMIN_APPROVED_LOCATION", target_type: "location", target_id: booker.id });
    expect(fakeInsert.error).toBeTruthy();

    const { data: real } = await adminClient
      .from("admin_audit_log")
      .select("id")
      .eq("target_type", "user")
      .eq("target_id", targetUserId)
      .single();

    const fakeUpdate = await adminScopedClient.from("admin_audit_log").update({ reason: "tampered" }).eq("id", real!.id);
    expect(fakeUpdate.error).toBeTruthy();

    const fakeDelete = await adminScopedClient.from("admin_audit_log").delete().eq("id", real!.id);
    expect(fakeDelete.error).toBeTruthy();

    // Confirm the row is genuinely untouched.
    const { data: unchanged, error } = await adminClient.from("admin_audit_log").select("reason").eq("id", real!.id).single();
    if (error) throw error;
    expect(unchanged.reason).toBe("audit log test");
  });

  it("rejects an unauthenticated caller", async () => {
    const res = await request(app).get("/v1/admin/audit-log");
    expect(res.status).toBe(401);
  });

  // Phase 12: an admin using the older, pre-Phase-11 routes (which already
  // accepted the same admin-bypass) used to leave zero audit trail -- only
  // the dedicated /v1/admin/* wrappers logged. These prove both legacy paths
  // are now covered too.

  it("POST /v1/bookings/:id/cancel used by an admin audits ADMIN_CANCELLED_BOOKING, same as the dedicated admin route", async () => {
    const otherBooker = await createTestUser();
    const otherHost = await createTestUser();
    try {
      await grantRole(otherBooker, "booker");
      await grantRole(otherHost, "host");

      const locRes = await request(app)
        .post("/v1/locations")
        .set(authHeader(otherHost))
        .send({ title: "Legacy Cancel Audit Test", city: "London", country: "UK", timezone: "UTC" });
      expect(locRes.status).toBe(201);
      const locationId = locRes.body.data.id as string;
      await addRule(locationId, otherHost, "monday", "09:00", "18:00");
      await addHourlyPricing(locationId, otherHost);
      await publish(locationId);

      const bookingRes = await request(app)
        .post("/v1/bookings")
        .set(authHeader(otherBooker))
        .send({ location_id: locationId, booking_type: "hourly", start_at: "2026-10-05T09:00:00Z", end_at: "2026-10-05T10:00:00Z" });
      expect(bookingRes.status).toBe(201);
      const bookingId = bookingRes.body.data.id as string;

      // The generic, pre-Phase-11 route -- not /v1/admin/bookings/:id/cancel.
      const cancelRes = await request(app)
        .post(`/v1/bookings/${bookingId}/cancel`)
        .set(authHeader(admin))
        .send({ reason: "Legacy-route admin cancel." });
      expect(cancelRes.status).toBe(200);

      const { data: entry, error } = await adminClient
        .from("admin_audit_log")
        .select("action, admin_id, target_id, reason")
        .eq("target_type", "booking")
        .eq("target_id", bookingId)
        .single();
      if (error) throw error;
      expect(entry.action).toBe("ADMIN_CANCELLED_BOOKING");
      expect(entry.admin_id).toBe(admin.id);
      expect(entry.reason).toBe("Legacy-route admin cancel.");
    } finally {
      await deleteTestUser(otherBooker.id);
      await deleteTestUser(otherHost.id);
    }
  });

  it("PATCH /v1/locations/:id used by an admin to change status audits ADMIN_UPDATED_LOCATION_STATUS", async () => {
    const otherHost = await createTestUser();
    try {
      await grantRole(otherHost, "host");
      const locRes = await request(app)
        .post("/v1/locations")
        .set(authHeader(otherHost))
        .send({ title: "Legacy PATCH Audit Test", city: "London", country: "UK" });
      expect(locRes.status).toBe(201);
      const locationId = locRes.body.data.id as string;

      const patchRes = await request(app).patch(`/v1/locations/${locationId}`).set(authHeader(admin)).send({ status: "approved" });
      expect(patchRes.status).toBe(200);

      const { data: entry, error } = await adminClient
        .from("admin_audit_log")
        .select("action, admin_id, target_id, metadata")
        .eq("target_type", "location")
        .eq("target_id", locationId)
        .single();
      if (error) throw error;
      expect(entry.action).toBe("ADMIN_UPDATED_LOCATION_STATUS");
      expect(entry.admin_id).toBe(admin.id);
      expect(entry.metadata).toMatchObject({ previous_status: "draft", new_status: "approved" });
    } finally {
      await deleteTestUser(otherHost.id);
    }
  });
});
