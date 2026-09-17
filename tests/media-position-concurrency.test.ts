import request from "supertest";
import { beforeAll, describe, expect, it, vi } from "vitest";

// The same hoisted R2 stand-in the other media suites use. `headObject` is what `complete` checks,
// so an upload is simulated by writing the key into this map.
const mockObjects = vi.hoisted(() => new Map<string, { contentType: string; contentLength: number }>());

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
  },
}));

import { createApp } from "../src/app";
import { createTestUser, deleteTestUser, grantAdminRole, TestUser } from "./setup";

const app = createApp();
const PHOTO = { media_type: "photo", content_type: "image/jpeg", size_bytes: 1_000_000 };

function authHeader(user: TestUser): { Authorization: string } {
  return { Authorization: `Bearer ${user.accessToken}` };
}

async function grantHostRole(user: TestUser): Promise<void> {
  const res = await request(app).post("/v1/me/roles").set(authHeader(user)).send({ role: "host" });
  expect(res.status).toBe(201);
}

async function createDraftLocation(owner: TestUser, title = "Concurrency Test Location"): Promise<string> {
  const res = await request(app)
    .post("/v1/locations")
    .set(authHeader(owner))
    .send({ title, city: "London", country: "UK" });
  expect(res.status).toBe(201);
  return res.body.data.id as string;
}

/**
 * Authorize an upload and write the object into the R2 stand-in, but **do not complete it**.
 *
 * Splitting authorize/upload from complete is the whole point of this suite: it lets every
 * completion be fired at the same instant, which is what actually overlaps the
 * read-compute-insert sequence that assigns a position.
 */
async function stageUpload(owner: TestUser, locationId: string): Promise<string> {
  const upload = await request(app).post(`/v1/locations/${locationId}/media/upload`).set(authHeader(owner)).send(PHOTO);
  expect(upload.status).toBe(201);
  const mediaId = upload.body.data.media_id as string;
  mockObjects.set(`locations/${locationId}/${mediaId}/original`, {
    contentType: PHOTO.content_type,
    contentLength: PHOTO.size_bytes,
  });
  return mediaId;
}

async function stageUploads(owner: TestUser, locationId: string, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    ids.push(await stageUpload(owner, locationId));
  }
  return ids;
}

function complete(user: TestUser, locationId: string, mediaId: string, body: object = {}) {
  return request(app)
    .post(`/v1/locations/${locationId}/media/${mediaId}/complete`)
    .set(authHeader(user))
    .send(body);
}

/**
 * Fires every completion without awaiting any of them first, so they are genuinely in flight
 * together rather than run one after another.
 *
 * `Promise.all` over already-started supertest requests is what makes this a real overlap: each
 * request is dispatched before any of them has resolved, so their database round-trips interleave.
 * A sequential loop would exercise nothing.
 */
function completeAllConcurrently(user: TestUser, locationId: string, mediaIds: string[]) {
  return Promise.all(mediaIds.map((mediaId) => complete(user, locationId, mediaId)));
}

/**
 * Completes one at a time, so each row's position is deterministic.
 *
 * Concurrent completion guarantees positions are *distinct and contiguous*, but NOT which id gets
 * which — that is the race the advisory lock resolves, in whatever order the callers win it. Any
 * assertion about a specific id's position therefore has to be set up sequentially.
 */
async function completeAllSequentially(user: TestUser, locationId: string, mediaIds: string[]) {
  for (const mediaId of mediaIds) {
    const res = await complete(user, locationId, mediaId);
    expect(res.status).toBe(201);
  }
}

function listMedia(user: TestUser, locationId: string) {
  return request(app).get(`/v1/locations/${locationId}/media`).set(authHeader(user));
}

function positionsOf(body: { data: { position: number }[] }): number[] {
  return body.data.map((m) => m.position);
}

describe("Phase 29.5: concurrency-safe media position assignment", () => {
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

  // ---- The race this phase closes ---------------------------------------

  describe("concurrent completions for the same location", () => {
    it("two at once produce two DIFFERENT positions", async () => {
      const locationId = await createDraftLocation(host);
      const [a, b] = await stageUploads(host, locationId, 2);

      const results = await completeAllConcurrently(host, locationId, [a, b]);

      expect(results.map((r) => r.status)).toEqual([201, 201]);
      const positions = results.map((r) => r.body.data.position as number);
      // The defect this phase fixes produced [0, 0] here.
      expect(new Set(positions).size).toBe(2);
      expect([...positions].sort()).toEqual([0, 1]);
    });

    it("eight at once produce eight distinct, contiguous positions", async () => {
      const locationId = await createDraftLocation(host);
      const ids = await stageUploads(host, locationId, 8);

      const results = await completeAllConcurrently(host, locationId, ids);

      expect(results.every((r) => r.status === 201)).toBe(true);
      const positions = results.map((r) => r.body.data.position as number);
      expect(new Set(positions).size).toBe(8);
      expect([...positions].sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    });

    it("leaves the stored gallery with no duplicate positions", async () => {
      const locationId = await createDraftLocation(host);
      const ids = await stageUploads(host, locationId, 6);

      await completeAllConcurrently(host, locationId, ids);

      const list = await listMedia(host, locationId);
      expect(list.status).toBe(200);
      const stored = positionsOf(list.body);
      expect(stored).toHaveLength(6);
      expect(new Set(stored).size).toBe(6);
      expect(stored).toEqual([0, 1, 2, 3, 4, 5]);
    });

    it("appends safely when a gallery already has rows", async () => {
      const locationId = await createDraftLocation(host);
      const existing = await stageUploads(host, locationId, 2);
      await completeAllConcurrently(host, locationId, existing);

      const added = await stageUploads(host, locationId, 4);
      const results = await completeAllConcurrently(host, locationId, added);

      expect(results.every((r) => r.status === 201)).toBe(true);
      const list = await listMedia(host, locationId);
      expect(positionsOf(list.body)).toEqual([0, 1, 2, 3, 4, 5]);
    });

    it("a concurrent burst is still ordered consistently on read-back", async () => {
      const locationId = await createDraftLocation(host);
      const ids = await stageUploads(host, locationId, 5);

      const results = await completeAllConcurrently(host, locationId, ids);
      const byId = new Map(results.map((r) => [r.body.data.id as string, r.body.data.position as number]));

      const list = await listMedia(host, locationId);
      // What each completion reported is exactly what the gallery now holds — no row silently
      // moved, and the list order matches the positions handed out.
      for (const row of list.body.data as { id: string; position: number }[]) {
        expect(row.position).toBe(byId.get(row.id));
      }
      expect(positionsOf(list.body)).toEqual([0, 1, 2, 3, 4]);
    });
  });

  // ---- The lock must not serialise more than it has to --------------------

  describe("concurrent completions for different locations", () => {
    it("do not interfere: each gallery numbers itself from 0", async () => {
      const first = await createDraftLocation(host, "Concurrent A");
      const second = await createDraftLocation(host, "Concurrent B");
      const firstIds = await stageUploads(host, first, 3);
      const secondIds = await stageUploads(host, second, 3);

      // Both galleries' completions interleave in one burst.
      const results = await Promise.all([
        ...firstIds.map((id) => complete(host, first, id)),
        ...secondIds.map((id) => complete(host, second, id)),
      ]);
      expect(results.every((r) => r.status === 201)).toBe(true);

      const firstList = await listMedia(host, first);
      const secondList = await listMedia(host, second);
      expect(positionsOf(firstList.body)).toEqual([0, 1, 2]);
      expect(positionsOf(secondList.body)).toEqual([0, 1, 2]);
    });

    it("keep each location's media to itself", async () => {
      const first = await createDraftLocation(host, "Isolated A");
      const second = await createDraftLocation(host, "Isolated B");
      const firstIds = await stageUploads(host, first, 2);
      const secondIds = await stageUploads(host, second, 2);

      await Promise.all([
        ...firstIds.map((id) => complete(host, first, id)),
        ...secondIds.map((id) => complete(host, second, id)),
      ]);

      const firstList = await listMedia(host, first);
      const secondList = await listMedia(host, second);
      expect((firstList.body.data as { id: string }[]).map((m) => m.id).sort()).toEqual([...firstIds].sort());
      expect((secondList.body.data as { id: string }[]).map((m) => m.id).sort()).toEqual([...secondIds].sort());
    });
  });

  // ---- Idempotency must survive the change (Phase 29 B2.5-b) -------------

  describe("repeated completion of the same media id", () => {
    it("is idempotent when replayed sequentially: 201 then 200, one row", async () => {
      const locationId = await createDraftLocation(host);
      const [mediaId] = await stageUploads(host, locationId, 1);

      const first = await complete(host, locationId, mediaId);
      expect(first.status).toBe(201);

      const replay = await complete(host, locationId, mediaId);
      expect(replay.status).toBe(200);
      expect(replay.body.data).toEqual(first.body.data);

      const list = await listMedia(host, locationId);
      expect(list.body.data).toHaveLength(1);
    });

    it("is idempotent when the SAME id is completed concurrently: exactly one insert", async () => {
      const locationId = await createDraftLocation(host);
      const [mediaId] = await stageUploads(host, locationId, 1);

      // The primary-key race, fired in parallel rather than replayed after the fact.
      const results = await Promise.all([
        complete(host, locationId, mediaId),
        complete(host, locationId, mediaId),
        complete(host, locationId, mediaId),
      ]);

      const statuses = results.map((r) => r.status);
      expect(statuses.every((s) => s === 200 || s === 201)).toBe(true);
      // At most one call may claim to have created the row.
      expect(statuses.filter((s) => s === 201).length).toBeLessThanOrEqual(1);

      const ids = results.map((r) => r.body.data.id as string);
      expect(new Set(ids)).toEqual(new Set([mediaId]));

      const list = await listMedia(host, locationId);
      expect(list.body.data).toHaveLength(1);
      expect(list.body.data[0].id).toBe(mediaId);
    });

    it("does not move a replayed row's position, even while others are being added", async () => {
      const locationId = await createDraftLocation(host);
      const [first] = await stageUploads(host, locationId, 1);
      const created = await complete(host, locationId, first);
      expect(created.body.data.position).toBe(0);

      const others = await stageUploads(host, locationId, 3);
      const results = await Promise.all([
        complete(host, locationId, first), // replay, concurrent with real inserts
        ...others.map((id) => complete(host, locationId, id)),
      ]);

      expect(results[0]!.status).toBe(200);
      expect(results[0]!.body.data.position).toBe(0);
      const list = await listMedia(host, locationId);
      expect(positionsOf(list.body)).toEqual([0, 1, 2, 3]);
    });
  });

  // ---- Completion after deletion ----------------------------------------

  describe("completion after the media has been deleted", () => {
    it("is refused: the row is gone and so is the R2 object", async () => {
      const locationId = await createDraftLocation(host);
      const [mediaId] = await stageUploads(host, locationId, 1);
      expect((await complete(host, locationId, mediaId)).status).toBe(201);

      const deleted = await request(app)
        .delete(`/v1/locations/${locationId}/media/${mediaId}`)
        .set(authHeader(host));
      expect(deleted.status).toBe(200);

      const again = await complete(host, locationId, mediaId);
      expect(again.status).toBe(404);
      expect(again.body.error.message).toMatch(/No uploaded object found/);

      const list = await listMedia(host, locationId);
      expect(list.body.data).toHaveLength(0);
    });

    it("does not disturb the remaining gallery's positions", async () => {
      const locationId = await createDraftLocation(host);
      const ids = await stageUploads(host, locationId, 3);
      // Sequential on purpose: this test names a specific id's position, which a concurrent burst
      // deliberately does not determine.
      await completeAllSequentially(host, locationId, ids);

      await request(app).delete(`/v1/locations/${locationId}/media/${ids[1]}`).set(authHeader(host));

      // Deletion deliberately does not renumber, so a gap is the correct answer here.
      const list = await listMedia(host, locationId);
      expect(positionsOf(list.body)).toEqual([0, 2]);

      // And a later append still lands clear of everything already present.
      const [added] = await stageUploads(host, locationId, 1);
      const appended = await complete(host, locationId, added);
      expect(appended.status).toBe(201);
      expect(appended.body.data.position).toBe(3);
    });
  });

  // ---- Everything the change must NOT have altered ------------------------

  describe("preserved authorization", () => {
    it("hides another host's draft location entirely (404, not 403)", async () => {
      const locationId = await createDraftLocation(host);
      const [mediaId] = await stageUploads(host, locationId, 1);

      const res = await complete(otherHost, locationId, mediaId);
      expect(res.status).toBe(404);
    });

    it("requires authentication", async () => {
      const locationId = await createDraftLocation(host);
      const [mediaId] = await stageUploads(host, locationId, 1);

      const res = await request(app).post(`/v1/locations/${locationId}/media/${mediaId}/complete`).send({});
      expect(res.status).toBe(401);
    });

    it("lets an admin complete for a location they do not own", async () => {
      const locationId = await createDraftLocation(host);
      const [mediaId] = await stageUploads(host, locationId, 1);

      const res = await complete(admin, locationId, mediaId);
      expect(res.status).toBe(201);
    });

    it("refuses a media id recorded against a different location, without revealing it exists", async () => {
      const mine = await createDraftLocation(host, "Mine");
      const theirs = await createDraftLocation(host, "Theirs");
      const [mediaId] = await stageUploads(host, theirs, 1);
      expect((await complete(host, theirs, mediaId)).status).toBe(201);

      const crossed = await complete(host, mine, mediaId);
      const neverUploaded = await complete(host, mine, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");

      expect(crossed.status).toBe(404);
      expect(neverUploaded.status).toBe(404);
      // Byte-identical: a media id must not become an existence oracle.
      expect(crossed.body).toEqual(neverUploaded.body);

      const list = await listMedia(host, mine);
      expect(list.body.data).toHaveLength(0);
    });
  });

  describe("preserved validation", () => {
    it("still refuses a media id whose object was never uploaded", async () => {
      const locationId = await createDraftLocation(host);
      const upload = await request(app)
        .post(`/v1/locations/${locationId}/media/upload`)
        .set(authHeader(host))
        .send(PHOTO);
      expect(upload.status).toBe(201);
      // Deliberately not written into the R2 stand-in.
      const res = await complete(host, locationId, upload.body.data.media_id);
      expect(res.status).toBe(404);
    });

    it("still rejects an uploaded object whose real content type is not supported", async () => {
      const locationId = await createDraftLocation(host);
      const upload = await request(app)
        .post(`/v1/locations/${locationId}/media/upload`)
        .set(authHeader(host))
        .send(PHOTO);
      const mediaId = upload.body.data.media_id as string;
      mockObjects.set(`locations/${locationId}/${mediaId}/original`, {
        contentType: "application/pdf",
        contentLength: 1000,
      });

      const res = await complete(host, locationId, mediaId);
      expect(res.status).toBe(400);
    });

    it("still rejects an oversize uploaded object", async () => {
      const locationId = await createDraftLocation(host);
      const upload = await request(app)
        .post(`/v1/locations/${locationId}/media/upload`)
        .set(authHeader(host))
        .send(PHOTO);
      const mediaId = upload.body.data.media_id as string;
      mockObjects.set(`locations/${locationId}/${mediaId}/original`, {
        contentType: PHOTO.content_type,
        contentLength: 999 * 1024 * 1024,
      });

      const res = await complete(host, locationId, mediaId);
      expect(res.status).toBe(400);
    });

    it("still rejects an unknown field in the body", async () => {
      const locationId = await createDraftLocation(host);
      const [mediaId] = await stageUploads(host, locationId, 1);

      const res = await complete(host, locationId, mediaId, { position: 0, storage_key: "hacked" });
      expect(res.status).toBe(400);
    });

    it("still honours an explicitly requested position", async () => {
      const locationId = await createDraftLocation(host);
      const [mediaId] = await stageUploads(host, locationId, 1);

      const res = await complete(host, locationId, mediaId, { position: 4 });
      expect(res.status).toBe(201);
      expect(res.body.data.position).toBe(4);
    });

    it("still rejects a negative position", async () => {
      const locationId = await createDraftLocation(host);
      const [mediaId] = await stageUploads(host, locationId, 1);

      const res = await complete(host, locationId, mediaId, { position: -1 });
      expect(res.status).toBe(400);
    });
  });
});
