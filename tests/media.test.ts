import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// vitest hoists vi.mock calls above imports automatically, so this replaces
// src/lib/r2 for every module that imports it in this test file (including
// locations.service.ts) — no real R2 credentials needed to run this suite.
// vi.hoisted is required only because the mock factory itself needs to close
// over state the test bodies also read/write.
const mockObjects = vi.hoisted(() => new Map<string, { contentType: string; contentLength: number }>());
const deletedKeys = vi.hoisted(() => new Set<string>());

vi.mock("../src/lib/r2", () => ({
  objectKeyFor: (locationId: string, mediaId: string) => `locations/${locationId}/${mediaId}/original`,
  publicUrlFor: (key: string) => `https://mock-cdn.example.com/${key}`,
  presignUpload: async (key: string, contentType: string, contentLength: number) => ({
    url: `https://mock-r2.example.com/${key}?signed=1&ct=${encodeURIComponent(contentType)}&cl=${contentLength}`,
    expiresAt: new Date(Date.now() + 900_000),
  }),
  headObject: async (key: string) => mockObjects.get(key) ?? null,
  deleteObject: async (key: string) => {
    mockObjects.delete(key);
    deletedKeys.add(key);
  },
}));

import { env } from "../src/config/env";
import { createApp } from "../src/app";
import { createTestUser, deleteTestUser, grantAdminRole, TestUser } from "./setup";

const app = createApp();

async function grantHostRole(user: TestUser): Promise<void> {
  const res = await request(app).post("/v1/me/roles").set("Authorization", `Bearer ${user.accessToken}`).send({ role: "host" });
  expect(res.status).toBe(201);
}

function authHeader(user: TestUser): { Authorization: string } {
  return { Authorization: `Bearer ${user.accessToken}` };
}

async function createDraftLocation(owner: TestUser): Promise<string> {
  const res = await request(app)
    .post("/v1/locations")
    .set(authHeader(owner))
    .send({ title: "Media Test Location", city: "London", country: "UK" });
  expect(res.status).toBe(201);
  return res.body.data.id as string;
}

async function publish(locationId: string, admin: TestUser): Promise<void> {
  await request(app).patch(`/v1/locations/${locationId}`).set(authHeader(admin)).send({ status: "approved" });
  const res = await request(app).patch(`/v1/locations/${locationId}`).set(authHeader(admin)).send({ status: "published" });
  expect(res.status).toBe(200);
}

const PHOTO = { media_type: "photo", content_type: "image/jpeg", size_bytes: 1_000_000 };

describe("media upload", () => {
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

  it("rejects an unauthenticated upload request", async () => {
    const res = await request(app).post("/v1/locations/00000000-0000-0000-0000-000000000000/media/upload").send(PHOTO);
    expect(res.status).toBe(401);
  });

  it("rejects a booker (owns no locations) requesting upload for someone else's published location", async () => {
    const locationId = await createDraftLocation(host);
    await publish(locationId, admin);

    const res = await request(app).post(`/v1/locations/${locationId}/media/upload`).set(authHeader(booker)).send(PHOTO);
    expect(res.status).toBe(403);
  });

  it("rejects an invalid media_type/content_type combination", async () => {
    const locationId = await createDraftLocation(host);
    const res = await request(app)
      .post(`/v1/locations/${locationId}/media/upload`)
      .set(authHeader(host))
      .send({ media_type: "photo", content_type: "video/mp4", size_bytes: 1000 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a file size over the configured limit", async () => {
    const locationId = await createDraftLocation(host);
    const overLimit = env.MEDIA_MAX_PHOTO_SIZE_MB * 1024 * 1024 + 1;

    const res = await request(app)
      .post(`/v1/locations/${locationId}/media/upload`)
      .set(authHeader(host))
      .send({ media_type: "photo", content_type: "image/jpeg", size_bytes: overLimit });

    expect(res.status).toBe(400);
  });

  it("lets a host request an upload for their own location, returning only temporary/safe info", async () => {
    const locationId = await createDraftLocation(host);
    const res = await request(app).post(`/v1/locations/${locationId}/media/upload`).set(authHeader(host)).send(PHOTO);

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      method: "PUT",
      headers: { "Content-Type": "image/jpeg", "Content-Length": "1000000" },
    });
    expect(typeof res.body.data.media_id).toBe("string");
    expect(typeof res.body.data.upload_url).toBe("string");
    expect(typeof res.body.data.expires_at).toBe("string");

    // Regression guard: raw R2 credentials must never appear in a response.
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain(env.R2_SECRET_ACCESS_KEY);
    expect(serialized).not.toContain(env.R2_ACCESS_KEY_ID);
    expect(Object.keys(res.body.data).sort()).toEqual(["expires_at", "headers", "media_id", "method", "upload_url"].sort());
  });

  it("404s a different host requesting upload for a still-draft location (not 403 — existence hidden)", async () => {
    const locationId = await createDraftLocation(host);
    const res = await request(app).post(`/v1/locations/${locationId}/media/upload`).set(authHeader(otherHost)).send(PHOTO);
    expect(res.status).toBe(404);
  });

  describe("complete + retrieve + reorder + delete", () => {
    let locationId: string;
    let mediaId: string;
    let secondMediaId: string;

    it("completes an upload once the object actually exists in R2", async () => {
      locationId = await createDraftLocation(host);

      const upload = await request(app).post(`/v1/locations/${locationId}/media/upload`).set(authHeader(host)).send(PHOTO);
      mediaId = upload.body.data.media_id;

      // Not yet "uploaded" — completing now should fail.
      const tooSoon = await request(app)
        .post(`/v1/locations/${locationId}/media/${mediaId}/complete`)
        .set(authHeader(host))
        .send({});
      expect(tooSoon.status).toBe(404);

      // Simulate the client's PUT having actually happened.
      const key = `locations/${locationId}/${mediaId}/original`;
      mockObjects.set(key, { contentType: PHOTO.content_type, contentLength: PHOTO.size_bytes });

      const res = await request(app)
        .post(`/v1/locations/${locationId}/media/${mediaId}/complete`)
        .set(authHeader(host))
        .send({});

      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ id: mediaId, media_type: "photo", position: 0 });
      expect(res.body.data.url).toContain(key);
    });

    it("does not let another host complete an upload for a location they don't own", async () => {
      const upload = await request(app).post(`/v1/locations/${locationId}/media/upload`).set(authHeader(host)).send(PHOTO);
      secondMediaId = upload.body.data.media_id;
      const key = `locations/${locationId}/${secondMediaId}/original`;
      mockObjects.set(key, { contentType: PHOTO.content_type, contentLength: PHOTO.size_bytes });

      const res = await request(app)
        .post(`/v1/locations/${locationId}/media/${secondMediaId}/complete`)
        .set(authHeader(otherHost))
        .send({});

      // Still a draft, so otherHost can't see it exists at all.
      expect(res.status).toBe(404);

      // The legitimate owner completes it for the following tests.
      const ok = await request(app)
        .post(`/v1/locations/${locationId}/media/${secondMediaId}/complete`)
        .set(authHeader(host))
        .send({});
      expect(ok.status).toBe(201);
      expect(ok.body.data.position).toBe(1); // appended after the first
    });

    it("does not publicly expose media for a draft location", async () => {
      const res = await request(app).get(`/v1/locations/${locationId}/media`);
      expect(res.status).toBe(404);
    });

    it("exposes media once the location is published", async () => {
      await publish(locationId, admin);

      const res = await request(app).get(`/v1/locations/${locationId}/media`);
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.data.map((m: { id: string }) => m.id)).toEqual([mediaId, secondMediaId]);
    });

    it("lets the host reorder media", async () => {
      // PATCH sets a raw position (no automatic sibling renumbering — kept
      // simple, per the plan), so a clean swap means moving both items.
      const first = await request(app)
        .patch(`/v1/locations/${locationId}/media/${secondMediaId}`)
        .set(authHeader(host))
        .send({ position: 0 });
      expect(first.status).toBe(200);
      expect(first.body.data.position).toBe(0);

      const second = await request(app)
        .patch(`/v1/locations/${locationId}/media/${mediaId}`)
        .set(authHeader(host))
        .send({ position: 1 });
      expect(second.status).toBe(200);
      expect(second.body.data.position).toBe(1);

      const list = await request(app).get(`/v1/locations/${locationId}/media`);
      expect(list.body.data.map((m: { id: string }) => m.id)).toEqual([secondMediaId, mediaId]);
    });

    it("does not let another host delete this media", async () => {
      const res = await request(app).delete(`/v1/locations/${locationId}/media/${mediaId}`).set(authHeader(otherHost));
      expect(res.status).toBe(403);
    });

    it("lets an admin manage media on a location they don't own", async () => {
      const res = await request(app)
        .patch(`/v1/locations/${locationId}/media/${mediaId}`)
        .set(authHeader(admin))
        .send({ position: 5 });
      expect(res.status).toBe(200);
      expect(res.body.data.position).toBe(5);
    });

    it("lets the owning host delete their media, removing both the R2 object and the row", async () => {
      const key = `locations/${locationId}/${mediaId}/original`;
      const res = await request(app).delete(`/v1/locations/${locationId}/media/${mediaId}`).set(authHeader(host));

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ id: mediaId, deleted: true });
      expect(deletedKeys.has(key)).toBe(true);

      const list = await request(app).get(`/v1/locations/${locationId}/media`);
      expect(list.body.data.map((m: { id: string }) => m.id)).not.toContain(mediaId);
    });
  });
});
