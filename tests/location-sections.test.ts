import request from "supertest";
import { beforeAll, describe, expect, it, vi } from "vitest";

// The same hoisted R2 stand-in the other media suites use.
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
const MAX_SECTIONS = 20;

function authHeader(user: TestUser): { Authorization: string } {
  return { Authorization: `Bearer ${user.accessToken}` };
}

async function grantHostRole(user: TestUser): Promise<void> {
  const res = await request(app).post("/v1/me/roles").set(authHeader(user)).send({ role: "host" });
  expect(res.status).toBe(201);
}

async function createDraftLocation(owner: TestUser, title = "Sections Test Location"): Promise<string> {
  const res = await request(app)
    .post("/v1/locations")
    .set(authHeader(owner))
    .send({ title, city: "Mumbai", country: "India" });
  expect(res.status).toBe(201);
  return res.body.data.id as string;
}

async function publish(locationId: string, admin: TestUser): Promise<void> {
  await request(app).patch(`/v1/locations/${locationId}`).set(authHeader(admin)).send({ status: "approved" });
  const res = await request(app).patch(`/v1/locations/${locationId}`).set(authHeader(admin)).send({ status: "published" });
  expect(res.status).toBe(200);
}

function createSection(user: TestUser, locationId: string, body: object) {
  return request(app).post(`/v1/locations/${locationId}/sections`).set(authHeader(user)).send(body);
}

async function makeSection(user: TestUser, locationId: string, name = "Police Station"): Promise<string> {
  const res = await createSection(user, locationId, { name });
  expect(res.status).toBe(201);
  return res.body.data.id as string;
}

function listSections(locationId: string, user?: TestUser) {
  const req = request(app).get(`/v1/locations/${locationId}/sections`);
  return user ? req.set(authHeader(user)) : req;
}

function listGeneralMedia(locationId: string, user?: TestUser) {
  const req = request(app).get(`/v1/locations/${locationId}/media`);
  return user ? req.set(authHeader(user)) : req;
}

function listSectionMedia(locationId: string, sectionId: string, user?: TestUser) {
  const req = request(app).get(`/v1/locations/${locationId}/sections/${sectionId}/media`);
  return user ? req.set(authHeader(user)) : req;
}

/** Authorize an upload and write the object into the R2 stand-in, without completing it. */
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

function complete(user: TestUser, locationId: string, mediaId: string, body: object = {}) {
  return request(app)
    .post(`/v1/locations/${locationId}/media/${mediaId}/complete`)
    .set(authHeader(user))
    .send(body);
}

/** Authorize → upload → complete into a gallery. `sectionId` null = the general gallery. */
async function addPhoto(owner: TestUser, locationId: string, sectionId: string | null = null): Promise<string> {
  const mediaId = await stageUpload(owner, locationId);
  const done = await complete(owner, locationId, mediaId, sectionId ? { section_id: sectionId } : {});
  expect(done.status).toBe(201);
  return mediaId;
}

async function addPhotos(owner: TestUser, locationId: string, count: number, sectionId: string | null = null) {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    ids.push(await addPhoto(owner, locationId, sectionId));
  }
  return ids;
}

function reorder(user: TestUser, locationId: string, orderedIds: unknown, sectionId?: string | null) {
  const body: Record<string, unknown> = { ordered_ids: orderedIds };
  if (sectionId !== undefined) {
    body.section_id = sectionId;
  }
  return request(app).put(`/v1/locations/${locationId}/media/order`).set(authHeader(user)).send(body);
}

function idsOf(body: { data: { id: string }[] }): string[] {
  return body.data.map((m) => m.id);
}

function positionsOf(body: { data: { position: number }[] }): number[] {
  return body.data.map((m) => m.position);
}

describe("Phase 29.6: location sections", () => {
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

  // ---- CRUD --------------------------------------------------------------

  describe("section CRUD", () => {
    it("creates a section with a name and an optional description", async () => {
      const locationId = await createDraftLocation(host);
      const res = await createSection(host, locationId, { name: "Arabian City", description: "Desert street set" });

      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({
        location_id: locationId,
        name: "Arabian City",
        description: "Desert street set",
      });
      expect(res.body.data.id).toBeTruthy();
      expect(res.body.data.created_at).toBeTruthy();
    });

    it("creates a section with no description at all", async () => {
      const locationId = await createDraftLocation(host);
      const res = await createSection(host, locationId, { name: "Warehouse" });
      expect(res.status).toBe(201);
      expect(res.body.data.description).toBeNull();
    });

    it("lists a location's sections with cover and photo count", async () => {
      const locationId = await createDraftLocation(host);
      const first = await makeSection(host, locationId, "Police Station");
      const second = await makeSection(host, locationId, "Warehouse");
      const photos = await addPhotos(host, locationId, 2, first);

      const res = await listSections(locationId, host);
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);

      const a = res.body.data.find((s: { id: string }) => s.id === first);
      const b = res.body.data.find((s: { id: string }) => s.id === second);
      expect(a.photo_count).toBe(2);
      expect(a.cover.id).toBe(photos[0]); // lowest position
      expect(a.cover.url).toContain("https://");
      expect(b.photo_count).toBe(0);
      expect(b.cover).toBeNull();
    });

    it("does not return every section's media in the list response", async () => {
      const locationId = await createDraftLocation(host);
      const sectionId = await makeSection(host, locationId);
      await addPhotos(host, locationId, 3, sectionId);

      const res = await listSections(locationId, host);
      const section = res.body.data[0];
      // A cover and a count, not a gallery.
      expect(section.photo_count).toBe(3);
      expect(section.media).toBeUndefined();
      expect(Object.keys(section).sort()).toEqual(
        ["cover", "created_at", "description", "id", "location_id", "name", "photo_count", "updated_at"].sort()
      );
    });

    it("gets a single section", async () => {
      const locationId = await createDraftLocation(host);
      const sectionId = await makeSection(host, locationId, "Rooftop");
      const res = await request(app).get(`/v1/locations/${locationId}/sections/${sectionId}`).set(authHeader(host));
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ id: sectionId, name: "Rooftop", location_id: locationId });
    });

    it("updates a section's name and description", async () => {
      const locationId = await createDraftLocation(host);
      const sectionId = await makeSection(host, locationId, "Old Name");

      const res = await request(app)
        .patch(`/v1/locations/${locationId}/sections/${sectionId}`)
        .set(authHeader(host))
        .send({ name: "New Name", description: "Now described" });

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ name: "New Name", description: "Now described" });
    });

    it("clears a description with null", async () => {
      const locationId = await createDraftLocation(host);
      const sectionId = await makeSection(host, locationId);
      await request(app)
        .patch(`/v1/locations/${locationId}/sections/${sectionId}`)
        .set(authHeader(host))
        .send({ description: "temporary" });

      const res = await request(app)
        .patch(`/v1/locations/${locationId}/sections/${sectionId}`)
        .set(authHeader(host))
        .send({ description: null });

      expect(res.status).toBe(200);
      expect(res.body.data.description).toBeNull();
    });

    it("deletes an empty section", async () => {
      const locationId = await createDraftLocation(host);
      const sectionId = await makeSection(host, locationId);

      const res = await request(app)
        .delete(`/v1/locations/${locationId}/sections/${sectionId}`)
        .set(authHeader(host));

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ id: sectionId, deleted: true });
      expect((await listSections(locationId, host)).body.data).toHaveLength(0);
    });
  });

  // ---- Validation ---------------------------------------------------------

  describe("validation", () => {
    it("requires a name", async () => {
      const locationId = await createDraftLocation(host);
      expect((await createSection(host, locationId, {})).status).toBe(400);
      expect((await createSection(host, locationId, { name: "" })).status).toBe(400);
      expect((await createSection(host, locationId, { name: "   " })).status).toBe(400);
    });

    it("rejects an over-long name and description", async () => {
      const locationId = await createDraftLocation(host);
      expect((await createSection(host, locationId, { name: "x".repeat(201) })).status).toBe(400);
      expect((await createSection(host, locationId, { name: "ok", description: "y".repeat(5001) })).status).toBe(400);
    });

    it("rejects unknown fields, including an attempt to set location_id", async () => {
      const locationId = await createDraftLocation(host);
      const other = await createDraftLocation(host, "Somewhere else");
      expect((await createSection(host, locationId, { name: "ok", location_id: other })).status).toBe(400);
    });

    it("refuses an empty update", async () => {
      const locationId = await createDraftLocation(host);
      const sectionId = await makeSection(host, locationId);
      const res = await request(app)
        .patch(`/v1/locations/${locationId}/sections/${sectionId}`)
        .set(authHeader(host))
        .send({});
      expect(res.status).toBe(400);
    });

    it("allows DUPLICATE section names within one location", async () => {
      const locationId = await createDraftLocation(host);
      const first = await createSection(host, locationId, { name: "Warehouse" });
      const second = await createSection(host, locationId, { name: "Warehouse" });

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(first.body.data.id).not.toBe(second.body.data.id);
      expect((await listSections(locationId, host)).body.data).toHaveLength(2);
    });

    it(`caps a location at ${MAX_SECTIONS} sections`, async () => {
      const locationId = await createDraftLocation(host);
      for (let i = 0; i < MAX_SECTIONS; i += 1) {
        expect((await createSection(host, locationId, { name: `Section ${i}` })).status).toBe(201);
      }

      const overflow = await createSection(host, locationId, { name: "One too many" });
      expect(overflow.status).toBe(400);
      expect(overflow.body.error.message).toContain(String(MAX_SECTIONS));

      expect((await listSections(locationId, host)).body.data).toHaveLength(MAX_SECTIONS);
    });

    it("the cap is per location, not global", async () => {
      const first = await createDraftLocation(host, "Capped");
      const second = await createDraftLocation(host, "Not capped");
      for (let i = 0; i < MAX_SECTIONS; i += 1) {
        await createSection(host, first, { name: `S${i}` });
      }
      expect((await createSection(host, second, { name: "Fine" })).status).toBe(201);
    });
  });

  // ---- Ownership ----------------------------------------------------------

  describe("ownership", () => {
    it("hides another host's draft location entirely (404, not 403)", async () => {
      const locationId = await createDraftLocation(host);
      const sectionId = await makeSection(host, locationId);

      expect((await createSection(otherHost, locationId, { name: "Theirs" })).status).toBe(404);
      expect(
        (await request(app).patch(`/v1/locations/${locationId}/sections/${sectionId}`).set(authHeader(otherHost)).send({ name: "x" }))
          .status
      ).toBe(404);
      expect(
        (await request(app).delete(`/v1/locations/${locationId}/sections/${sectionId}`).set(authHeader(otherHost))).status
      ).toBe(404);
    });

    it("returns 403 once the location is visible but still not theirs", async () => {
      const locationId = await createDraftLocation(host);
      const sectionId = await makeSection(host, locationId);
      await publish(locationId, admin);

      expect((await createSection(otherHost, locationId, { name: "Theirs" })).status).toBe(403);
      expect(
        (await request(app).delete(`/v1/locations/${locationId}/sections/${sectionId}`).set(authHeader(otherHost))).status
      ).toBe(403);
    });

    it("requires authentication to write", async () => {
      const locationId = await createDraftLocation(host);
      const sectionId = await makeSection(host, locationId);

      expect((await request(app).post(`/v1/locations/${locationId}/sections`).send({ name: "x" })).status).toBe(401);
      expect((await request(app).patch(`/v1/locations/${locationId}/sections/${sectionId}`).send({ name: "x" })).status).toBe(401);
      expect((await request(app).delete(`/v1/locations/${locationId}/sections/${sectionId}`)).status).toBe(401);
    });

    it("lets an admin manage sections on a location they do not own", async () => {
      const locationId = await createDraftLocation(host);
      const created = await createSection(admin, locationId, { name: "Admin made this" });
      expect(created.status).toBe(201);

      const updated = await request(app)
        .patch(`/v1/locations/${locationId}/sections/${created.body.data.id}`)
        .set(authHeader(admin))
        .send({ name: "Admin renamed it" });
      expect(updated.status).toBe(200);

      const deleted = await request(app)
        .delete(`/v1/locations/${locationId}/sections/${created.body.data.id}`)
        .set(authHeader(admin));
      expect(deleted.status).toBe(200);
    });

    it("does not expose a draft location's sections publicly, but does once published", async () => {
      const locationId = await createDraftLocation(host);
      await makeSection(host, locationId, "Secret Set");

      expect((await listSections(locationId)).status).toBe(404);

      await publish(locationId, admin);
      const res = await listSections(locationId);
      expect(res.status).toBe(200);
      expect(res.body.data[0].name).toBe("Secret Set");
    });

    it("refuses a section id from another location without revealing it exists", async () => {
      const mine = await createDraftLocation(host, "Mine");
      const theirs = await createDraftLocation(host, "Theirs");
      const foreignSection = await makeSection(host, theirs, "Not for you");

      const crossed = await request(app).get(`/v1/locations/${mine}/sections/${foreignSection}`).set(authHeader(host));
      const invented = await request(app)
        .get(`/v1/locations/${mine}/sections/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee`)
        .set(authHeader(host));

      expect(crossed.status).toBe(404);
      expect(invented.status).toBe(404);
      expect(crossed.body).toEqual(invented.body);
    });
  });

  // ---- Section / media relationship ---------------------------------------

  describe("section/media relationship", () => {
    it("a photo completed with no section_id joins the GENERAL gallery", async () => {
      const locationId = await createDraftLocation(host);
      const mediaId = await addPhoto(host, locationId);

      const general = await listGeneralMedia(locationId, host);
      expect(idsOf(general.body)).toEqual([mediaId]);
    });

    it("a photo completed with a section_id joins THAT section", async () => {
      const locationId = await createDraftLocation(host);
      const sectionId = await makeSection(host, locationId);
      const mediaId = await addPhoto(host, locationId, sectionId);

      const sectionMedia = await listSectionMedia(locationId, sectionId, host);
      expect(idsOf(sectionMedia.body)).toEqual([mediaId]);
    });

    it("general media never appears in a section listing", async () => {
      const locationId = await createDraftLocation(host);
      const sectionId = await makeSection(host, locationId);
      const generalId = await addPhoto(host, locationId);
      const sectionPhoto = await addPhoto(host, locationId, sectionId);

      const sectionMedia = await listSectionMedia(locationId, sectionId, host);
      expect(idsOf(sectionMedia.body)).toEqual([sectionPhoto]);
      expect(idsOf(sectionMedia.body)).not.toContain(generalId);
    });

    it("section media never appears in the general gallery", async () => {
      const locationId = await createDraftLocation(host);
      const sectionId = await makeSection(host, locationId);
      const generalId = await addPhoto(host, locationId);
      const sectionPhoto = await addPhoto(host, locationId, sectionId);

      const general = await listGeneralMedia(locationId, host);
      expect(idsOf(general.body)).toEqual([generalId]);
      expect(idsOf(general.body)).not.toContain(sectionPhoto);
    });

    it("one section's media never appears in another's", async () => {
      const locationId = await createDraftLocation(host);
      const a = await makeSection(host, locationId, "A");
      const b = await makeSection(host, locationId, "B");
      const inA = await addPhotos(host, locationId, 2, a);
      const inB = await addPhotos(host, locationId, 3, b);

      expect(idsOf((await listSectionMedia(locationId, a, host)).body)).toEqual(inA);
      expect(idsOf((await listSectionMedia(locationId, b, host)).body)).toEqual(inB);
    });

    it("rejects attaching media to a section belonging to a DIFFERENT location", async () => {
      const mine = await createDraftLocation(host, "Mine");
      const theirs = await createDraftLocation(host, "Theirs");
      const foreignSection = await makeSection(host, theirs, "Foreign");

      const mediaId = await stageUpload(host, mine);
      const res = await complete(host, mine, mediaId, { section_id: foreignSection });

      expect(res.status).toBe(404);
      // Nothing was recorded anywhere.
      expect((await listGeneralMedia(mine, host)).body.data).toHaveLength(0);
      expect((await listSectionMedia(theirs, foreignSection, host)).body.data).toHaveLength(0);
    });

    it("rejects a section_id that does not exist", async () => {
      const locationId = await createDraftLocation(host);
      const mediaId = await stageUpload(host, locationId);
      const res = await complete(host, locationId, mediaId, {
        section_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      });
      expect(res.status).toBe(404);
    });

    it("a null section_id is the general gallery, exactly like omitting it", async () => {
      const locationId = await createDraftLocation(host);
      const mediaId = await stageUpload(host, locationId);
      const res = await complete(host, locationId, mediaId, { section_id: null });
      expect(res.status).toBe(201);
      expect(idsOf((await listGeneralMedia(locationId, host)).body)).toEqual([mediaId]);
    });

    it("deleting section media leaves the general gallery untouched", async () => {
      const locationId = await createDraftLocation(host);
      const sectionId = await makeSection(host, locationId);
      const generalIds = await addPhotos(host, locationId, 2);
      const sectionIds = await addPhotos(host, locationId, 2, sectionId);

      await request(app).delete(`/v1/locations/${locationId}/media/${sectionIds[0]}`).set(authHeader(host));

      expect(idsOf((await listGeneralMedia(locationId, host)).body)).toEqual(generalIds);
      expect(idsOf((await listSectionMedia(locationId, sectionId, host)).body)).toEqual([sectionIds[1]]);
    });
  });

  // ---- The general gallery must stay the general gallery -------------------

  describe("general gallery compatibility", () => {
    it("positions restart per gallery: a section photo may also sit at position 0", async () => {
      const locationId = await createDraftLocation(host);
      const sectionId = await makeSection(host, locationId);
      await addPhotos(host, locationId, 2);
      await addPhotos(host, locationId, 2, sectionId);

      expect(positionsOf((await listGeneralMedia(locationId, host)).body)).toEqual([0, 1]);
      expect(positionsOf((await listSectionMedia(locationId, sectionId, host)).body)).toEqual([0, 1]);
    });

    it("location detail returns ONLY general-gallery media, plus lightweight section metadata", async () => {
      const locationId = await createDraftLocation(host);
      const sectionId = await makeSection(host, locationId, "Police Station");
      const generalIds = await addPhotos(host, locationId, 2);
      await addPhotos(host, locationId, 3, sectionId);

      const res = await request(app).get(`/v1/locations/${locationId}`).set(authHeader(host));
      expect(res.status).toBe(200);
      expect(res.body.data.media.map((m: { id: string }) => m.id)).toEqual(generalIds);

      expect(res.body.data.sections).toHaveLength(1);
      expect(res.body.data.sections[0]).toMatchObject({ id: sectionId, name: "Police Station", photo_count: 3 });
      expect(res.body.data.sections[0].cover).not.toBeNull();
    });

    it("a section photo never becomes the location's cover in SEARCH", async () => {
      const locationId = await createDraftLocation(host, "Cover Check Location");
      const sectionId = await makeSection(host, locationId);

      // Deliberately rigged so the answer cannot be a coincidence: the section photo sits at
      // position 0, the general one at position 5. Without `section_id is null` in
      // search_locations()'s primary_media_key subquery, `order by position limit 1` picks the
      // SECTION photo. (Both galleries start at 0, so leaving them tied would let this pass by luck.)
      await addPhoto(host, locationId, sectionId);
      const generalMediaId = await stageUpload(host, locationId);
      expect((await complete(host, locationId, generalMediaId, { position: 5 })).status).toBe(201);
      const generalId = generalMediaId;
      await publish(locationId, admin);

      const res = await request(app).get("/v1/locations").query({ search: "Cover Check Location" });
      expect(res.status).toBe(200);
      const found = res.body.data.find((l: { id: string }) => l.id === locationId);
      expect(found).toBeTruthy();
      // The general-gallery photo, not the section photo.
      expect(found.primary_media_url).toContain(generalId);
    });

    it("a location with only section photos has no general cover at all", async () => {
      const locationId = await createDraftLocation(host, "Sections Only Location");
      const sectionId = await makeSection(host, locationId);
      await addPhotos(host, locationId, 2, sectionId);
      await publish(locationId, admin);

      const res = await request(app).get("/v1/locations").query({ search: "Sections Only Location" });
      const found = res.body.data.find((l: { id: string }) => l.id === locationId);
      expect(found.primary_media_url).toBeNull();
      expect((await listGeneralMedia(locationId)).body.data).toHaveLength(0);
    });
  });

  // ---- Ordering -----------------------------------------------------------

  describe("ordering", () => {
    it("reorders the general gallery when no section_id is given (unchanged behaviour)", async () => {
      const locationId = await createDraftLocation(host);
      const [a, b, c] = await addPhotos(host, locationId, 3);

      const res = await reorder(host, locationId, [c, a, b]);
      expect(res.status).toBe(200);
      expect(idsOf(res.body)).toEqual([c, a, b]);
      expect(positionsOf(res.body)).toEqual([0, 1, 2]);
    });

    it("reorders one section's gallery", async () => {
      const locationId = await createDraftLocation(host);
      const sectionId = await makeSection(host, locationId);
      const [a, b, c] = await addPhotos(host, locationId, 3, sectionId);

      const res = await reorder(host, locationId, [c, b, a], sectionId);
      expect(res.status).toBe(200);
      expect(idsOf(res.body)).toEqual([c, b, a]);
      expect(positionsOf(res.body)).toEqual([0, 1, 2]);
    });

    it("reordering a section leaves the general gallery untouched, and vice versa", async () => {
      const locationId = await createDraftLocation(host);
      const sectionId = await makeSection(host, locationId);
      const general = await addPhotos(host, locationId, 3);
      const inSection = await addPhotos(host, locationId, 3, sectionId);

      await reorder(host, locationId, [...inSection].reverse(), sectionId);
      expect(idsOf((await listGeneralMedia(locationId, host)).body)).toEqual(general);

      await reorder(host, locationId, [...general].reverse());
      expect(idsOf((await listSectionMedia(locationId, sectionId, host)).body)).toEqual([...inSection].reverse());
    });

    it("rejects an incomplete set WITHIN the chosen gallery", async () => {
      const locationId = await createDraftLocation(host);
      const sectionId = await makeSection(host, locationId);
      const inSection = await addPhotos(host, locationId, 3, sectionId);

      const res = await reorder(host, locationId, [inSection[0], inSection[1]], sectionId);
      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain("gallery has 3, received 2");
    });

    it("rejects duplicate ids", async () => {
      const locationId = await createDraftLocation(host);
      const sectionId = await makeSection(host, locationId);
      const inSection = await addPhotos(host, locationId, 2, sectionId);
      const res = await reorder(host, locationId, [inSection[0], inSection[0], inSection[1]], sectionId);
      expect(res.status).toBe(400);
    });

    it("rejects an id from ANOTHER LOCATION", async () => {
      const locationId = await createDraftLocation(host);
      const elsewhere = await createDraftLocation(host, "Elsewhere");
      const mine = await addPhotos(host, locationId, 1);
      const foreign = await addPhoto(host, elsewhere);

      const res = await reorder(host, locationId, [mine[0], foreign]);
      expect(res.status).toBe(400);
    });

    it("rejects reordering a section with a GENERAL-gallery id", async () => {
      const locationId = await createDraftLocation(host);
      const sectionId = await makeSection(host, locationId);
      const general = await addPhoto(host, locationId);
      const inSection = await addPhotos(host, locationId, 2, sectionId);

      const res = await reorder(host, locationId, [inSection[0], general], sectionId);
      expect(res.status).toBe(400);
      // Nothing moved.
      expect(idsOf((await listSectionMedia(locationId, sectionId, host)).body)).toEqual(inSection);
      expect(idsOf((await listGeneralMedia(locationId, host)).body)).toEqual([general]);
    });

    it("rejects reordering the general gallery with a SECTION id", async () => {
      const locationId = await createDraftLocation(host);
      const sectionId = await makeSection(host, locationId);
      const general = await addPhotos(host, locationId, 2);
      const inSection = await addPhoto(host, locationId, sectionId);

      const res = await reorder(host, locationId, [general[0], inSection]);
      expect(res.status).toBe(400);
      expect(idsOf((await listGeneralMedia(locationId, host)).body)).toEqual(general);
    });

    it("rejects an id from a DIFFERENT SECTION of the same location", async () => {
      const locationId = await createDraftLocation(host);
      const a = await makeSection(host, locationId, "A");
      const b = await makeSection(host, locationId, "B");
      const inA = await addPhotos(host, locationId, 2, a);
      const inB = await addPhoto(host, locationId, b);

      const res = await reorder(host, locationId, [inA[0], inB], a);
      expect(res.status).toBe(400);
      expect(idsOf((await listSectionMedia(locationId, a, host)).body)).toEqual(inA);
    });

    it("rejects a section_id belonging to another location", async () => {
      const locationId = await createDraftLocation(host);
      const elsewhere = await createDraftLocation(host, "Elsewhere");
      const foreignSection = await makeSection(host, elsewhere, "Foreign");
      const mine = await addPhotos(host, locationId, 1);

      const res = await reorder(host, locationId, mine, foreignSection);
      expect(res.status).toBe(404);
    });

    it("the removed single-item PATCH is still gone", async () => {
      const locationId = await createDraftLocation(host);
      const sectionId = await makeSection(host, locationId);
      const [mediaId] = await addPhotos(host, locationId, 1, sectionId);

      const res = await request(app)
        .patch(`/v1/locations/${locationId}/media/${mediaId}`)
        .set(authHeader(host))
        .send({ position: 0 });
      expect(res.status).toBe(404);
    });
  });

  // ---- Concurrency (the Phase 29.5 guarantee, now per gallery) ------------

  describe("concurrency", () => {
    it("concurrent completions into ONE section get distinct, contiguous positions", async () => {
      const locationId = await createDraftLocation(host);
      const sectionId = await makeSection(host, locationId);
      const staged = await Promise.all([1, 2, 3, 4, 5, 6].map(() => stageUpload(host, locationId)));

      const results = await Promise.all(staged.map((id) => complete(host, locationId, id, { section_id: sectionId })));

      expect(results.every((r) => r.status === 201)).toBe(true);
      const positions = results.map((r) => r.body.data.position as number);
      expect(new Set(positions).size).toBe(6);
      expect([...positions].sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4, 5]);
      expect(positionsOf((await listSectionMedia(locationId, sectionId, host)).body)).toEqual([0, 1, 2, 3, 4, 5]);
    });

    it("concurrent completions into DIFFERENT sections do not corrupt one another", async () => {
      const locationId = await createDraftLocation(host);
      const a = await makeSection(host, locationId, "A");
      const b = await makeSection(host, locationId, "B");
      const stagedA = await Promise.all([1, 2, 3].map(() => stageUpload(host, locationId)));
      const stagedB = await Promise.all([1, 2, 3].map(() => stageUpload(host, locationId)));

      const results = await Promise.all([
        ...stagedA.map((id) => complete(host, locationId, id, { section_id: a })),
        ...stagedB.map((id) => complete(host, locationId, id, { section_id: b })),
      ]);
      expect(results.every((r) => r.status === 201)).toBe(true);

      // Each section numbers itself from 0, independently.
      expect(positionsOf((await listSectionMedia(locationId, a, host)).body)).toEqual([0, 1, 2]);
      expect(positionsOf((await listSectionMedia(locationId, b, host)).body)).toEqual([0, 1, 2]);
    });

    it("concurrent completions into a section and the general gallery stay independent", async () => {
      const locationId = await createDraftLocation(host);
      const sectionId = await makeSection(host, locationId);
      const stagedGeneral = await Promise.all([1, 2, 3].map(() => stageUpload(host, locationId)));
      const stagedSection = await Promise.all([1, 2, 3].map(() => stageUpload(host, locationId)));

      const results = await Promise.all([
        ...stagedGeneral.map((id) => complete(host, locationId, id)),
        ...stagedSection.map((id) => complete(host, locationId, id, { section_id: sectionId })),
      ]);
      expect(results.every((r) => r.status === 201)).toBe(true);

      expect(positionsOf((await listGeneralMedia(locationId, host)).body)).toEqual([0, 1, 2]);
      expect(positionsOf((await listSectionMedia(locationId, sectionId, host)).body)).toEqual([0, 1, 2]);
    });

    it("the Phase 29.5 general-gallery guarantee is intact", async () => {
      const locationId = await createDraftLocation(host);
      const staged = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map(() => stageUpload(host, locationId)));

      const results = await Promise.all(staged.map((id) => complete(host, locationId, id)));

      expect(results.every((r) => r.status === 201)).toBe(true);
      const positions = results.map((r) => r.body.data.position as number);
      expect(new Set(positions).size).toBe(8);
      expect([...positions].sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    });

    it("replaying a section completion stays idempotent and does not move it", async () => {
      const locationId = await createDraftLocation(host);
      const sectionId = await makeSection(host, locationId);
      const mediaId = await stageUpload(host, locationId);

      const first = await complete(host, locationId, mediaId, { section_id: sectionId });
      expect(first.status).toBe(201);
      const replay = await complete(host, locationId, mediaId, { section_id: sectionId });
      expect(replay.status).toBe(200);
      expect(replay.body.data).toEqual(first.body.data);

      expect((await listSectionMedia(locationId, sectionId, host)).body.data).toHaveLength(1);
    });
  });

  // ---- Deletion semantics -------------------------------------------------

  describe("section deletion", () => {
    it("refuses to delete a section that still holds media, and deletes nothing", async () => {
      const locationId = await createDraftLocation(host);
      const sectionId = await makeSection(host, locationId);
      const inSection = await addPhotos(host, locationId, 2, sectionId);

      const res = await request(app)
        .delete(`/v1/locations/${locationId}/sections/${sectionId}`)
        .set(authHeader(host));

      expect(res.status).toBe(409);
      expect(res.body.error.message).toContain("2 photos");
      // The section and every photo survive.
      expect((await listSections(locationId, host)).body.data).toHaveLength(1);
      expect(idsOf((await listSectionMedia(locationId, sectionId, host)).body)).toEqual(inSection);
    });

    it("succeeds once its media has been deleted", async () => {
      const locationId = await createDraftLocation(host);
      const sectionId = await makeSection(host, locationId);
      const [mediaId] = await addPhotos(host, locationId, 1, sectionId);

      expect((await request(app).delete(`/v1/locations/${locationId}/sections/${sectionId}`).set(authHeader(host))).status).toBe(409);

      await request(app).delete(`/v1/locations/${locationId}/media/${mediaId}`).set(authHeader(host));

      expect((await request(app).delete(`/v1/locations/${locationId}/sections/${sectionId}`).set(authHeader(host))).status).toBe(200);
      expect((await listSections(locationId, host)).body.data).toHaveLength(0);
    });

    it("deleting a location still works when it has sections AND section media", async () => {
      // The `ON DELETE NO ACTION` design exists for exactly this: both cascades must resolve within
      // one statement. RESTRICT would have aborted it.
      const locationId = await createDraftLocation(host, "Disposable");
      const sectionId = await makeSection(host, locationId);
      await addPhotos(host, locationId, 2, sectionId);
      await addPhotos(host, locationId, 1);

      const res = await request(app).delete(`/v1/locations/${locationId}`).set(authHeader(host));
      expect(res.status).toBe(200);
      expect((await request(app).get(`/v1/locations/${locationId}`)).status).toBe(404);
    });

    it("an unauthorized host cannot delete a section", async () => {
      const locationId = await createDraftLocation(host);
      const sectionId = await makeSection(host, locationId);
      await publish(locationId, admin);

      expect((await request(app).delete(`/v1/locations/${locationId}/sections/${sectionId}`).set(authHeader(otherHost))).status).toBe(403);
      expect((await listSections(locationId, host)).body.data).toHaveLength(1);
    });
  });
});
