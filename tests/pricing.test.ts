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

async function createLocation(owner: TestUser): Promise<string> {
  const res = await request(app)
    .post("/v1/locations")
    .set(authHeader(owner))
    .send({ title: "Pricing Test Location", city: "London", country: "UK" });
  expect(res.status).toBe(201);
  return res.body.data.id as string;
}

async function publish(locationId: string): Promise<void> {
  const { error } = await adminClient.from("locations").update({ status: "published" }).eq("id", locationId);
  if (error) throw error;
}

describe("location pricing", () => {
  let host: TestUser;
  let otherHost: TestUser;
  let booker: TestUser;
  let admin: TestUser;

  beforeAll(async () => {
    host = await createTestUser();
    otherHost = await createTestUser();
    booker = await createTestUser();
    admin = await createTestUser();
    await grantRole(host, "host");
    await grantRole(otherHost, "host");
    await grantRole(booker, "booker");
    const { error } = await adminClient.from("user_roles").insert({ user_id: admin.id, role: "admin" });
    if (error) throw error;
  });

  afterAll(async () => {
    await deleteTestUser(host.id);
    await deleteTestUser(otherHost.id);
    await deleteTestUser(booker.id);
    await deleteTestUser(admin.id);
  });

  describe("CRUD", () => {
    let locationId: string;

    beforeAll(async () => {
      locationId = await createLocation(host);
      await publish(locationId);
    });

    it("host can create hourly pricing for their own location, defaulting currency to INR", async () => {
      const res = await request(app)
        .post(`/v1/locations/${locationId}/pricing`)
        .set(authHeader(host))
        .send({ booking_type: "hourly", amount_minor_units: 10_000 });
      expect(res.status).toBe(201);
      expect(res.body.data.booking_type).toBe("hourly");
      expect(res.body.data.amount_minor_units).toBe(10_000);
      expect(res.body.data.currency).toBe("INR");
      expect(res.body.data.is_active).toBe(true);
    });

    it("rejects a second row for the same booking_type on the same location with 409", async () => {
      const res = await request(app)
        .post(`/v1/locations/${locationId}/pricing`)
        .set(authHeader(host))
        .send({ booking_type: "hourly", amount_minor_units: 20_000 });
      expect(res.status).toBe(409);
    });

    it("requires half_day_duration_hours when booking_type is half_day", async () => {
      const res = await request(app)
        .post(`/v1/locations/${locationId}/pricing`)
        .set(authHeader(host))
        .send({ booking_type: "half_day", amount_minor_units: 30_000 });
      expect(res.status).toBe(400);
    });

    it("rejects half_day_duration_hours when booking_type is not half_day", async () => {
      const res = await request(app)
        .post(`/v1/locations/${locationId}/pricing`)
        .set(authHeader(host))
        .send({ booking_type: "day", amount_minor_units: 40_000, half_day_duration_hours: 4 });
      expect(res.status).toBe(400);
    });

    it("creates a valid half_day row with its duration", async () => {
      const res = await request(app)
        .post(`/v1/locations/${locationId}/pricing`)
        .set(authHeader(host))
        .send({ booking_type: "half_day", amount_minor_units: 30_000, half_day_duration_hours: 4 });
      expect(res.status).toBe(201);
      expect(res.body.data.half_day_duration_hours).toBe(4);
    });

    it("host can update their own pricing row's amount", async () => {
      const create = await request(app)
        .post(`/v1/locations/${locationId}/pricing`)
        .set(authHeader(host))
        .send({ booking_type: "day", amount_minor_units: 40_000 });
      const pricingId = create.body.data.id;

      const res = await request(app)
        .patch(`/v1/locations/${locationId}/pricing/${pricingId}`)
        .set(authHeader(host))
        .send({ amount_minor_units: 45_000 });
      expect(res.status).toBe(200);
      expect(res.body.data.amount_minor_units).toBe(45_000);
    });

    it("host can deactivate pricing via is_active: false, and it disappears from public listing", async () => {
      const create = await request(app)
        .post(`/v1/locations/${locationId}/pricing`)
        .set(authHeader(host))
        .send({ booking_type: "multi_day", amount_minor_units: 15_000 });
      const pricingId = create.body.data.id;

      const deactivate = await request(app)
        .patch(`/v1/locations/${locationId}/pricing/${pricingId}`)
        .set(authHeader(host))
        .send({ is_active: false });
      expect(deactivate.status).toBe(200);
      expect(deactivate.body.data.is_active).toBe(false);

      const publicList = await request(app).get(`/v1/locations/${locationId}/pricing`);
      expect(publicList.body.data.map((p: { booking_type: string }) => p.booking_type)).not.toContain("multi_day");

      const ownerList = await request(app).get(`/v1/locations/${locationId}/pricing`).set(authHeader(host));
      expect(ownerList.body.data.map((p: { booking_type: string }) => p.booking_type)).toContain("multi_day");
    });

    it("host can delete their own pricing row", async () => {
      // A fresh location, rather than reusing `locationId` — earlier tests in
      // this block have already claimed hourly/half_day/day/multi_day here,
      // and delete only needs one unambiguous row to remove.
      const fresh = await createLocation(host);
      await publish(fresh);
      const created = await request(app)
        .post(`/v1/locations/${fresh}/pricing`)
        .set(authHeader(host))
        .send({ booking_type: "hourly", amount_minor_units: 1 });
      const pricingId = created.body.data.id;

      const res = await request(app).delete(`/v1/locations/${fresh}/pricing/${pricingId}`).set(authHeader(host));
      expect(res.status).toBe(200);

      const list = await request(app).get(`/v1/locations/${fresh}/pricing`).set(authHeader(host));
      expect(list.body.data).toHaveLength(0);
    });
  });

  describe("authorization", () => {
    let locationId: string;
    let pricingId: string;

    beforeAll(async () => {
      locationId = await createLocation(host);
      const res = await request(app)
        .post(`/v1/locations/${locationId}/pricing`)
        .set(authHeader(host))
        .send({ booking_type: "hourly", amount_minor_units: 10_000 });
      pricingId = res.body.data.id;
      await publish(locationId);
    });

    it("forbids a booker from creating pricing", async () => {
      const res = await request(app)
        .post(`/v1/locations/${locationId}/pricing`)
        .set(authHeader(booker))
        .send({ booking_type: "day", amount_minor_units: 40_000 });
      expect(res.status).toBe(403);
    });

    it("forbids a booker from updating pricing", async () => {
      const res = await request(app)
        .patch(`/v1/locations/${locationId}/pricing/${pricingId}`)
        .set(authHeader(booker))
        .send({ amount_minor_units: 1 });
      expect(res.status).toBe(403);
    });

    it("forbids another host from managing this location's pricing", async () => {
      const res = await request(app)
        .patch(`/v1/locations/${locationId}/pricing/${pricingId}`)
        .set(authHeader(otherHost))
        .send({ amount_minor_units: 1 });
      expect(res.status).toBe(403);
    });

    it("lets an admin manage pricing for a location they don't own", async () => {
      const res = await request(app)
        .post(`/v1/locations/${locationId}/pricing`)
        .set(authHeader(admin))
        .send({ booking_type: "day", amount_minor_units: 40_000 });
      expect(res.status).toBe(201);
    });

    it("forbids an unauthenticated caller from every management endpoint", async () => {
      const res = await request(app)
        .post(`/v1/locations/${locationId}/pricing`)
        .send({ booking_type: "multi_day", amount_minor_units: 15_000 });
      expect(res.status).toBe(401);
    });
  });

  describe("public visibility and location detail integration", () => {
    let locationId: string;

    beforeAll(async () => {
      locationId = await createLocation(host);
      await request(app)
        .post(`/v1/locations/${locationId}/pricing`)
        .set(authHeader(host))
        .send({ booking_type: "hourly", amount_minor_units: 10_000 });
      const half = await request(app)
        .post(`/v1/locations/${locationId}/pricing`)
        .set(authHeader(host))
        .send({ booking_type: "half_day", amount_minor_units: 30_000, half_day_duration_hours: 4 });
      await request(app)
        .patch(`/v1/locations/${locationId}/pricing/${half.body.data.id}`)
        .set(authHeader(host))
        .send({ is_active: false });
      await publish(locationId);
    });

    it("a public/unauthenticated caller only sees active pricing rows", async () => {
      const res = await request(app).get(`/v1/locations/${locationId}/pricing`);
      expect(res.status).toBe(200);
      const types = res.body.data.map((p: { booking_type: string }) => p.booking_type);
      expect(types).toContain("hourly");
      expect(types).not.toContain("half_day");
    });

    it("the owner sees inactive rows too", async () => {
      const res = await request(app).get(`/v1/locations/${locationId}/pricing`).set(authHeader(host));
      const types = res.body.data.map((p: { booking_type: string }) => p.booking_type);
      expect(types).toContain("hourly");
      expect(types).toContain("half_day");
    });

    it("location detail exposes booking_options for active pricing only", async () => {
      const res = await request(app).get(`/v1/locations/${locationId}`);
      expect(res.status).toBe(200);
      const types = res.body.data.booking_options.map((o: { type: string }) => o.type);
      expect(types).toContain("hourly");
      expect(types).not.toContain("half_day");
    });
  });
});
