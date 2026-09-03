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

async function categoryId(name: string): Promise<string> {
  const { data, error } = await adminClient.from("categories").select("id").eq("name", name).single();
  if (error || !data) throw error ?? new Error(`category ${name} not found`);
  return data.id;
}

async function amenityId(name: string): Promise<string> {
  const { data, error } = await adminClient.from("amenities").select("id").eq("name", name).single();
  if (error || !data) throw error ?? new Error(`amenity ${name} not found`);
  return data.id;
}

async function useCaseId(name: string): Promise<string> {
  const { data, error } = await adminClient.from("use_cases").select("id").eq("name", name).single();
  if (error || !data) throw error ?? new Error(`use_case ${name} not found`);
  return data.id;
}

interface SeedInput {
  title: string;
  description?: string;
  city: string;
  country: string;
  region?: string;
  latitude?: number;
  longitude?: number;
  capacity?: number;
  category_ids?: string[];
  amenity_ids?: string[];
  use_case_ids?: string[];
  status?: string; // defaults to published
}

async function seedLocation(host: TestUser, admin: TestUser, input: SeedInput): Promise<string> {
  const res = await request(app)
    .post("/v1/locations")
    .set(authHeader(host))
    .send({
      title: input.title,
      description: input.description ?? "",
      city: input.city,
      country: input.country,
      region: input.region,
      latitude: input.latitude,
      longitude: input.longitude,
      capacity: input.capacity,
      category_ids: input.category_ids ?? [],
      amenity_ids: input.amenity_ids ?? [],
      use_case_ids: input.use_case_ids ?? [],
    });
  expect(res.status).toBe(201);
  const id = res.body.data.id as string;

  const status = input.status ?? "published";
  if (status !== "draft") {
    const { error } = await adminClient.from("locations").update({ status }).eq("id", id);
    if (error) throw error;
  }
  return id;
}

function ids(res: request.Response): string[] {
  return res.body.data.map((l: { id: string }) => l.id);
}

describe("search & discovery", () => {
  let host: TestUser;
  let admin: TestUser;

  // Two published locations a few km apart in London, one published in
  // Mumbai (far away), one draft, one suspended.
  let londonStudio: string;
  let londonWarehouse: string;
  let mumbaiVilla: string;
  let draftLocation: string;
  let suspendedLocation: string;

  let studioCat: string;
  let outdoorCat: string;
  let parkingAmenity: string;
  let wifiAmenity: string;
  let filmUseCase: string;
  let photographyUseCase: string;

  beforeAll(async () => {
    host = await createTestUser();
    admin = await createTestUser();
    await grantHostRole(host);

    studioCat = await categoryId("Studio");
    outdoorCat = await categoryId("Outdoor");
    parkingAmenity = await amenityId("Parking");
    wifiAmenity = await amenityId("Wi-Fi");
    filmUseCase = await useCaseId("Film");
    photographyUseCase = await useCaseId("Photography");

    londonStudio = await seedLocation(host, admin, {
      title: "East London Film Studio",
      description: "A versatile studio with natural light for shoots.",
      city: "London",
      country: "UK",
      region: "Greater London",
      latitude: 51.5285,
      longitude: -0.0775,
      capacity: 40,
      category_ids: [studioCat],
      amenity_ids: [parkingAmenity, wifiAmenity],
      use_case_ids: [filmUseCase],
    });

    londonWarehouse = await seedLocation(host, admin, {
      title: "Shoreditch Warehouse",
      description: "Raw industrial warehouse space.",
      city: "London",
      country: "UK",
      region: "Greater London",
      latitude: 51.5233,
      longitude: -0.0785, // ~0.6km from londonStudio
      capacity: 100,
      category_ids: [outdoorCat],
      amenity_ids: [parkingAmenity], // only parking, not wifi
      use_case_ids: [photographyUseCase],
    });

    mumbaiVilla = await seedLocation(host, admin, {
      title: "Bandra Penthouse Villa",
      description: "Sea-view penthouse for luxury campaigns.",
      city: "Mumbai",
      country: "IN",
      latitude: 19.0596,
      longitude: 72.8295,
      capacity: 20,
      category_ids: [studioCat],
    });

    draftLocation = await seedLocation(host, admin, {
      title: "Unfinished Draft Studio",
      city: "London",
      country: "UK",
      status: "draft",
    });

    suspendedLocation = await seedLocation(host, admin, {
      title: "Suspended Studio Listing",
      city: "London",
      country: "UK",
      latitude: 51.5,
      longitude: -0.08,
      status: "suspended",
    });
  });

  afterAll(async () => {
    await deleteTestUser(host.id);
    await deleteTestUser(admin.id);
  });

  it("does not expose draft or suspended locations", async () => {
    const res = await request(app).get("/v1/locations").query({ pageSize: 50 });
    expect(res.status).toBe(200);
    const resultIds = ids(res);
    expect(resultIds).not.toContain(draftLocation);
    expect(resultIds).not.toContain(suspendedLocation);
    expect(resultIds).toContain(londonStudio);
  });

  it("returns a compact card, not the full location object", async () => {
    const res = await request(app).get("/v1/locations").query({ search: "East London Film Studio", pageSize: 5 });
    const card = res.body.data[0];
    expect(card).toMatchObject({ id: londonStudio, title: "East London Film Studio", city: "London" });
    expect(card.host_id).toBeUndefined();
    expect(card.status).toBeUndefined();
    expect(card.description).toBeUndefined();
    expect(typeof card.excerpt).toBe("string");
    expect(Array.isArray(card.categories)).toBe(true);
    expect(card.categories[0]).toMatchObject({ name: "Studio" });
  });

  it("full-text search matches title/description and misses unrelated listings", async () => {
    const res = await request(app).get("/v1/locations").query({ search: "warehouse", pageSize: 20 });
    const resultIds = ids(res);
    expect(resultIds).toContain(londonWarehouse);
    expect(resultIds).not.toContain(mumbaiVilla);
  });

  it("filters by city", async () => {
    const res = await request(app).get("/v1/locations").query({ city: "Mumbai", pageSize: 20 });
    expect(ids(res)).toEqual([mumbaiVilla]);
  });

  it("filters by category with OR semantics across multiple ids", async () => {
    const res = await request(app)
      .get("/v1/locations")
      .query({ category_ids: `${studioCat},${outdoorCat}`, pageSize: 20 });
    const resultIds = ids(res);
    expect(resultIds).toEqual(expect.arrayContaining([londonStudio, londonWarehouse, mumbaiVilla]));
  });

  it("filters amenities with AND semantics (must hold every requested amenity)", async () => {
    const bothRes = await request(app)
      .get("/v1/locations")
      .query({ amenity_ids: `${parkingAmenity},${wifiAmenity}`, pageSize: 20 });
    // londonWarehouse has parking but not wifi, so it must be excluded.
    expect(ids(bothRes)).toContain(londonStudio);
    expect(ids(bothRes)).not.toContain(londonWarehouse);

    const parkingOnlyRes = await request(app).get("/v1/locations").query({ amenity_ids: parkingAmenity, pageSize: 20 });
    expect(ids(parkingOnlyRes)).toEqual(expect.arrayContaining([londonStudio, londonWarehouse]));
  });

  it("filters by use_case", async () => {
    const res = await request(app).get("/v1/locations").query({ use_case_ids: photographyUseCase, pageSize: 20 });
    expect(ids(res)).toEqual([londonWarehouse]);
  });

  it("filters by capacity range", async () => {
    const res = await request(app).get("/v1/locations").query({ capacity_min: 50, capacity_max: 200, pageSize: 20 });
    expect(ids(res)).toEqual([londonWarehouse]);
  });

  it("combines multiple filters in one request", async () => {
    // londonWarehouse is also in London but has capacity 100, outside this range.
    const res = await request(app)
      .get("/v1/locations")
      .query({ city: "London", capacity_min: 30, capacity_max: 50, pageSize: 20 });
    expect(ids(res)).toEqual([londonStudio]);
  });

  describe("geographic search", () => {
    it("radius search includes nearby results and excludes distant ones", async () => {
      const res = await request(app).get("/v1/locations").query({ lat: 51.526, lng: -0.078, radius_km: 5, pageSize: 20 });
      const resultIds = ids(res);
      expect(resultIds).toEqual(expect.arrayContaining([londonStudio, londonWarehouse]));
      expect(resultIds).not.toContain(mumbaiVilla);
    });

    it("orders by distance when sort=nearest", async () => {
      const res = await request(app)
        .get("/v1/locations")
        .query({ lat: 51.5233, lng: -0.0785, sort: "nearest", pageSize: 20 });
      const resultIds = ids(res);
      // londonWarehouse is exactly at these coordinates, so it must come first.
      expect(resultIds[0]).toBe(londonWarehouse);
      const warehouseCard = res.body.data.find((l: { id: string }) => l.id === londonWarehouse);
      expect(warehouseCard.distance_km).toBeLessThan(0.1);
    });

    it("bounding-box search returns only locations inside the box", async () => {
      const res = await request(app)
        .get("/v1/locations")
        .query({ north: 51.6, south: 51.4, east: 0.1, west: -0.2, pageSize: 20 });
      const resultIds = ids(res);
      expect(resultIds).toEqual(expect.arrayContaining([londonStudio, londonWarehouse]));
      expect(resultIds).not.toContain(mumbaiVilla);
    });
  });

  describe("sorting and pagination", () => {
    it("sorts newest first by default with no search term", async () => {
      const res = await request(app).get("/v1/locations").query({ city: "London", pageSize: 20 });
      const createdAts = res.body.data.map((l: { created_at: string }) => new Date(l.created_at).getTime());
      expect(createdAts).toEqual([...createdAts].sort((a, b) => b - a));
    });

    it("paginates results and reports total", async () => {
      const page1 = await request(app).get("/v1/locations").query({ city: "London", page: 1, pageSize: 1 });
      expect(page1.body.data).toHaveLength(1);
      expect(page1.body.meta.total).toBeGreaterThanOrEqual(2);

      const page2 = await request(app).get("/v1/locations").query({ city: "London", page: 2, pageSize: 1 });
      expect(page2.body.data[0].id).not.toBe(page1.body.data[0].id);
    });

    it("rejects an oversized pageSize (same convention as every other list endpoint)", async () => {
      const res = await request(app).get("/v1/locations").query({ pageSize: 500 });
      expect(res.status).toBe(400);
    });
  });

  describe("input validation", () => {
    it("rejects an out-of-range latitude", async () => {
      const res = await request(app).get("/v1/locations").query({ lat: 999, lng: 0 });
      expect(res.status).toBe(400);
    });

    it("rejects a radius over the configured maximum", async () => {
      const res = await request(app).get("/v1/locations").query({ lat: 0, lng: 0, radius_km: 100000 });
      expect(res.status).toBe(400);
    });

    it("rejects a partial bounding box", async () => {
      const res = await request(app).get("/v1/locations").query({ north: 1, south: 0, east: 1 });
      expect(res.status).toBe(400);
    });

    it("rejects north <= south", async () => {
      const res = await request(app).get("/v1/locations").query({ north: 0, south: 1, east: 1, west: 0 });
      expect(res.status).toBe(400);
    });

    it("rejects an invalid category UUID", async () => {
      const res = await request(app).get("/v1/locations").query({ category_ids: "not-a-uuid" });
      expect(res.status).toBe(400);
    });

    it("rejects sort=nearest without coordinates", async () => {
      const res = await request(app).get("/v1/locations").query({ sort: "nearest" });
      expect(res.status).toBe(400);
    });

    it("rejects capacity_min greater than capacity_max", async () => {
      const res = await request(app).get("/v1/locations").query({ capacity_min: 100, capacity_max: 10 });
      expect(res.status).toBe(400);
    });
  });
});
