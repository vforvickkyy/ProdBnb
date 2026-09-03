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

interface LocationOpts {
  timezone?: string;
  instant_booking_enabled?: boolean;
}

async function createLocation(owner: TestUser, opts: LocationOpts = {}): Promise<string> {
  const res = await request(app)
    .post("/v1/locations")
    .set(authHeader(owner))
    .send({
      title: "Booking Test Location",
      city: "London",
      country: "UK",
      timezone: opts.timezone ?? "UTC",
      instant_booking_enabled: opts.instant_booking_enabled ?? false,
    });
  expect(res.status).toBe(201);
  return res.body.data.id as string;
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

// location_pricing configuration (Phase 6A) — pricing is no longer set via
// location creation, it's its own resource. `amount_minor_units` is passed
// through unchanged; half_day rows additionally need half_day_duration_hours.
async function addPricing(locationId: string, owner: TestUser, body: Record<string, unknown>): Promise<string> {
  const res = await request(app).post(`/v1/locations/${locationId}/pricing`).set(authHeader(owner)).send(body);
  expect(res.status).toBe(201);
  return res.body.data.id as string;
}

async function addHourlyPricing(locationId: string, owner: TestUser, amount = 10_000): Promise<void> {
  await addPricing(locationId, owner, { booking_type: "hourly", amount_minor_units: amount });
}

const HOURLY_RATE = 10_000;
const HALF_DAY_RATE = 30_000;
const HALF_DAY_HOURS = 4;
const DAY_RATE = 40_000;
const MULTI_DAY_RATE = 15_000;

async function addAllPricingTypes(locationId: string, owner: TestUser): Promise<void> {
  await addPricing(locationId, owner, { booking_type: "hourly", amount_minor_units: HOURLY_RATE });
  await addPricing(locationId, owner, {
    booking_type: "half_day",
    amount_minor_units: HALF_DAY_RATE,
    half_day_duration_hours: HALF_DAY_HOURS,
  });
  await addPricing(locationId, owner, { booking_type: "day", amount_minor_units: DAY_RATE });
  await addPricing(locationId, owner, { booking_type: "multi_day", amount_minor_units: MULTI_DAY_RATE });
}

// A location with Mon/Tue/Wed 09:00-18:00 availability and all four booking
// types priced — the shared fixture for Phase 6A type/overlap/derivation
// tests, matching the plan's "Location A" seed.
async function setupFullLocation(owner: TestUser): Promise<string> {
  const locationId = await createLocation(owner);
  await addRule(locationId, owner, "monday", "09:00", "18:00");
  await addRule(locationId, owner, "tuesday", "09:00", "18:00");
  await addRule(locationId, owner, "wednesday", "09:00", "18:00");
  await addAllPricingTypes(locationId, owner);
  await publish(locationId);
  return locationId;
}

// 2026-10-04..08 is Sun..Thu; 2026-10-05..09 is Mon..Fri.
const SUN = "2026-10-04";
const MON = "2026-10-05";
const TUE = "2026-10-06";
const WED = "2026-10-07";
const THU = "2026-10-08";

describe("bookings", () => {
  let host: TestUser;
  let otherHost: TestUser;
  let booker: TestUser;
  let otherBooker: TestUser;
  let plainUser: TestUser;
  let admin: TestUser;

  beforeAll(async () => {
    host = await createTestUser();
    otherHost = await createTestUser();
    booker = await createTestUser();
    otherBooker = await createTestUser();
    plainUser = await createTestUser();
    admin = await createTestUser();

    await grantRole(host, "host");
    await grantRole(otherHost, "host");
    await grantRole(booker, "booker");
    await grantRole(otherBooker, "booker");
    const { error } = await adminClient.from("user_roles").insert({ user_id: admin.id, role: "admin" });
    if (error) throw error;
  });

  afterAll(async () => {
    await deleteTestUser(host.id);
    await deleteTestUser(otherHost.id);
    await deleteTestUser(booker.id);
    await deleteTestUser(otherBooker.id);
    await deleteTestUser(plainUser.id);
    await deleteTestUser(admin.id);
  });

  describe("creation", () => {
    it("rejects an unauthenticated request", async () => {
      const res = await request(app).post("/v1/bookings").send({
        location_id: "00000000-0000-0000-0000-000000000000",
        start_at: `${MON}T10:00:00Z`,
        end_at: `${MON}T12:00:00Z`,
      });
      expect(res.status).toBe(401);
    });

    it("rejects a user with no booker role", async () => {
      const res = await request(app)
        .post("/v1/bookings")
        .set(authHeader(plainUser))
        .send({ location_id: "00000000-0000-0000-0000-000000000000", start_at: `${MON}T10:00:00Z`, end_at: `${MON}T12:00:00Z` });
      expect(res.status).toBe(403);
    });

    it("rejects a nonexistent location", async () => {
      const res = await request(app)
        .post("/v1/bookings")
        .set(authHeader(booker))
        .send({ location_id: "00000000-0000-0000-0000-000000000000", start_at: `${MON}T10:00:00Z`, end_at: `${MON}T12:00:00Z` });
      expect(res.status).toBe(404);
    });

    it("rejects an unpublished (draft) location", async () => {
      const locationId = await createLocation(host);
      await addRule(locationId, host, "monday", "09:00", "18:00");
      const res = await request(app)
        .post("/v1/bookings")
        .set(authHeader(booker))
        .send({ location_id: locationId, start_at: `${MON}T10:00:00Z`, end_at: `${MON}T12:00:00Z` });
      expect(res.status).toBe(404);
    });

    it("rejects end_at <= start_at", async () => {
      const locationId = await createLocation(host);
      await publish(locationId);
      const res = await request(app)
        .post("/v1/bookings")
        .set(authHeader(booker))
        .send({ location_id: locationId, start_at: `${MON}T12:00:00Z`, end_at: `${MON}T12:00:00Z` });
      expect(res.status).toBe(400);
    });

    it("rejects an interval outside any available window", async () => {
      const locationId = await createLocation(host);
      await addRule(locationId, host, "monday", "09:00", "18:00");
      await publish(locationId);
      const res = await request(app)
        .post("/v1/bookings")
        .set(authHeader(booker))
        .send({ location_id: locationId, start_at: `${MON}T19:00:00Z`, end_at: `${MON}T20:00:00Z` });
      expect(res.status).toBe(400);
    });

    it("rejects a booking overlapping a blocked period", async () => {
      const locationId = await createLocation(host);
      await addRule(locationId, host, "monday", "09:00", "18:00");
      await publish(locationId);
      await request(app)
        .post(`/v1/locations/${locationId}/blocks`)
        .set(authHeader(host))
        .send({ start_at: `${MON}T10:00:00Z`, end_at: `${MON}T12:00:00Z` });

      const res = await request(app)
        .post("/v1/bookings")
        .set(authHeader(booker))
        .send({ location_id: locationId, start_at: `${MON}T11:00:00Z`, end_at: `${MON}T13:00:00Z` });
      expect(res.status).toBe(400);
    });

    it("respects an availability override", async () => {
      const locationId = await createLocation(host);
      // Normally closed (no rule) — override opens it.
      await addHourlyPricing(locationId, host);
      await publish(locationId);
      await request(app)
        .post(`/v1/locations/${locationId}/availability/overrides`)
        .set(authHeader(host))
        .send({ date: MON, status: "available", start_time: "10:00", end_time: "14:00" });

      const outside = await request(app)
        .post("/v1/bookings")
        .set(authHeader(booker))
        .send({ location_id: locationId, start_at: `${MON}T14:00:00Z`, end_at: `${MON}T15:00:00Z` });
      expect(outside.status).toBe(400);

      const inside = await request(app)
        .post("/v1/bookings")
        .set(authHeader(booker))
        .send({ location_id: locationId, start_at: `${MON}T10:00:00Z`, end_at: `${MON}T11:00:00Z` });
      expect(inside.status).toBe(201);
      expect(inside.body.data.status).toBe("requested");
    });

    it("creates as confirmed immediately when instant_booking_enabled is set", async () => {
      const locationId = await createLocation(host, { instant_booking_enabled: true });
      await addRule(locationId, host, "monday", "09:00", "18:00");
      await addHourlyPricing(locationId, host);
      await publish(locationId);

      const res = await request(app)
        .post("/v1/bookings")
        .set(authHeader(booker))
        .send({ location_id: locationId, start_at: `${MON}T09:00:00Z`, end_at: `${MON}T10:00:00Z` });
      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe("confirmed");
    });

    it("an existing active booking prevents an overlapping one", async () => {
      const locationId = await createLocation(host);
      await addRule(locationId, host, "monday", "09:00", "18:00");
      await addHourlyPricing(locationId, host);
      await publish(locationId);

      const first = await request(app)
        .post("/v1/bookings")
        .set(authHeader(booker))
        .send({ location_id: locationId, start_at: `${MON}T10:00:00Z`, end_at: `${MON}T12:00:00Z` });
      expect(first.status).toBe(201);

      const overlapping = await request(app)
        .post("/v1/bookings")
        .set(authHeader(otherBooker))
        .send({ location_id: locationId, start_at: `${MON}T11:00:00Z`, end_at: `${MON}T13:00:00Z` });
      expect(overlapping.status).toBe(400);
    });
  });

  describe("interval boundaries", () => {
    let locationId: string;
    beforeAll(async () => {
      locationId = await createLocation(host);
      await addRule(locationId, host, "monday", "09:00", "18:00");
      await addHourlyPricing(locationId, host);
      await publish(locationId);
    });

    it("adjacent intervals both succeed", async () => {
      const a = await request(app)
        .post("/v1/bookings")
        .set(authHeader(booker))
        .send({ location_id: locationId, start_at: `${MON}T09:00:00Z`, end_at: `${MON}T10:00:00Z` });
      expect(a.status).toBe(201);

      const b = await request(app)
        .post("/v1/bookings")
        .set(authHeader(otherBooker))
        .send({ location_id: locationId, start_at: `${MON}T10:00:00Z`, end_at: `${MON}T11:00:00Z` });
      expect(b.status).toBe(201);
    });

    it("the exact same interval twice fails", async () => {
      const a = await request(app)
        .post("/v1/bookings")
        .set(authHeader(booker))
        .send({ location_id: locationId, start_at: `${MON}T13:00:00Z`, end_at: `${MON}T14:00:00Z` });
      expect(a.status).toBe(201);

      const b = await request(app)
        .post("/v1/bookings")
        .set(authHeader(otherBooker))
        .send({ location_id: locationId, start_at: `${MON}T13:00:00Z`, end_at: `${MON}T14:00:00Z` });
      expect(b.status).toBe(400);
    });

    it("a nested interval fails", async () => {
      const outer = await request(app)
        .post("/v1/bookings")
        .set(authHeader(booker))
        .send({ location_id: locationId, start_at: `${MON}T15:00:00Z`, end_at: `${MON}T17:00:00Z` });
      expect(outer.status).toBe(201);

      const inner = await request(app)
        .post("/v1/bookings")
        .set(authHeader(otherBooker))
        .send({ location_id: locationId, start_at: `${MON}T15:30:00Z`, end_at: `${MON}T16:00:00Z` });
      expect(inner.status).toBe(400);
    });
  });

  describe("multi-day bookings", () => {
    let locationId: string;
    beforeAll(async () => {
      locationId = await createLocation(host);
      await addRule(locationId, host, "monday", "09:00", "18:00");
      await addRule(locationId, host, "tuesday", "09:00", "18:00");
      await addRule(locationId, host, "wednesday", "09:00", "18:00");
      await addHourlyPricing(locationId, host);
      await publish(locationId);
    });

    it("succeeds when the span is gap-free", async () => {
      const res = await request(app)
        .post("/v1/bookings")
        .set(authHeader(booker))
        .send({ location_id: locationId, start_at: `${MON}T10:00:00Z`, end_at: `${WED}T12:00:00Z` });
      expect(res.status).toBe(201);
    });

    it("fails when a block sits in the middle of the span", async () => {
      await request(app)
        .post(`/v1/locations/${locationId}/blocks`)
        .set(authHeader(host))
        .send({ start_at: `${TUE}T10:00:00Z`, end_at: `${TUE}T11:00:00Z`, reason: "maintenance" });

      const res = await request(app)
        .post("/v1/bookings")
        .set(authHeader(otherBooker))
        .send({ location_id: locationId, start_at: `${MON}T10:00:00Z`, end_at: `${WED}T12:00:00Z` });
      expect(res.status).toBe(400);
    });
  });

  describe("concurrency (mandatory)", () => {
    it("exactly one of two truly simultaneous overlapping requests succeeds", async () => {
      const locationId = await createLocation(host);
      await addRule(locationId, host, "monday", "09:00", "18:00");
      await addHourlyPricing(locationId, host);
      await publish(locationId);

      const payload = { location_id: locationId, start_at: `${MON}T09:00:00Z`, end_at: `${MON}T11:00:00Z` };

      const [a, b] = await Promise.all([
        request(app).post("/v1/bookings").set(authHeader(booker)).send(payload),
        request(app).post("/v1/bookings").set(authHeader(otherBooker)).send(payload),
      ]);

      // Exactly one must succeed. The loser can legitimately land on either
      // 400 (its own is_interval_available pre-check ran after the winner's
      // insert had already committed) or 409 (it got all the way to the
      // exclusion constraint and lost there) — both are "failed safely";
      // which one depends on how tightly the two requests actually
      // interleaved, which Promise.all doesn't pin down. What must be true
      // regardless is the database-level guarantee, checked directly below:
      // exactly one active booking exists for this interval, full stop.
      const succeeded = [a, b].filter((r) => r.status === 201);
      const failed = [a, b].filter((r) => r.status !== 201);
      expect(succeeded).toHaveLength(1);
      expect(failed).toHaveLength(1);
      expect([400, 409]).toContain(failed[0]!.status);

      const { data, error } = await adminClient
        .from("bookings")
        .select("id")
        .eq("location_id", locationId)
        .eq("start_at", payload.start_at)
        .in("status", ["requested", "confirmed"]);
      if (error) throw error;
      expect(data).toHaveLength(1);
    });

    it("different locations can be booked simultaneously without interference", async () => {
      const locA = await createLocation(host);
      const locB = await createLocation(otherHost);
      await addRule(locA, host, "monday", "09:00", "18:00");
      await addRule(locB, otherHost, "monday", "09:00", "18:00");
      await addHourlyPricing(locA, host);
      await addHourlyPricing(locB, otherHost);
      await publish(locA);
      await publish(locB);

      const [a, b] = await Promise.all([
        request(app)
          .post("/v1/bookings")
          .set(authHeader(booker))
          .send({ location_id: locA, start_at: `${MON}T09:00:00Z`, end_at: `${MON}T11:00:00Z` }),
        request(app)
          .post("/v1/bookings")
          .set(authHeader(otherBooker))
          .send({ location_id: locB, start_at: `${MON}T09:00:00Z`, end_at: `${MON}T11:00:00Z` }),
      ]);
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
    });
  });

  describe("lifecycle & cancellation", () => {
    let locationId: string;
    let bookingId: string;

    beforeAll(async () => {
      locationId = await createLocation(host);
      await addRule(locationId, host, "monday", "09:00", "18:00");
      await addHourlyPricing(locationId, host);
      await publish(locationId);
      const res = await request(app)
        .post("/v1/bookings")
        .set(authHeader(booker))
        .send({ location_id: locationId, start_at: `${MON}T09:00:00Z`, end_at: `${MON}T10:00:00Z` });
      bookingId = res.body.data.id;
    });

    it("forbids a booker from confirming their own booking", async () => {
      const res = await request(app).post(`/v1/bookings/${bookingId}/confirm`).set(authHeader(booker));
      expect(res.status).toBe(403);
    });

    it("forbids an unrelated host from confirming", async () => {
      const res = await request(app).post(`/v1/bookings/${bookingId}/confirm`).set(authHeader(otherHost));
      expect(res.status).toBe(404); // not visible to a host who doesn't own this location
    });

    it("lets the owning host confirm it", async () => {
      const res = await request(app).post(`/v1/bookings/${bookingId}/confirm`).set(authHeader(host));
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("confirmed");
    });

    it("rejects confirming an already-confirmed booking", async () => {
      const res = await request(app).post(`/v1/bookings/${bookingId}/confirm`).set(authHeader(host));
      expect(res.status).toBe(400);
    });

    it("lets the booker cancel their own confirmed booking, releasing the interval", async () => {
      const res = await request(app).post(`/v1/bookings/${bookingId}/cancel`).set(authHeader(booker)).send({ reason: "change of plans" });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("cancelled");
      expect(res.body.data.cancelled_by).toBe(booker.id);

      // The exact same interval can be booked again immediately.
      const rebook = await request(app)
        .post("/v1/bookings")
        .set(authHeader(otherBooker))
        .send({ location_id: locationId, start_at: `${MON}T09:00:00Z`, end_at: `${MON}T10:00:00Z` });
      expect(rebook.status).toBe(201);
    });

    it("rejects cancelling an already-cancelled booking", async () => {
      const res = await request(app).post(`/v1/bookings/${bookingId}/cancel`).set(authHeader(booker));
      expect(res.status).toBe(400);
    });

    it("full reject flow: host rejects a requested booking", async () => {
      const create = await request(app)
        .post("/v1/bookings")
        .set(authHeader(booker))
        .send({ location_id: locationId, start_at: `${MON}T12:00:00Z`, end_at: `${MON}T13:00:00Z` });
      const id = create.body.data.id;

      const bookerReject = await request(app).post(`/v1/bookings/${id}/reject`).set(authHeader(booker));
      expect(bookerReject.status).toBe(403);

      const res = await request(app).post(`/v1/bookings/${id}/reject`).set(authHeader(host)).send({ reason: "not a good fit" });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("rejected");
    });

    it("full complete flow: host completes a confirmed booking", async () => {
      const create = await request(app)
        .post("/v1/bookings")
        .set(authHeader(booker))
        .send({ location_id: locationId, start_at: `${MON}T14:00:00Z`, end_at: `${MON}T15:00:00Z` });
      const id = create.body.data.id;

      const tooSoon = await request(app).post(`/v1/bookings/${id}/complete`).set(authHeader(host));
      expect(tooSoon.status).toBe(400); // still requested, not confirmed

      await request(app).post(`/v1/bookings/${id}/confirm`).set(authHeader(host));
      const res = await request(app).post(`/v1/bookings/${id}/complete`).set(authHeader(host));
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("completed");
    });

    it("admin can cancel a booking on a location they don't own", async () => {
      const create = await request(app)
        .post("/v1/bookings")
        .set(authHeader(booker))
        .send({ location_id: locationId, start_at: `${MON}T16:00:00Z`, end_at: `${MON}T17:00:00Z` });
      const id = create.body.data.id;

      const res = await request(app).post(`/v1/bookings/${id}/cancel`).set(authHeader(admin));
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("cancelled");
    });
  });

  describe("pricing", () => {
    it("calculates total as hourly rate times duration, stores a snapshot immune to later price changes", async () => {
      const locationId = await createLocation(host);
      await addRule(locationId, host, "monday", "09:00", "18:00");
      const pricingId = await addPricing(locationId, host, { booking_type: "hourly", amount_minor_units: 10_000 }); // 100.00/hr
      await publish(locationId);

      const res = await request(app)
        .post("/v1/bookings")
        .set(authHeader(booker))
        .send({ location_id: locationId, start_at: `${MON}T09:00:00Z`, end_at: `${MON}T11:30:00Z` }); // 2.5 hours
      expect(res.status).toBe(201);
      expect(res.body.data.booking_type).toBe("hourly");
      expect(res.body.data.pricing.base_amount_minor_units).toBe(25_000);
      expect(res.body.data.pricing.total_amount_minor_units).toBe(25_000);
      expect(res.body.data.pricing.currency).toBe("INR");

      // Rate changes afterward, at the pricing-configuration level — the
      // already-created booking's snapshot must not move.
      const { error } = await adminClient.from("location_pricing").update({ amount_minor_units: 99_999 }).eq("id", pricingId);
      if (error) throw error;

      const check = await request(app).get(`/v1/bookings/${res.body.data.id}`).set(authHeader(booker));
      expect(check.body.data.pricing.base_amount_minor_units).toBe(25_000);
    });

    it("rejects booking a location with no price set", async () => {
      const res0 = await request(app)
        .post("/v1/locations")
        .set(authHeader(host))
        .send({ title: "No price", city: "X", country: "Y" });
      const locationId = res0.body.data.id;
      await addRule(locationId, host, "monday", "09:00", "18:00");
      await publish(locationId);

      const res = await request(app)
        .post("/v1/bookings")
        .set(authHeader(booker))
        .send({ location_id: locationId, start_at: `${MON}T09:00:00Z`, end_at: `${MON}T10:00:00Z` });
      expect(res.status).toBe(400);
    });
  });

  describe("authorization on listing", () => {
    it("a booker only sees their own bookings, a host only sees bookings on their own locations, admin sees all", async () => {
      const locationId = await createLocation(host);
      await addRule(locationId, host, "monday", "09:00", "18:00");
      await addHourlyPricing(locationId, host);
      await publish(locationId);

      const mine = await request(app)
        .post("/v1/bookings")
        .set(authHeader(booker))
        .send({ location_id: locationId, start_at: `${MON}T09:00:00Z`, end_at: `${MON}T10:00:00Z` });
      const bookingId = mine.body.data.id;

      const bookerList = await request(app).get("/v1/bookings").set(authHeader(booker)).query({ pageSize: 100 });
      expect(bookerList.body.data.map((b: { id: string }) => b.id)).toContain(bookingId);

      const otherBookerList = await request(app).get("/v1/bookings").set(authHeader(otherBooker)).query({ pageSize: 100 });
      expect(otherBookerList.body.data.map((b: { id: string }) => b.id)).not.toContain(bookingId);

      const hostList = await request(app).get("/v1/bookings").set(authHeader(host)).query({ pageSize: 100 });
      expect(hostList.body.data.map((b: { id: string }) => b.id)).toContain(bookingId);

      const otherHostList = await request(app).get("/v1/bookings").set(authHeader(otherHost)).query({ pageSize: 100 });
      expect(otherHostList.body.data.map((b: { id: string }) => b.id)).not.toContain(bookingId);

      // Scoped by location_id rather than relying on an unfiltered page-1
      // listing staying under the page size -- admin's "see all" reach is
      // already proven by the RLS policy itself; across the whole test
      // suite (many files, each creating bookings) an unscoped admin query
      // can exceed one page well before this specific booking is reached.
      const adminList = await request(app)
        .get("/v1/bookings")
        .set(authHeader(admin))
        .query({ pageSize: 100, location_id: locationId });
      expect(adminList.body.data.map((b: { id: string }) => b.id)).toContain(bookingId);

      const bookerDetail = await request(app).get(`/v1/bookings/${bookingId}`).set(authHeader(booker));
      expect(bookerDetail.status).toBe(200);
      const unrelatedDetail = await request(app).get(`/v1/bookings/${bookingId}`).set(authHeader(otherBooker));
      expect(unrelatedDetail.status).toBe(404);
    });
  });

  describe("location deletion vs booking history", () => {
    it("cannot delete a location that has booking history", async () => {
      const locationId = await createLocation(host);
      await addRule(locationId, host, "monday", "09:00", "18:00");
      await addHourlyPricing(locationId, host);
      await publish(locationId);
      await request(app)
        .post("/v1/bookings")
        .set(authHeader(booker))
        .send({ location_id: locationId, start_at: `${MON}T09:00:00Z`, end_at: `${MON}T10:00:00Z` });

      const res = await request(app).delete(`/v1/locations/${locationId}`).set(authHeader(host));
      expect(res.status).toBe(409);
    });
  });

  describe("Phase 6A: booking types & pricing", () => {
    describe("pricing correctness per type", () => {
      it("half_day charges the flat configured rate and derives end_at from the configured duration", async () => {
        const locationId = await setupFullLocation(host);
        const res = await request(app)
          .post("/v1/bookings")
          .set(authHeader(booker))
          .send({ location_id: locationId, booking_type: "half_day", start_at: `${MON}T09:00:00Z` });
        expect(res.status).toBe(201);
        expect(res.body.data.booking_type).toBe("half_day");
        expect(new Date(res.body.data.start_at).toISOString()).toBe(`${MON}T09:00:00.000Z`);
        expect(new Date(res.body.data.end_at).toISOString()).toBe(`${MON}T13:00:00.000Z`); // start + configured 4h
        expect(res.body.data.pricing.base_amount_minor_units).toBe(HALF_DAY_RATE);
        expect(res.body.data.pricing.total_amount_minor_units).toBe(HALF_DAY_RATE);
      });

      it("day charges the flat configured rate and derives its span from the day's actual availability", async () => {
        const locationId = await setupFullLocation(host);
        const res = await request(app)
          .post("/v1/bookings")
          .set(authHeader(booker))
          .send({ location_id: locationId, booking_type: "day", date: MON });
        expect(res.status).toBe(201);
        expect(res.body.data.booking_type).toBe("day");
        expect(new Date(res.body.data.start_at).toISOString()).toBe(`${MON}T09:00:00.000Z`);
        expect(new Date(res.body.data.end_at).toISOString()).toBe(`${MON}T18:00:00.000Z`);
        expect(res.body.data.pricing.base_amount_minor_units).toBe(DAY_RATE);
        expect(res.body.data.pricing.total_amount_minor_units).toBe(DAY_RATE);
      });

      it("multi_day charges the day rate times the inclusive number of production days (15,000 x 3 days = 45,000)", async () => {
        const locationId = await setupFullLocation(host);
        const res = await request(app)
          .post("/v1/bookings")
          .set(authHeader(booker))
          .send({ location_id: locationId, booking_type: "multi_day", start_date: MON, end_date: WED });
        expect(res.status).toBe(201);
        expect(res.body.data.booking_type).toBe("multi_day");
        expect(new Date(res.body.data.start_at).toISOString()).toBe(`${MON}T09:00:00.000Z`);
        expect(new Date(res.body.data.end_at).toISOString()).toBe(`${WED}T18:00:00.000Z`);
        expect(res.body.data.pricing.base_amount_minor_units).toBe(MULTI_DAY_RATE * 3);
        expect(res.body.data.pricing.total_amount_minor_units).toBe(MULTI_DAY_RATE * 3);
      });

      it("price snapshots for half_day/day/multi_day are immune to a later rate change, same as hourly", async () => {
        const locationId = await setupFullLocation(host);
        const list = await request(app).get(`/v1/locations/${locationId}/pricing`).set(authHeader(host));
        const dayRow = list.body.data.find((p: { booking_type: string }) => p.booking_type === "day");

        const booking = await request(app)
          .post("/v1/bookings")
          .set(authHeader(booker))
          .send({ location_id: locationId, booking_type: "day", date: TUE });
        expect(booking.status).toBe(201);
        expect(booking.body.data.pricing.base_amount_minor_units).toBe(DAY_RATE);

        const { error } = await adminClient.from("location_pricing").update({ amount_minor_units: 1 }).eq("id", dayRow.id);
        if (error) throw error;

        const check = await request(app).get(`/v1/bookings/${booking.body.data.id}`).set(authHeader(booker));
        expect(check.body.data.pricing.base_amount_minor_units).toBe(DAY_RATE);
      });
    });

    describe("type availability", () => {
      it("a type with no active pricing configured cannot be booked", async () => {
        const locationId = await createLocation(host);
        await addRule(locationId, host, "monday", "09:00", "18:00");
        await addHourlyPricing(locationId, host);
        await publish(locationId);

        const res = await request(app)
          .post("/v1/bookings")
          .set(authHeader(booker))
          .send({ location_id: locationId, booking_type: "day", date: MON });
        expect(res.status).toBe(400);
      });

      it("omitting booking_type entirely still defaults to hourly (backward compatibility)", async () => {
        const locationId = await createLocation(host);
        await addRule(locationId, host, "monday", "09:00", "18:00");
        await addHourlyPricing(locationId, host);
        await publish(locationId);

        const res = await request(app)
          .post("/v1/bookings")
          .set(authHeader(booker))
          .send({ location_id: locationId, start_at: `${MON}T09:00:00Z`, end_at: `${MON}T10:00:00Z` });
        expect(res.status).toBe(201);
        expect(res.body.data.booking_type).toBe("hourly");
      });
    });

    describe("day/multi_day interval derivation", () => {
      it("rejects a day booking when that day's schedule has a gap (not one continuous window)", async () => {
        const locationId = await createLocation(host);
        await addRule(locationId, host, "thursday", "09:00", "12:00");
        await addRule(locationId, host, "thursday", "14:00", "18:00");
        await addPricing(locationId, host, { booking_type: "day", amount_minor_units: DAY_RATE });
        await publish(locationId);

        const res = await request(app)
          .post("/v1/bookings")
          .set(authHeader(booker))
          .send({ location_id: locationId, booking_type: "day", date: THU });
        expect(res.status).toBe(400);
      });

      it("rejects a multi_day booking whose check-in date has no availability at all", async () => {
        const locationId = await setupFullLocation(host);
        const res = await request(app)
          .post("/v1/bookings")
          .set(authHeader(booker))
          .send({ location_id: locationId, booking_type: "multi_day", start_date: SUN, end_date: WED });
        expect(res.status).toBe(400);
      });
    });

    describe("cross-type overlap conflicts", () => {
      it("hourly vs half_day: an overlapping hourly request conflicts with an existing half_day booking", async () => {
        const locationId = await setupFullLocation(host);
        const half = await request(app)
          .post("/v1/bookings")
          .set(authHeader(booker))
          .send({ location_id: locationId, booking_type: "half_day", start_at: `${MON}T09:00:00Z` }); // resolves 09:00-13:00
        expect(half.status).toBe(201);

        const hourly = await request(app)
          .post("/v1/bookings")
          .set(authHeader(otherBooker))
          .send({ location_id: locationId, booking_type: "hourly", start_at: `${MON}T12:00:00Z`, end_at: `${MON}T14:00:00Z` });
        expect(hourly.status).toBe(400);
      });

      it("half_day vs day: a half_day request inside an existing day booking's span conflicts", async () => {
        const locationId = await setupFullLocation(host);
        const day = await request(app)
          .post("/v1/bookings")
          .set(authHeader(booker))
          .send({ location_id: locationId, booking_type: "day", date: MON }); // resolves 09:00-18:00
        expect(day.status).toBe(201);

        const half = await request(app)
          .post("/v1/bookings")
          .set(authHeader(otherBooker))
          .send({ location_id: locationId, booking_type: "half_day", start_at: `${MON}T10:00:00Z` });
        expect(half.status).toBe(400);
      });

      it("day vs multi_day: a day booking on a date already inside a multi_day span conflicts", async () => {
        const locationId = await setupFullLocation(host);
        const multi = await request(app)
          .post("/v1/bookings")
          .set(authHeader(booker))
          .send({ location_id: locationId, booking_type: "multi_day", start_date: MON, end_date: WED });
        expect(multi.status).toBe(201);

        const day = await request(app)
          .post("/v1/bookings")
          .set(authHeader(otherBooker))
          .send({ location_id: locationId, booking_type: "day", date: TUE });
        expect(day.status).toBe(400);
      });

      it("multi_day vs multi_day: overlapping spans conflict", async () => {
        const locationId = await setupFullLocation(host);
        const first = await request(app)
          .post("/v1/bookings")
          .set(authHeader(booker))
          .send({ location_id: locationId, booking_type: "multi_day", start_date: MON, end_date: TUE });
        expect(first.status).toBe(201);

        const second = await request(app)
          .post("/v1/bookings")
          .set(authHeader(otherBooker))
          .send({ location_id: locationId, booking_type: "multi_day", start_date: TUE, end_date: WED });
        expect(second.status).toBe(400);
      });

      it("adjacent cross-type bookings succeed: an hourly booking starting exactly when a half_day booking ends", async () => {
        const locationId = await setupFullLocation(host);
        const half = await request(app)
          .post("/v1/bookings")
          .set(authHeader(booker))
          .send({ location_id: locationId, booking_type: "half_day", start_at: `${MON}T09:00:00Z` }); // 09:00-13:00
        expect(half.status).toBe(201);

        const hourly = await request(app)
          .post("/v1/bookings")
          .set(authHeader(otherBooker))
          .send({ location_id: locationId, booking_type: "hourly", start_at: `${MON}T13:00:00Z`, end_at: `${MON}T14:00:00Z` });
        expect(hourly.status).toBe(201);
      });
    });

    describe("cross-type concurrency", () => {
      it("exactly one of two truly simultaneous overlapping requests of different types succeeds", async () => {
        const locationId = await setupFullLocation(host);

        const [a, b] = await Promise.all([
          request(app)
            .post("/v1/bookings")
            .set(authHeader(booker))
            .send({ location_id: locationId, booking_type: "half_day", start_at: `${MON}T09:00:00Z` }),
          request(app)
            .post("/v1/bookings")
            .set(authHeader(otherBooker))
            .send({ location_id: locationId, booking_type: "hourly", start_at: `${MON}T10:00:00Z`, end_at: `${MON}T11:00:00Z` }),
        ]);

        const succeeded = [a, b].filter((r) => r.status === 201);
        const failed = [a, b].filter((r) => r.status !== 201);
        expect(succeeded).toHaveLength(1);
        expect(failed).toHaveLength(1);
        expect([400, 409]).toContain(failed[0]!.status);

        const { data, error } = await adminClient
          .from("bookings")
          .select("id")
          .eq("location_id", locationId)
          .in("status", ["requested", "confirmed"]);
        if (error) throw error;
        expect(data).toHaveLength(1);
      });
    });
  });
});
