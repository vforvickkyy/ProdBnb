import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { createUserScopedClient } from "../src/lib/supabase";
import { adminClient, createTestUser, deleteTestUser, grantAdminRole, TestUser } from "./setup";

const app = createApp();

async function grantHostRole(user: TestUser): Promise<void> {
  const res = await request(app).post("/v1/me/roles").set("Authorization", `Bearer ${user.accessToken}`).send({ role: "host" });
  expect(res.status).toBe(201);
}

async function getCategoryIds(names: string[]): Promise<string[]> {
  const { data, error } = await adminClient.from("categories").select("id, name").in("name", names);
  if (error || !data) throw error ?? new Error("Failed to load categories");
  return data.map((c: { id: string }) => c.id);
}

describe("locations", () => {
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
    await grantAdminRole(admin.id);
  });

  afterAll(async () => {
    await deleteTestUser(host.id);
    await deleteTestUser(otherHost.id);
    await deleteTestUser(booker.id);
    await deleteTestUser(admin.id);
  });

  it("lets an unauthenticated caller list public locations", async () => {
    const res = await request(app).get("/v1/locations");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.meta).toMatchObject({ page: 1, pageSize: 20 });
  });

  it("forbids a booker from creating a location", async () => {
    const res = await request(app)
      .post("/v1/locations")
      .set("Authorization", `Bearer ${booker.accessToken}`)
      .send({ title: "Should not work", city: "London", country: "UK" });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("rejects location creation with a missing title", async () => {
    const res = await request(app)
      .post("/v1/locations")
      .set("Authorization", `Bearer ${host.accessToken}`)
      .send({ city: "London", country: "UK" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects out-of-range coordinates", async () => {
    const res = await request(app)
      .post("/v1/locations")
      .set("Authorization", `Bearer ${host.accessToken}`)
      .send({ title: "Bad coords", city: "London", country: "UK", latitude: 999 });

    expect(res.status).toBe(400);
  });

  it("rejects a nonexistent category id", async () => {
    const res = await request(app)
      .post("/v1/locations")
      .set("Authorization", `Bearer ${host.accessToken}`)
      .send({
        title: "Bad category",
        city: "London",
        country: "UK",
        category_ids: ["00000000-0000-0000-0000-000000000000"],
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  describe("full lifecycle", () => {
    let locationId: string;

    it("lets a host create a draft with categories/amenities/use-cases", async () => {
      const [categoryIds, amenities, useCases] = await Promise.all([
        getCategoryIds(["Studio"]),
        adminClient.from("amenities").select("id, name").eq("name", "Parking"),
        adminClient.from("use_cases").select("id, name").eq("name", "Film"),
      ]);

      const res = await request(app)
        .post("/v1/locations")
        .set("Authorization", `Bearer ${host.accessToken}`)
        .send({
          title: "East London Film Studio",
          description: "A versatile studio space.",
          city: "London",
          country: "UK",
          latitude: 51.5285,
          longitude: -0.0775,
          capacity: 40,
          category_ids: categoryIds,
          amenity_ids: [amenities.data![0]!.id],
          use_case_ids: [useCases.data![0]!.id],
        });

      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe("draft");
      expect(res.body.data.host_id).toBe(host.id);
      expect(res.body.data.categories).toEqual([{ id: categoryIds[0], name: "Studio" }]);
      expect(res.body.data.amenities.map((a: { name: string }) => a.name)).toEqual(["Parking"]);
      expect(res.body.data.use_cases.map((u: { name: string }) => u.name)).toEqual(["Film"]);
      expect(res.body.data.media).toEqual([]);
      // Brand new host has no published locations yet, so no public host summary.
      expect(res.body.data.host).toBeNull();

      locationId = res.body.data.id;
    });

    it("is not visible in the public list or by id while a draft", async () => {
      const listRes = await request(app).get("/v1/locations");
      const ids = listRes.body.data.map((l: { id: string }) => l.id);
      expect(ids).not.toContain(locationId);

      const detailRes = await request(app).get(`/v1/locations/${locationId}`);
      expect(detailRes.status).toBe(404);
    });

    it("is visible to its owning host while a draft", async () => {
      const res = await request(app).get(`/v1/locations/${locationId}`).set("Authorization", `Bearer ${host.accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(locationId);
    });

    it("appears in the host's own location list", async () => {
      const res = await request(app).get("/v1/me/locations").set("Authorization", `Bearer ${host.accessToken}`);
      expect(res.status).toBe(200);
      const ids = res.body.data.map((l: { id: string }) => l.id);
      expect(ids).toContain(locationId);
    });

    it("lets the owning host update it", async () => {
      const res = await request(app)
        .patch(`/v1/locations/${locationId}`)
        .set("Authorization", `Bearer ${host.accessToken}`)
        .send({ title: "East London Film Studio (Updated)" });

      expect(res.status).toBe(200);
      expect(res.body.data.title).toBe("East London Film Studio (Updated)");
    });

    it("gives 404 (not 403) when a different host targets a still-draft location", async () => {
      const res = await request(app)
        .patch(`/v1/locations/${locationId}`)
        .set("Authorization", `Bearer ${otherHost.accessToken}`)
        .send({ title: "Hijacked" });

      // Not visible to otherHost at all, so its existence isn't revealed.
      expect(res.status).toBe(404);
    });

    it("rejects a host-requested status transition outside the allow-list", async () => {
      const res = await request(app)
        .patch(`/v1/locations/${locationId}`)
        .set("Authorization", `Bearer ${host.accessToken}`)
        .send({ status: "published" });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("FORBIDDEN");
    });

    it("lets the host submit the (complete) draft for review", async () => {
      const res = await request(app)
        .patch(`/v1/locations/${locationId}`)
        .set("Authorization", `Bearer ${host.accessToken}`)
        .send({ status: "submitted" });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("submitted");
    });

    it("lets an admin move the listing through to published", async () => {
      const approve = await request(app)
        .patch(`/v1/locations/${locationId}`)
        .set("Authorization", `Bearer ${admin.accessToken}`)
        .send({ status: "approved" });
      expect(approve.status).toBe(200);
      expect(approve.body.data.status).toBe("approved");

      const publish = await request(app)
        .patch(`/v1/locations/${locationId}`)
        .set("Authorization", `Bearer ${admin.accessToken}`)
        .send({ status: "published" });
      expect(publish.status).toBe(200);
      expect(publish.body.data.status).toBe("published");
    });

    it("is now publicly visible, with a host summary, and gives 403 (not 404) to a non-owner PATCH", async () => {
      const listRes = await request(app).get("/v1/locations");
      const ids = listRes.body.data.map((l: { id: string }) => l.id);
      expect(ids).toContain(locationId);

      const detailRes = await request(app).get(`/v1/locations/${locationId}`);
      expect(detailRes.status).toBe(200);
      expect(detailRes.body.data.host).toMatchObject({ id: host.id });

      const patchRes = await request(app)
        .patch(`/v1/locations/${locationId}`)
        .set("Authorization", `Bearer ${otherHost.accessToken}`)
        .send({ title: "Hijacked" });
      // Now visible (published) but not owned — 403, distinct from the
      // earlier draft-stage 404.
      expect(patchRes.status).toBe(403);
      expect(patchRes.body.error.code).toBe("FORBIDDEN");
    });

    it("shows a location_media row in the detail response once one exists", async () => {
      const hostClient = createUserScopedClient(host.accessToken);
      const { error } = await hostClient
        .from("location_media")
        .insert({ location_id: locationId, media_type: "photo", storage_key: "locations/test/photo1.jpg", position: 0 });
      // No write grant to authenticated on location_media yet (Phase 3 concern) —
      // insert via the request-scoped client should be rejected at the DB level.
      expect(error).not.toBeNull();

      // Register it the only way currently possible: service_role (stands in
      // for the future Phase 3 "register uploaded media" backend action).
      const { error: adminInsertError } = await adminClient
        .from("location_media")
        .insert({ location_id: locationId, media_type: "photo", storage_key: "locations/test/photo1.jpg", position: 0 });
      expect(adminInsertError).toBeNull();

      const res = await request(app).get(`/v1/locations/${locationId}`);
      expect(res.body.data.media).toHaveLength(1);
      expect(res.body.data.media[0]).toMatchObject({ media_type: "photo", storage_key: "locations/test/photo1.jpg" });
    });

    it("lets the owning host delete it", async () => {
      const res = await request(app).delete(`/v1/locations/${locationId}`).set("Authorization", `Bearer ${host.accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ id: locationId, deleted: true });

      const check = await request(app).get(`/v1/locations/${locationId}`).set("Authorization", `Bearer ${host.accessToken}`);
      expect(check.status).toBe(404);
    });
  });

  it("does not let one host's scoped client see another host's draft row (RLS)", async () => {
    const created = await request(app)
      .post("/v1/locations")
      .set("Authorization", `Bearer ${host.accessToken}`)
      .send({ title: "Private draft", city: "London", country: "UK" });
    const draftId = created.body.data.id;

    const otherClient = createUserScopedClient(otherHost.accessToken);
    const { data, error } = await otherClient.from("locations").select("id").eq("id", draftId);

    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("lets an admin list and filter all locations regardless of status", async () => {
    const res = await request(app)
      .get("/v1/admin/locations")
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .query({ status: "draft", pageSize: 50 });

    expect(res.status).toBe(200);
    expect(res.body.data.every((l: { status: string }) => l.status === "draft")).toBe(true);
  });

  it("forbids a non-admin from the admin locations endpoint", async () => {
    const res = await request(app).get("/v1/admin/locations").set("Authorization", `Bearer ${host.accessToken}`);
    expect(res.status).toBe(403);
  });
});

describe("catalog lookups", () => {
  it("lists categories, amenities, and use cases without authentication", async () => {
    const [categories, amenities, useCases] = await Promise.all([
      request(app).get("/v1/categories"),
      request(app).get("/v1/amenities"),
      request(app).get("/v1/use-cases"),
    ]);

    expect(categories.status).toBe(200);
    expect(categories.body.data.some((c: { name: string }) => c.name === "Studio")).toBe(true);

    expect(amenities.status).toBe(200);
    expect(amenities.body.data.some((a: { name: string }) => a.name === "Parking")).toBe(true);

    expect(useCases.status).toBe(200);
    expect(useCases.body.data.some((u: { name: string }) => u.name === "Film")).toBe(true);
  });
});
