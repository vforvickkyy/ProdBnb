import request from "supertest";
import { beforeAll, describe, expect, it, vi } from "vitest";

// Same R2 stand-in as media.test.ts — no real credentials needed. `headObject`
// is what `complete` checks, so uploads are simulated by writing into this map.
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

async function createDraftLocation(owner: TestUser, title = "Reorder Test Location"): Promise<string> {
  const res = await request(app)
    .post("/v1/locations")
    .set(authHeader(owner))
    .send({ title, city: "London", country: "UK" });
  expect(res.status).toBe(201);
  return res.body.data.id as string;
}

/**
 * Authorize → simulate the client's PUT to R2 → complete. Returns the media id.
 *
 * `position` is the complete endpoint's own optional field. Since Phase 29.5 removed the single-row
 * PATCH, it is the only way a caller can place a row at a specific position — which is what the
 * not-0-based test below needs.
 */
async function addPhoto(owner: TestUser, locationId: string, position?: number): Promise<string> {
  const upload = await request(app).post(`/v1/locations/${locationId}/media/upload`).set(authHeader(owner)).send(PHOTO);
  expect(upload.status).toBe(201);
  const mediaId = upload.body.data.media_id as string;

  mockObjects.set(`locations/${locationId}/${mediaId}/original`, {
    contentType: PHOTO.content_type,
    contentLength: PHOTO.size_bytes,
  });

  const done = await request(app)
    .post(`/v1/locations/${locationId}/media/${mediaId}/complete`)
    .set(authHeader(owner))
    .send(position === undefined ? {} : { position });
  expect(done.status).toBe(201);
  return mediaId;
}

async function addPhotos(owner: TestUser, locationId: string, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    ids.push(await addPhoto(owner, locationId));
  }
  return ids;
}

function reorder(user: TestUser, locationId: string, orderedIds: unknown) {
  return request(app)
    .put(`/v1/locations/${locationId}/media/order`)
    .set(authHeader(user))
    .send({ ordered_ids: orderedIds });
}

interface MediaRow {
  id: string;
  position: number;
}

function idsOf(body: { data: MediaRow[] }): string[] {
  return body.data.map((m) => m.id);
}

function positionsOf(body: { data: MediaRow[] }): number[] {
  return body.data.map((m) => m.position);
}

async function listMedia(user: TestUser, locationId: string) {
  return request(app).get(`/v1/locations/${locationId}/media`).set(authHeader(user));
}

// ---------------------------------------------------------------------------

describe("Phase 29 B2.5-a: PUT /v1/locations/:id/media/order", () => {
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

    return async () => {
      await deleteTestUser(host.id);
      await deleteTestUser(otherHost.id);
      await deleteTestUser(booker.id);
      await deleteTestUser(admin.id);
    };
  });

  // ---- Happy path -------------------------------------------------------

  describe("happy path", () => {
    it("reorders three photos and renumbers them to exactly 0, 1, 2", async () => {
      const locationId = await createDraftLocation(host);
      const [a, b, c] = await addPhotos(host, locationId, 3);

      const res = await reorder(host, locationId, [c, a, b]);

      expect(res.status).toBe(200);
      expect(idsOf(res.body)).toEqual([c, a, b]);
      expect(positionsOf(res.body)).toEqual([0, 1, 2]);
    });

    it("the returned order matches the requested order, and so does a subsequent read", async () => {
      const locationId = await createDraftLocation(host);
      const [a, b, c] = await addPhotos(host, locationId, 3);

      const res = await reorder(host, locationId, [b, c, a]);
      expect(idsOf(res.body)).toEqual([b, c, a]);

      const list = await listMedia(host, locationId);
      expect(list.status).toBe(200);
      expect(idsOf(list.body)).toEqual([b, c, a]);
      expect(positionsOf(list.body)).toEqual([0, 1, 2]);
    });

    it("is idempotent — the same list twice leaves the same order and positions", async () => {
      const locationId = await createDraftLocation(host);
      const [a, b, c] = await addPhotos(host, locationId, 3);

      const first = await reorder(host, locationId, [c, b, a]);
      const second = await reorder(host, locationId, [c, b, a]);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(idsOf(second.body)).toEqual(idsOf(first.body));
      expect(positionsOf(second.body)).toEqual([0, 1, 2]);
    });

    it("moving the last photo to first is one request and makes it the cover", async () => {
      const locationId = await createDraftLocation(host);
      const ids = await addPhotos(host, locationId, 4);
      const last = ids[3];

      const res = await reorder(host, locationId, [last, ...ids.slice(0, 3)]);

      expect(res.status).toBe(200);
      // Cover is "lowest position", and there is no is_cover flag anywhere.
      expect(res.body.data[0].id).toBe(last);
      expect(res.body.data[0].position).toBe(0);
    });

    it("a single-photo gallery is safe and lands at position 0", async () => {
      const locationId = await createDraftLocation(host);
      const [only] = await addPhotos(host, locationId, 1);

      const res = await reorder(host, locationId, [only]);

      expect(res.status).toBe(200);
      expect(idsOf(res.body)).toEqual([only]);
      expect(positionsOf(res.body)).toEqual([0]);
    });

    it("normalises a gallery whose positions are not already 0-based", async () => {
      // Exactly the live staging shape: HLV Film City's only photo sits at
      // position 1, so nothing may assume position 0 means "cover".
      const locationId = await createDraftLocation(host);

      // Phase 29.5: built with explicit positions on complete. This used to push the rows out of
      // the 0-based range with the legacy single-row PATCH, which no longer exists — and because
      // that PATCH would now simply 404, leaving the gallery at 0,1, the test would have gone on
      // passing while testing nothing at all.
      const a = await addPhoto(host, locationId, 7);
      const b = await addPhoto(host, locationId, 9);

      // Proves the precondition rather than assuming it.
      const before = await listMedia(host, locationId);
      expect(positionsOf(before.body)).toEqual([7, 9]);

      const res = await reorder(host, locationId, [b, a]);

      expect(res.status).toBe(200);
      expect(idsOf(res.body)).toEqual([b, a]);
      expect(positionsOf(res.body)).toEqual([0, 1]);
    });
  });

  // ---- Validation -------------------------------------------------------

  describe("validation", () => {
    let locationId: string;
    let ids: string[];

    beforeAll(async () => {
      locationId = await createDraftLocation(host, "Reorder Validation Location");
      ids = await addPhotos(host, locationId, 3);
    });

    it("rejects duplicate ids", async () => {
      const res = await reorder(host, locationId, [ids[0], ids[0], ids[1]]);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects a missing id — the list must be the complete gallery", async () => {
      const res = await reorder(host, locationId, [ids[0], ids[1]]);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects an extra id that belongs to another location", async () => {
      const otherLocation = await createDraftLocation(otherHost, "Someone Else's Location");
      const [foreign] = await addPhotos(otherHost, otherLocation, 1);

      const res = await reorder(host, locationId, [...ids, foreign]);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      // Must not become an existence oracle for another host's media.
      expect(JSON.stringify(res.body)).not.toContain(foreign);
    });

    it("rejects an id from another location even when the count matches", async () => {
      const otherLocation = await createDraftLocation(otherHost, "Another Location");
      const [foreign] = await addPhotos(otherHost, otherLocation, 1);

      // Same length as the gallery, but one id is not ours — this is the case
      // that would silently renumber a partial gallery without explicit checks.
      const res = await reorder(host, locationId, [ids[0], ids[1], foreign]);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects a malformed uuid", async () => {
      const res = await reorder(host, locationId, [ids[0], "not-a-uuid", ids[2]]);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects an empty list", async () => {
      const res = await reorder(host, locationId, []);
      expect(res.status).toBe(400);
    });

    it("rejects more than 100 ids", async () => {
      const tooMany = Array.from({ length: 101 }, () => "11111111-1111-4111-8111-111111111111");
      const res = await reorder(host, locationId, tooMany);
      expect(res.status).toBe(400);
    });

    it("rejects a wrong body shape", async () => {
      const missing = await request(app)
        .put(`/v1/locations/${locationId}/media/order`)
        .set(authHeader(host))
        .send({});
      expect(missing.status).toBe(400);

      const wrongType = await reorder(host, locationId, "not-an-array");
      expect(wrongType.status).toBe(400);

      const unknownKey = await request(app)
        .put(`/v1/locations/${locationId}/media/order`)
        .set(authHeader(host))
        .send({ ordered_ids: ids, surprise: true });
      expect(unknownKey.status).toBe(400);
    });

    it("leaves the gallery untouched when validation fails", async () => {
      const before = await listMedia(host, locationId);
      await reorder(host, locationId, [ids[0], ids[0], ids[1]]);
      const after = await listMedia(host, locationId);

      expect(idsOf(after.body)).toEqual(idsOf(before.body));
      expect(positionsOf(after.body)).toEqual(positionsOf(before.body));
    });
  });

  // ---- Authorization ----------------------------------------------------

  describe("authorization", () => {
    it("lets the owner reorder", async () => {
      const locationId = await createDraftLocation(host);
      const [a, b] = await addPhotos(host, locationId, 2);

      const res = await reorder(host, locationId, [b, a]);
      expect(res.status).toBe(200);
    });

    it("lets an admin reorder a location they do not own", async () => {
      const locationId = await createDraftLocation(host);
      const [a, b] = await addPhotos(host, locationId, 2);

      const res = await reorder(admin, locationId, [b, a]);

      expect(res.status).toBe(200);
      expect(idsOf(res.body)).toEqual([b, a]);
    });

    it("hides a draft location from another host entirely (404, not 403)", async () => {
      const locationId = await createDraftLocation(host);
      const [a, b] = await addPhotos(host, locationId, 2);

      const res = await reorder(otherHost, locationId, [b, a]);
      expect(res.status).toBe(404);
    });

    it("returns 403 once the location is visible but still not theirs", async () => {
      const locationId = await createDraftLocation(host);
      const [a, b] = await addPhotos(host, locationId, 2);

      await request(app).patch(`/v1/locations/${locationId}`).set(authHeader(admin)).send({ status: "approved" });
      const published = await request(app)
        .patch(`/v1/locations/${locationId}`)
        .set(authHeader(admin))
        .send({ status: "published" });
      expect(published.status).toBe(200);

      const res = await reorder(otherHost, locationId, [b, a]);
      expect(res.status).toBe(403);
    });

    it("rejects a booker who owns no locations", async () => {
      const locationId = await createDraftLocation(host);
      const [a, b] = await addPhotos(host, locationId, 2);

      const res = await reorder(booker, locationId, [b, a]);
      expect(res.status).toBe(404);
    });

    it("requires authentication", async () => {
      const locationId = await createDraftLocation(host);
      const [a, b] = await addPhotos(host, locationId, 2);

      const res = await request(app)
        .put(`/v1/locations/${locationId}/media/order`)
        .send({ ordered_ids: [b, a] });

      expect(res.status).toBe(401);
    });

    it("returns 404 for a location that does not exist", async () => {
      const unknown = "99999999-9999-4999-8999-999999999999";
      const res = await reorder(host, unknown, ["11111111-1111-4111-8111-111111111111"]);
      expect(res.status).toBe(404);
    });
  });

  // ---- Ordering integrity ----------------------------------------------

  describe("ordering integrity", () => {
    it("produces contiguous, 0-based, duplicate-free positions", async () => {
      const locationId = await createDraftLocation(host);
      const ids = await addPhotos(host, locationId, 5);

      const shuffled = [ids[3], ids[0], ids[4], ids[2], ids[1]];
      const res = await reorder(host, locationId, shuffled);

      expect(res.status).toBe(200);
      const positions = positionsOf(res.body);
      expect(positions).toEqual([0, 1, 2, 3, 4]);
      expect(new Set(positions).size).toBe(positions.length);
      expect(idsOf(res.body)).toEqual(shuffled);
    });

    it("does not drift across repeated reorders", async () => {
      const locationId = await createDraftLocation(host);
      const ids = await addPhotos(host, locationId, 4);

      let current = [...ids];
      for (let i = 0; i < 5; i += 1) {
        current = [current[current.length - 1], ...current.slice(0, -1)];
        const res = await reorder(host, locationId, current);
        expect(res.status).toBe(200);
        expect(idsOf(res.body)).toEqual(current);
        expect(positionsOf(res.body)).toEqual([0, 1, 2, 3]);
      }
    });

    it("a new photo appends after a reorder without disturbing it", async () => {
      const locationId = await createDraftLocation(host);
      const [a, b] = await addPhotos(host, locationId, 2);

      await reorder(host, locationId, [b, a]);
      const added = await addPhoto(host, locationId);

      const list = await listMedia(host, locationId);
      expect(idsOf(list.body)).toEqual([b, a, added]);
      expect(positionsOf(list.body)).toEqual([0, 1, 2]);
    });

    it("the legacy single-row PATCH endpoint is gone (Phase 29.5)", async () => {
      // It used to set one row's raw position and renumber nothing else, so a swap meant two
      // independent requests with a duplicate position in between. That is exactly the shape a
      // UNIQUE (location_id, position) index cannot tolerate, and the B2.5-e audit established
      // that no client calls it any more. Atomic reorder is the supported mechanism.
      const locationId = await createDraftLocation(host);
      const [a, b] = await addPhotos(host, locationId, 2);

      const res = await request(app)
        .patch(`/v1/locations/${locationId}/media/${b}`)
        .set(authHeader(host))
        .send({ position: 0 });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");

      // The route is gone, so nothing moved and no duplicate position was created.
      const after = await listMedia(host, locationId);
      expect(idsOf(after.body)).toEqual([a, b]);
      expect(positionsOf(after.body)).toEqual([0, 1]);
    });
  });

  // ---- Atomicity --------------------------------------------------------

  describe("atomicity", () => {
    it("a rejected reorder leaves no partially renumbered gallery", async () => {
      const locationId = await createDraftLocation(host);
      const ids = await addPhotos(host, locationId, 3);

      const before = await listMedia(host, locationId);
      const beforeIds = idsOf(before.body);
      const beforePositions = positionsOf(before.body);

      const otherLocation = await createDraftLocation(otherHost, "Atomicity Foreign Location");
      const [foreign] = await addPhotos(otherHost, otherLocation, 1);

      // Same count, one foreign id. Without explicit set validation this would
      // renumber the two matching rows and leave the third stale.
      const res = await reorder(host, locationId, [ids[2], ids[1], foreign]);
      expect(res.status).toBe(400);

      const after = await listMedia(host, locationId);
      expect(idsOf(after.body)).toEqual(beforeIds);
      expect(positionsOf(after.body)).toEqual(beforePositions);
    });

    it("the foreign location's own gallery is untouched by a rejected reorder", async () => {
      const locationId = await createDraftLocation(host);
      const ids = await addPhotos(host, locationId, 2);

      const otherLocation = await createDraftLocation(otherHost, "Untouched Location");
      const foreignIds = await addPhotos(otherHost, otherLocation, 2);

      const before = await listMedia(otherHost, otherLocation);

      const res = await reorder(host, locationId, [ids[0], foreignIds[0]]);
      expect(res.status).toBe(400);

      const after = await listMedia(otherHost, otherLocation);
      expect(idsOf(after.body)).toEqual(idsOf(before.body));
      expect(positionsOf(after.body)).toEqual(positionsOf(before.body));
    });
  });
});
