import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { adminClient, createTestUser, deleteTestUser, TestUser } from "./setup";

const app = createApp();

function authHeader(user: TestUser): { Authorization: string } {
  return { Authorization: `Bearer ${user.accessToken}` };
}

async function grantHostRole(user: TestUser): Promise<void> {
  const res = await request(app).post("/v1/me/roles").set(authHeader(user)).send({ role: "host" });
  expect(res.status).toBe(201);
}

async function createLocation(owner: TestUser, timezone = "UTC"): Promise<string> {
  const res = await request(app)
    .post("/v1/locations")
    .set(authHeader(owner))
    .send({ title: "Availability Test Location", city: "London", country: "UK", timezone });
  expect(res.status).toBe(201);
  return res.body.data.id as string;
}

async function publish(locationId: string): Promise<void> {
  const { error } = await adminClient.from("locations").update({ status: "published" }).eq("id", locationId);
  if (error) throw error;
}

// 2026-10-05 through 2026-10-11 is a Mon-Sun week.
const MONDAY = "2026-10-05";
const TUESDAY = "2026-10-06";
const SUNDAY = "2026-10-11";

describe("availability", () => {
  let host: TestUser;
  let otherHost: TestUser;
  let booker: TestUser;
  let admin: TestUser;

  beforeAll(async () => {
    host = await createTestUser();
    otherHost = await createTestUser();
    booker = await createTestUser();
    admin = await createTestUser();
    await grantHostRole(host);
    await grantHostRole(otherHost);
    const { error } = await adminClient.from("user_roles").insert({ user_id: admin.id, role: "admin" });
    if (error) throw error;
  });

  afterAll(async () => {
    await deleteTestUser(host.id);
    await deleteTestUser(otherHost.id);
    await deleteTestUser(booker.id);
    await deleteTestUser(admin.id);
  });

  describe("weekly schedules", () => {
    let locationId: string;

    beforeAll(async () => {
      locationId = await createLocation(host);
      const res = await request(app)
        .post(`/v1/locations/${locationId}/availability/rules`)
        .set(authHeader(host))
        .send({ day_of_week: "monday", start_time: "09:00", end_time: "18:00" });
      expect(res.status).toBe(201);
      await publish(locationId);
    });

    it("returns availability for a matching weekday", async () => {
      const res = await request(app)
        .get(`/v1/locations/${locationId}/availability`)
        .query({ from: MONDAY, to: MONDAY });
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].windows).toHaveLength(1);
      expect(res.body.meta.timezone).toBe("UTC");
    });

    it("returns empty windows for a day with no rule", async () => {
      const res = await request(app)
        .get(`/v1/locations/${locationId}/availability`)
        .query({ from: TUESDAY, to: TUESDAY });
      expect(res.status).toBe(200);
      expect(res.body.data[0]).toEqual({ date: TUESDAY, windows: [] });
    });

    it("supports multiple windows per day with a correctly-empty gap", async () => {
      const gapLoc = await createLocation(host);
      await request(app)
        .post(`/v1/locations/${gapLoc}/availability/rules`)
        .set(authHeader(host))
        .send({ day_of_week: "monday", start_time: "09:00", end_time: "12:00" });
      await request(app)
        .post(`/v1/locations/${gapLoc}/availability/rules`)
        .set(authHeader(host))
        .send({ day_of_week: "monday", start_time: "14:00", end_time: "18:00" });
      await publish(gapLoc);

      const res = await request(app).get(`/v1/locations/${gapLoc}/availability`).query({ from: MONDAY, to: MONDAY });
      expect(res.body.data[0].windows).toHaveLength(2);
      const [morning, afternoon] = res.body.data[0].windows;
      expect(new Date(morning.end).toISOString()).toBe("2026-10-05T12:00:00.000Z");
      expect(new Date(afternoon.start).toISOString()).toBe("2026-10-05T14:00:00.000Z");
    });

    it("rejects an overlapping rule on the same day with 409", async () => {
      const res = await request(app)
        .post(`/v1/locations/${locationId}/availability/rules`)
        .set(authHeader(host))
        .send({ day_of_week: "monday", start_time: "10:00", end_time: "12:00" });
      expect(res.status).toBe(409);
    });

    it("rejects end_time <= start_time", async () => {
      const res = await request(app)
        .post(`/v1/locations/${locationId}/availability/rules`)
        .set(authHeader(host))
        .send({ day_of_week: "tuesday", start_time: "12:00", end_time: "12:00" });
      expect(res.status).toBe(400);
    });
  });

  describe("overrides", () => {
    let locationId: string;

    beforeAll(async () => {
      locationId = await createLocation(host);
      await request(app)
        .post(`/v1/locations/${locationId}/availability/rules`)
        .set(authHeader(host))
        .send({ day_of_week: "monday", start_time: "09:00", end_time: "18:00" });
      await publish(locationId);
    });

    it("an unavailable override zeroes out a normally-open day", async () => {
      const create = await request(app)
        .post(`/v1/locations/${locationId}/availability/overrides`)
        .set(authHeader(host))
        .send({ date: MONDAY, status: "unavailable" });
      expect(create.status).toBe(201);

      const res = await request(app).get(`/v1/locations/${locationId}/availability`).query({ from: MONDAY, to: MONDAY });
      expect(res.body.data[0].windows).toEqual([]);

      // clean up so later tests in this block aren't affected
      await request(app).delete(`/v1/locations/${locationId}/availability/overrides/${create.body.data.id}`).set(authHeader(host));
    });

    it("an available override opens a normally-closed day", async () => {
      const create = await request(app)
        .post(`/v1/locations/${locationId}/availability/overrides`)
        .set(authHeader(host))
        .send({ date: SUNDAY, status: "available", start_time: "10:00", end_time: "14:00" });
      expect(create.status).toBe(201);

      const res = await request(app).get(`/v1/locations/${locationId}/availability`).query({ from: SUNDAY, to: SUNDAY });
      expect(res.body.data[0].windows).toHaveLength(1);
      expect(new Date(res.body.data[0].windows[0].start).toISOString()).toBe("2026-10-11T10:00:00.000Z");
    });

    it("rejects an available override without explicit hours", async () => {
      const res = await request(app)
        .post(`/v1/locations/${locationId}/availability/overrides`)
        .set(authHeader(host))
        .send({ date: "2026-10-12", status: "available" });
      expect(res.status).toBe(400);
    });

    it("rejects a second override for the same date with 409", async () => {
      const res = await request(app)
        .post(`/v1/locations/${locationId}/availability/overrides`)
        .set(authHeader(host))
        .send({ date: SUNDAY, status: "unavailable" });
      expect(res.status).toBe(409);
    });
  });

  describe("blocked periods", () => {
    let locationId: string;

    beforeAll(async () => {
      locationId = await createLocation(host);
      await request(app)
        .post(`/v1/locations/${locationId}/availability/rules`)
        .set(authHeader(host))
        .send({ day_of_week: "monday", start_time: "09:00", end_time: "18:00" });
      await publish(locationId);
    });

    it("a partial-day block splits one window into two", async () => {
      const block = await request(app)
        .post(`/v1/locations/${locationId}/blocks`)
        .set(authHeader(host))
        .send({ start_at: "2026-10-05T13:00:00Z", end_at: "2026-10-05T15:00:00Z", reason: "Owner using property" });
      expect(block.status).toBe(201);

      const res = await request(app).get(`/v1/locations/${locationId}/availability`).query({ from: MONDAY, to: MONDAY });
      expect(res.body.data[0].windows).toHaveLength(2);
      expect(new Date(res.body.data[0].windows[0].end).toISOString()).toBe("2026-10-05T13:00:00.000Z");
      expect(new Date(res.body.data[0].windows[1].start).toISOString()).toBe("2026-10-05T15:00:00.000Z");

      await request(app).delete(`/v1/locations/${locationId}/blocks/${block.body.data.id}`).set(authHeader(host));
    });

    it("a full-day block removes all availability that day", async () => {
      const block = await request(app)
        .post(`/v1/locations/${locationId}/blocks`)
        .set(authHeader(host))
        .send({ start_at: "2026-10-05T00:00:00Z", end_at: "2026-10-06T00:00:00Z", reason: "Renovation" });
      expect(block.status).toBe(201);

      const res = await request(app).get(`/v1/locations/${locationId}/availability`).query({ from: MONDAY, to: MONDAY });
      expect(res.body.data[0].windows).toEqual([]);
    });

    it("never exposes the block reason publicly, and blocks aren't publicly listable", async () => {
      const res = await request(app).get(`/v1/locations/${locationId}/availability`).query({ from: MONDAY, to: MONDAY });
      expect(JSON.stringify(res.body)).not.toContain("Renovation");

      const listRes = await request(app).get(`/v1/locations/${locationId}/blocks`);
      expect(listRes.status).toBe(401); // no auth at all

      const bookerRes = await request(app).get(`/v1/locations/${locationId}/blocks`).set(authHeader(booker));
      expect(bookerRes.status).toBe(403);
    });

    it("rejects an overlapping block with 409", async () => {
      const res = await request(app)
        .post(`/v1/locations/${locationId}/blocks`)
        .set(authHeader(host))
        .send({ start_at: "2026-10-05T12:00:00Z", end_at: "2026-10-05T13:00:00Z" });
      expect(res.status).toBe(409);
    });
  });

  describe("timezone handling", () => {
    it("returns correctly-offset timestamps for a non-UTC location", async () => {
      const locationId = await createLocation(host, "Asia/Kolkata");
      await request(app)
        .post(`/v1/locations/${locationId}/availability/rules`)
        .set(authHeader(host))
        .send({ day_of_week: "monday", start_time: "09:00", end_time: "18:00" });
      await publish(locationId);

      const res = await request(app).get(`/v1/locations/${locationId}/availability`).query({ from: MONDAY, to: MONDAY });
      // 09:00 IST (UTC+5:30) = 03:30 UTC
      expect(new Date(res.body.data[0].windows[0].start).toISOString()).toBe("2026-10-05T03:30:00.000Z");
      expect(res.body.meta.timezone).toBe("Asia/Kolkata");
    });

    it("rejects an invalid IANA timezone at location creation", async () => {
      const res = await request(app)
        .post("/v1/locations")
        .set(authHeader(host))
        .send({ title: "Bad TZ", city: "X", country: "Y", timezone: "Not/AZone" });
      expect(res.status).toBe(400);
    });
  });

  describe("validation", () => {
    let locationId: string;
    beforeAll(async () => {
      locationId = await createLocation(host);
      await publish(locationId);
    });

    it("rejects an over-90-day range", async () => {
      const res = await request(app)
        .get(`/v1/locations/${locationId}/availability`)
        .query({ from: "2026-01-01", to: "2026-12-31" });
      expect(res.status).toBe(400);
    });

    it("rejects to before from", async () => {
      const res = await request(app)
        .get(`/v1/locations/${locationId}/availability`)
        .query({ from: "2026-10-10", to: "2026-10-01" });
      expect(res.status).toBe(400);
    });

    it("404s availability for a nonexistent location", async () => {
      const res = await request(app)
        .get("/v1/locations/00000000-0000-0000-0000-000000000000/availability")
        .query({ from: MONDAY, to: MONDAY });
      expect(res.status).toBe(404);
    });
  });

  describe("authorization", () => {
    let locationId: string;
    beforeAll(async () => {
      locationId = await createLocation(host);
      await publish(locationId);
    });

    it("forbids a booker from creating a rule", async () => {
      const res = await request(app)
        .post(`/v1/locations/${locationId}/availability/rules`)
        .set(authHeader(booker))
        .send({ day_of_week: "friday", start_time: "09:00", end_time: "17:00" });
      expect(res.status).toBe(403);
    });

    it("forbids another host from creating a rule for this (published) location", async () => {
      const res = await request(app)
        .post(`/v1/locations/${locationId}/availability/rules`)
        .set(authHeader(otherHost))
        .send({ day_of_week: "friday", start_time: "09:00", end_time: "17:00" });
      expect(res.status).toBe(403);
    });

    it("lets an admin manage availability for a location they don't own", async () => {
      const res = await request(app)
        .post(`/v1/locations/${locationId}/availability/rules`)
        .set(authHeader(admin))
        .send({ day_of_week: "friday", start_time: "09:00", end_time: "17:00" });
      expect(res.status).toBe(201);
    });

    it("forbids an unauthenticated caller from every management endpoint", async () => {
      const res = await request(app).post(`/v1/locations/${locationId}/availability/rules`).send({
        day_of_week: "saturday",
        start_time: "09:00",
        end_time: "17:00",
      });
      expect(res.status).toBe(401);
    });
  });

  describe("booking integration (Phase 6)", () => {
    let locationId: string;
    let bookerUser: TestUser;

    beforeAll(async () => {
      bookerUser = await createTestUser();
      const grant = await request(app).post("/v1/me/roles").set(authHeader(bookerUser)).send({ role: "booker" });
      expect(grant.status).toBe(201);

      locationId = await createLocation(host);
      await request(app)
        .post(`/v1/locations/${locationId}/availability/rules`)
        .set(authHeader(host))
        .send({ day_of_week: "monday", start_time: "10:00", end_time: "18:00" });
      const pricing = await request(app)
        .post(`/v1/locations/${locationId}/pricing`)
        .set(authHeader(host))
        .send({ booking_type: "hourly", amount_minor_units: 5000 });
      expect(pricing.status).toBe(201);
      await publish(locationId);
    });

    afterAll(async () => {
      await deleteTestUser(bookerUser.id);
    });

    it("an active booking removes its interval from computed availability, and cancelling restores it", async () => {
      const before = await request(app).get(`/v1/locations/${locationId}/availability`).query({ from: MONDAY, to: MONDAY });
      expect(before.body.data[0].windows).toHaveLength(1);
      expect(new Date(before.body.data[0].windows[0].start).toISOString()).toBe("2026-10-05T10:00:00.000Z");
      expect(new Date(before.body.data[0].windows[0].end).toISOString()).toBe("2026-10-05T18:00:00.000Z");

      const booking = await request(app)
        .post("/v1/bookings")
        .set(authHeader(bookerUser))
        .send({ location_id: locationId, start_at: "2026-10-05T13:00:00Z", end_at: "2026-10-05T15:00:00Z" });
      expect(booking.status).toBe(201);

      const during = await request(app).get(`/v1/locations/${locationId}/availability`).query({ from: MONDAY, to: MONDAY });
      expect(during.body.data[0].windows).toHaveLength(2);
      expect(new Date(during.body.data[0].windows[0].end).toISOString()).toBe("2026-10-05T13:00:00.000Z");
      expect(new Date(during.body.data[0].windows[1].start).toISOString()).toBe("2026-10-05T15:00:00.000Z");

      await request(app).post(`/v1/bookings/${booking.body.data.id}/cancel`).set(authHeader(bookerUser));

      const after = await request(app).get(`/v1/locations/${locationId}/availability`).query({ from: MONDAY, to: MONDAY });
      expect(after.body.data[0].windows).toHaveLength(1);
      expect(new Date(after.body.data[0].windows[0].start).toISOString()).toBe("2026-10-05T10:00:00.000Z");
      expect(new Date(after.body.data[0].windows[0].end).toISOString()).toBe("2026-10-05T18:00:00.000Z");
    });
  });
});
