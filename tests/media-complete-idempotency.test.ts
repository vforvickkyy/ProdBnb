import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The same hoisted R2 stand-in media.test.ts uses, with one addition: it counts
// HEAD calls per key. That counter is what proves the idempotent replay path is
// actually being taken rather than merely producing the right answer — a replay
// must not touch storage at all.
const mockObjects = vi.hoisted(() => new Map<string, { contentType: string; contentLength: number }>());
const headCalls = vi.hoisted(() => new Map<string, number>());

vi.mock("../src/lib/r2", () => ({
  objectKeyFor: (locationId: string, mediaId: string) => `locations/${locationId}/${mediaId}/original`,
  publicUrlFor: (key: string) => `https://mock-cdn.example.com/${key}`,
  presignUpload: async (key: string, contentType: string, contentLength: number) => ({
    url: `https://mock-r2.example.com/${key}?signed=1&ct=${encodeURIComponent(contentType)}&cl=${contentLength}`,
    expiresAt: new Date(Date.now() + 900_000),
  }),
  headObject: async (key: string) => {
    headCalls.set(key, (headCalls.get(key) ?? 0) + 1);
    return mockObjects.get(key) ?? null;
  },
  deleteObject: async (key: string) => {
    mockObjects.delete(key);
  },
}));

import { createApp } from "../src/app";
import { adminClient, createTestUser, deleteTestUser, grantAdminRole, TestUser } from "./setup";

const app = createApp();
const PHOTO = { media_type: "photo", content_type: "image/jpeg", size_bytes: 1_000_000 };

function authHeader(user: TestUser): { Authorization: string } {
  return { Authorization: `Bearer ${user.accessToken}` };
}

function keyFor(locationId: string, mediaId: string): string {
  return `locations/${locationId}/${mediaId}/original`;
}

function headCountFor(locationId: string, mediaId: string): number {
  return headCalls.get(keyFor(locationId, mediaId)) ?? 0;
}

async function grantHostRole(user: TestUser): Promise<void> {
  const res = await request(app).post("/v1/me/roles").set(authHeader(user)).send({ role: "host" });
  expect(res.status).toBe(201);
}

async function createDraftLocation(owner: TestUser, title = "Idempotency Test Location"): Promise<string> {
  const res = await request(app)
    .post("/v1/locations")
    .set(authHeader(owner))
    .send({ title, city: "London", country: "UK" });
  expect(res.status).toBe(201);
  return res.body.data.id as string;
}

/** Authorize only — returns the minted media id without simulating the client's PUT. */
async function authorizeUpload(owner: TestUser, locationId: string): Promise<string> {
  const res = await request(app).post(`/v1/locations/${locationId}/media/upload`).set(authHeader(owner)).send(PHOTO);
  expect(res.status).toBe(201);
  return res.body.data.media_id as string;
}

/** Simulate the client's PUT to R2 having happened. */
function putToStorage(
  locationId: string,
  mediaId: string,
  overrides: Partial<{ contentType: string; contentLength: number }> = {}
): void {
  mockObjects.set(keyFor(locationId, mediaId), {
    contentType: overrides.contentType ?? PHOTO.content_type,
    contentLength: overrides.contentLength ?? PHOTO.size_bytes,
  });
}

function complete(user: TestUser, locationId: string, mediaId: string) {
  return request(app)
    .post(`/v1/locations/${locationId}/media/${mediaId}/complete`)
    .set(authHeader(user))
    .send({});
}

/** Counts the real DB rows for a media id, across every location. */
async function rowCountFor(mediaId: string): Promise<number> {
  const { count, error } = await adminClient
    .from("location_media")
    .select("id", { count: "exact", head: true })
    .eq("id", mediaId);
  if (error) {
    throw error;
  }
  return count ?? 0;
}

// ---------------------------------------------------------------------------

describe("Phase 29 B2.5-b: idempotent POST /v1/locations/:id/media/:mediaId/complete", () => {
  let host: TestUser;
  let otherHost: TestUser;
  let admin: TestUser;

  beforeAll(async () => {
    host = await createTestUser();
    otherHost = await createTestUser();
    admin = await createTestUser();

    await grantHostRole(host);
    await grantHostRole(otherHost);
    await grantAdminRole(admin.id);

    return async () => {
      await deleteTestUser(host.id);
      await deleteTestUser(otherHost.id);
      await deleteTestUser(admin.id);
    };
  });

  beforeEach(() => {
    headCalls.clear();
  });

  // ---- 1. Normal completion is unchanged --------------------------------

  describe("first completion", () => {
    it("records the media and returns 201", async () => {
      const locationId = await createDraftLocation(host);
      const mediaId = await authorizeUpload(host, locationId);
      putToStorage(locationId, mediaId);

      const res = await complete(host, locationId, mediaId);

      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ id: mediaId, media_type: "photo", position: 0 });
      expect(await rowCountFor(mediaId)).toBe(1);
    });

    it("verifies the R2 object exactly once on a genuine first completion", async () => {
      const locationId = await createDraftLocation(host);
      const mediaId = await authorizeUpload(host, locationId);
      putToStorage(locationId, mediaId);

      await complete(host, locationId, mediaId);

      expect(headCountFor(locationId, mediaId)).toBe(1);
    });

    it("never exposes storage_key", async () => {
      const locationId = await createDraftLocation(host);
      const mediaId = await authorizeUpload(host, locationId);
      putToStorage(locationId, mediaId);

      const res = await complete(host, locationId, mediaId);

      expect(res.body.data.storage_key).toBeUndefined();
      expect(Object.keys(res.body.data).sort()).toEqual(
        ["created_at", "id", "media_type", "position", "updated_at", "url"].sort()
      );
    });
  });

  // ---- 2 & 3. Idempotent replay -----------------------------------------

  describe("idempotent replay", () => {
    it("returns 201 then 200 for the same media id", async () => {
      const locationId = await createDraftLocation(host);
      const mediaId = await authorizeUpload(host, locationId);
      putToStorage(locationId, mediaId);

      const first = await complete(host, locationId, mediaId);
      const second = await complete(host, locationId, mediaId);

      expect(first.status).toBe(201);
      expect(second.status).toBe(200);
    });

    it("both responses represent the same row, byte for byte", async () => {
      const locationId = await createDraftLocation(host);
      const mediaId = await authorizeUpload(host, locationId);
      putToStorage(locationId, mediaId);

      const first = await complete(host, locationId, mediaId);
      const second = await complete(host, locationId, mediaId);

      expect(second.body.data).toEqual(first.body.data);
      expect(second.body.data.id).toBe(mediaId);
      expect(second.body.data.position).toBe(first.body.data.position);
      // A replay must never re-stamp the row.
      expect(second.body.data.created_at).toBe(first.body.data.created_at);
      expect(second.body.data.updated_at).toBe(first.body.data.updated_at);
    });

    it("creates exactly one database row no matter how often it is replayed", async () => {
      const locationId = await createDraftLocation(host);
      const mediaId = await authorizeUpload(host, locationId);
      putToStorage(locationId, mediaId);

      await complete(host, locationId, mediaId);
      for (let i = 0; i < 4; i += 1) {
        const replay = await complete(host, locationId, mediaId);
        expect(replay.status).toBe(200);
      }

      expect(await rowCountFor(mediaId)).toBe(1);

      const list = await request(app).get(`/v1/locations/${locationId}/media`).set(authHeader(host));
      expect(list.body.data).toHaveLength(1);
    });

    it("performs NO second R2 HEAD on a replay", async () => {
      const locationId = await createDraftLocation(host);
      const mediaId = await authorizeUpload(host, locationId);
      putToStorage(locationId, mediaId);

      await complete(host, locationId, mediaId);
      expect(headCountFor(locationId, mediaId)).toBe(1);

      await complete(host, locationId, mediaId);
      await complete(host, locationId, mediaId);

      // Still 1. This is what proves the replay short-circuits before storage.
      expect(headCountFor(locationId, mediaId)).toBe(1);
    });

    it("does not change the position on replay", async () => {
      const locationId = await createDraftLocation(host);

      const firstId = await authorizeUpload(host, locationId);
      putToStorage(locationId, firstId);
      await complete(host, locationId, firstId);

      const secondId = await authorizeUpload(host, locationId);
      putToStorage(locationId, secondId);
      const created = await complete(host, locationId, secondId);
      expect(created.body.data.position).toBe(1);

      const replay = await complete(host, locationId, secondId);
      expect(replay.status).toBe(200);
      expect(replay.body.data.position).toBe(1);

      const list = await request(app).get(`/v1/locations/${locationId}/media`).set(authHeader(host));
      expect(list.body.data.map((m: { position: number }) => m.position)).toEqual([0, 1]);
    });

    it("an admin replaying a host's completion also gets the existing row", async () => {
      const locationId = await createDraftLocation(host);
      const mediaId = await authorizeUpload(host, locationId);
      putToStorage(locationId, mediaId);

      const first = await complete(host, locationId, mediaId);
      expect(first.status).toBe(201);

      const replay = await complete(admin, locationId, mediaId);
      expect(replay.status).toBe(200);
      expect(replay.body.data.id).toBe(mediaId);
      expect(await rowCountFor(mediaId)).toBe(1);
    });
  });

  // ---- 6. Replay works even when storage no longer has the object -------

  describe("replay does not depend on storage", () => {
    it("returns the existing row for an already-recorded id whose R2 object is gone", async () => {
      const locationId = await createDraftLocation(host);
      const mediaId = await authorizeUpload(host, locationId);
      putToStorage(locationId, mediaId);

      const first = await complete(host, locationId, mediaId);
      expect(first.status).toBe(201);

      // Remove the object entirely. A replay that still consulted storage would
      // now 404 — so this proves the DB row, not the object, drives the replay.
      mockObjects.delete(keyFor(locationId, mediaId));
      headCalls.clear();

      const replay = await complete(host, locationId, mediaId);

      expect(replay.status).toBe(200);
      expect(replay.body.data.id).toBe(mediaId);
      expect(headCountFor(locationId, mediaId)).toBe(0);
    });
  });

  // ---- 4. Cross-location media id ---------------------------------------

  describe("cross-location media id", () => {
    it("returns 404 and discloses nothing about the other location", async () => {
      const foreignLocation = await createDraftLocation(otherHost, "Someone Else's Location");
      const foreignMediaId = await authorizeUpload(otherHost, foreignLocation);
      putToStorage(foreignLocation, foreignMediaId);
      const recorded = await complete(otherHost, foreignLocation, foreignMediaId);
      expect(recorded.status).toBe(201);
      const foreignStorageKey = keyFor(foreignLocation, foreignMediaId);

      const myLocation = await createDraftLocation(host);
      const res = await complete(host, myLocation, foreignMediaId);

      expect(res.status).toBe(404);

      const body = JSON.stringify(res.body);
      expect(body).not.toContain(foreignLocation);
      expect(body).not.toContain(foreignStorageKey);
      expect(body).not.toContain("storage_key");
      expect(body).not.toContain(otherHost.id);
      expect(res.body.error.code).toBe("NOT_FOUND");
    });

    it("is byte-identical to the response for a media id that was never uploaded", async () => {
      const foreignLocation = await createDraftLocation(otherHost, "Foreign Location B");
      const foreignMediaId = await authorizeUpload(otherHost, foreignLocation);
      putToStorage(foreignLocation, foreignMediaId);
      await complete(otherHost, foreignLocation, foreignMediaId);

      const myLocation = await createDraftLocation(host);

      const foreign = await complete(host, myLocation, foreignMediaId);
      const neverUploaded = await complete(host, myLocation, await authorizeUpload(host, myLocation));

      // Indistinguishable: a media id must not become an existence oracle.
      expect(foreign.status).toBe(neverUploaded.status);
      expect(foreign.body).toEqual(neverUploaded.body);
    });

    it("does not record a row for the foreign media id under the caller's location", async () => {
      const foreignLocation = await createDraftLocation(otherHost, "Foreign Location C");
      const foreignMediaId = await authorizeUpload(otherHost, foreignLocation);
      putToStorage(foreignLocation, foreignMediaId);
      await complete(otherHost, foreignLocation, foreignMediaId);

      const myLocation = await createDraftLocation(host);
      await complete(host, myLocation, foreignMediaId);

      expect(await rowCountFor(foreignMediaId)).toBe(1);
      const mine = await request(app).get(`/v1/locations/${myLocation}/media`).set(authHeader(host));
      expect(mine.body.data).toHaveLength(0);
    });
  });

  // ---- 5 & 7. The new-media checks are untouched ------------------------

  describe("validation of a genuinely new media id is unchanged", () => {
    it("still 404s when the R2 object does not exist", async () => {
      const locationId = await createDraftLocation(host);
      const mediaId = await authorizeUpload(host, locationId);
      // No putToStorage — the client never uploaded.

      const res = await complete(host, locationId, mediaId);

      expect(res.status).toBe(404);
      expect(headCountFor(locationId, mediaId)).toBe(1);
      expect(await rowCountFor(mediaId)).toBe(0);
    });

    it("still rejects an unsupported actual content type", async () => {
      const locationId = await createDraftLocation(host);
      const mediaId = await authorizeUpload(host, locationId);
      putToStorage(locationId, mediaId, { contentType: "application/pdf" });

      const res = await complete(host, locationId, mediaId);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      expect(await rowCountFor(mediaId)).toBe(0);
    });

    it("still rejects an actual object larger than the photo limit", async () => {
      const locationId = await createDraftLocation(host);
      const mediaId = await authorizeUpload(host, locationId);
      putToStorage(locationId, mediaId, { contentLength: 40 * 1024 * 1024 });

      const res = await complete(host, locationId, mediaId);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      expect(await rowCountFor(mediaId)).toBe(0);
    });

    it("a failed validation does not poison a later legitimate completion", async () => {
      const locationId = await createDraftLocation(host);
      const mediaId = await authorizeUpload(host, locationId);

      putToStorage(locationId, mediaId, { contentType: "application/pdf" });
      expect((await complete(host, locationId, mediaId)).status).toBe(400);

      // The client re-uploads correctly under the same authorization.
      putToStorage(locationId, mediaId);
      const res = await complete(host, locationId, mediaId);

      expect(res.status).toBe(201);
      expect(await rowCountFor(mediaId)).toBe(1);
    });
  });

  // ---- Authorization is unchanged and still comes first ------------------

  describe("authorization", () => {
    it("hides a draft location from another host before any media lookup", async () => {
      const locationId = await createDraftLocation(host);
      const mediaId = await authorizeUpload(host, locationId);
      putToStorage(locationId, mediaId);
      await complete(host, locationId, mediaId);

      const res = await complete(otherHost, locationId, mediaId);
      expect(res.status).toBe(404);
    });

    it("requires authentication", async () => {
      const locationId = await createDraftLocation(host);
      const mediaId = await authorizeUpload(host, locationId);
      putToStorage(locationId, mediaId);

      const res = await request(app).post(`/v1/locations/${locationId}/media/${mediaId}/complete`).send({});
      expect(res.status).toBe(401);
    });
  });

  // ---- 8. Concurrency ---------------------------------------------------

  describe("concurrent completion", () => {
    it("two simultaneous completions of the same media id yield one row and one 201", async () => {
      const locationId = await createDraftLocation(host);
      const mediaId = await authorizeUpload(host, locationId);
      putToStorage(locationId, mediaId);

      const [a, b] = await Promise.all([complete(host, locationId, mediaId), complete(host, locationId, mediaId)]);

      const statuses = [a.status, b.status].sort();
      // Either the second saw the row (200), or it raced the insert and the
      // 23505 handler mapped it back to the same row (also 200). Never a 500.
      expect(statuses).toEqual([200, 201]);
      expect(a.status).not.toBe(500);
      expect(b.status).not.toBe(500);

      expect(await rowCountFor(mediaId)).toBe(1);
      expect(a.body.data.id).toBe(mediaId);
      expect(b.body.data.id).toBe(mediaId);
    });

    it("five simultaneous completions still yield exactly one row and no 500", async () => {
      const locationId = await createDraftLocation(host);
      const mediaId = await authorizeUpload(host, locationId);
      putToStorage(locationId, mediaId);

      const results = await Promise.all(
        Array.from({ length: 5 }, () => complete(host, locationId, mediaId))
      );

      expect(results.every((r) => r.status === 200 || r.status === 201)).toBe(true);
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(await rowCountFor(mediaId)).toBe(1);
    });
  });
});
