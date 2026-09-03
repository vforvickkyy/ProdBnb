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

async function createBookableLocation(owner: TestUser): Promise<string> {
  const res = await request(app)
    .post("/v1/locations")
    .set(authHeader(owner))
    .send({ title: "Admin Booking Test Location", city: "London", country: "UK" });
  expect(res.status).toBe(201);
  const locationId = res.body.data.id as string;
  await request(app)
    .post(`/v1/locations/${locationId}/availability/rules`)
    .set(authHeader(owner))
    .send({ day_of_week: "monday", start_time: "09:00", end_time: "18:00" });
  await request(app)
    .post(`/v1/locations/${locationId}/pricing`)
    .set(authHeader(owner))
    .send({ booking_type: "hourly", amount_minor_units: 10000 });
  await publish(locationId);
  return locationId;
}

describe("admin: bookings", () => {
  let admin: TestUser;
  let booker: TestUser;
  let otherBooker: TestUser;
  let host: TestUser;

  beforeAll(async () => {
    admin = await createTestUser();
    booker = await createTestUser();
    otherBooker = await createTestUser();
    host = await createTestUser();
    await grantAdmin(admin);
    await grantRole(booker, "booker");
    await grantRole(otherBooker, "booker");
    await grantRole(host, "host");
  });

  afterAll(async () => {
    await deleteTestUser(admin.id);
    await deleteTestUser(booker.id);
    await deleteTestUser(otherBooker.id);
    await deleteTestUser(host.id);
  });

  describe("authorization", () => {
    it("rejects booker/host, admin succeeds", async () => {
      for (const nonAdmin of [booker, host]) {
        const res = await request(app).get("/v1/admin/bookings").set(authHeader(nonAdmin));
        expect(res.status).toBe(403);
      }
      const res = await request(app).get("/v1/admin/bookings").set(authHeader(admin));
      expect(res.status).toBe(200);
    });

    it("rejects an unauthenticated caller", async () => {
      const res = await request(app).get("/v1/admin/bookings");
      expect(res.status).toBe(401);
    });
  });

  describe("listing & filters", () => {
    it("lists every booking regardless of owner (RLS already admin-omniscient)", async () => {
      const locationId = await createBookableLocation(host);
      const created = await request(app)
        .post("/v1/bookings")
        .set(authHeader(booker))
        .send({ location_id: locationId, start_at: "2026-10-05T09:00:00Z", end_at: "2026-10-05T10:00:00Z" });
      expect(created.status).toBe(201);

      const res = await request(app).get("/v1/admin/bookings").set(authHeader(admin)).query({ location_id: locationId });
      expect(res.status).toBe(200);
      expect(res.body.data.map((b: { id: string }) => b.id)).toContain(created.body.data.id);
    });

    it("filters by booker_id", async () => {
      const locationId = await createBookableLocation(host);
      const mine = await request(app)
        .post("/v1/bookings")
        .set(authHeader(booker))
        .send({ location_id: locationId, start_at: "2026-10-05T10:00:00Z", end_at: "2026-10-05T11:00:00Z" });
      const theirs = await request(app)
        .post("/v1/bookings")
        .set(authHeader(otherBooker))
        .send({ location_id: locationId, start_at: "2026-10-05T11:00:00Z", end_at: "2026-10-05T12:00:00Z" });

      const res = await request(app).get("/v1/admin/bookings").set(authHeader(admin)).query({ booker_id: booker.id, pageSize: 100 });
      const ids = res.body.data.map((b: { id: string }) => b.id);
      expect(ids).toContain(mine.body.data.id);
      expect(ids).not.toContain(theirs.body.data.id);
    });

    it("filters by host_id", async () => {
      const otherHost = await createTestUser();
      await grantRole(otherHost, "host");
      const locationA = await createBookableLocation(host);
      const locationB = await createBookableLocation(otherHost);

      const bookingA = await request(app)
        .post("/v1/bookings")
        .set(authHeader(booker))
        .send({ location_id: locationA, start_at: "2026-10-05T12:00:00Z", end_at: "2026-10-05T13:00:00Z" });
      const bookingB = await request(app)
        .post("/v1/bookings")
        .set(authHeader(booker))
        .send({ location_id: locationB, start_at: "2026-10-05T12:00:00Z", end_at: "2026-10-05T13:00:00Z" });

      const res = await request(app).get("/v1/admin/bookings").set(authHeader(admin)).query({ host_id: host.id, pageSize: 100 });
      const ids = res.body.data.map((b: { id: string }) => b.id);
      expect(ids).toContain(bookingA.body.data.id);
      expect(ids).not.toContain(bookingB.body.data.id);

      await deleteTestUser(otherHost.id);
    });

    it("admin booking detail matches the regular detail endpoint's data", async () => {
      const locationId = await createBookableLocation(host);
      const created = await request(app)
        .post("/v1/bookings")
        .set(authHeader(booker))
        .send({ location_id: locationId, start_at: "2026-10-05T13:00:00Z", end_at: "2026-10-05T14:00:00Z" });

      const res = await request(app).get(`/v1/admin/bookings/${created.body.data.id}`).set(authHeader(admin));
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(created.body.data.id);
    });
  });

  describe("admin cancel", () => {
    it("cancels a booking via the existing, unmodified booking engine and writes an audit entry", async () => {
      const locationId = await createBookableLocation(host);
      const created = await request(app)
        .post("/v1/bookings")
        .set(authHeader(booker))
        .send({ location_id: locationId, start_at: "2026-10-05T14:00:00Z", end_at: "2026-10-05T15:00:00Z" });
      const bookingId = created.body.data.id as string;

      const cancel = await request(app)
        .post(`/v1/admin/bookings/${bookingId}/cancel`)
        .set(authHeader(admin))
        .send({ reason: "Duplicate booking." });
      expect(cancel.status).toBe(200);
      expect(cancel.body.data.status).toBe("cancelled");

      // The exact same interval is immediately bookable again -- the EXCLUDE
      // constraint's behavior is completely unaffected by going through the
      // admin route.
      const rebook = await request(app)
        .post("/v1/bookings")
        .set(authHeader(otherBooker))
        .send({ location_id: locationId, start_at: "2026-10-05T14:00:00Z", end_at: "2026-10-05T15:00:00Z" });
      expect(rebook.status).toBe(201);

      const audit = await request(app)
        .get("/v1/admin/audit-log")
        .set(authHeader(admin))
        .query({ target_type: "booking", target_id: bookingId });
      expect(audit.status).toBe(200);
      expect(audit.body.data).toHaveLength(1);
      expect(audit.body.data[0].action).toBe("ADMIN_CANCELLED_BOOKING");
      expect(audit.body.data[0].admin_id).toBe(admin.id);
      expect(audit.body.data[0].reason).toBe("Duplicate booking.");
    });

    it("does not accept a reason-less cancellation as an error -- reason is optional here", async () => {
      const locationId = await createBookableLocation(host);
      const created = await request(app)
        .post("/v1/bookings")
        .set(authHeader(booker))
        .send({ location_id: locationId, start_at: "2026-10-05T15:00:00Z", end_at: "2026-10-05T16:00:00Z" });

      const cancel = await request(app).post(`/v1/admin/bookings/${created.body.data.id}/cancel`).set(authHeader(admin));
      expect(cancel.status).toBe(200);
    });
  });
});
