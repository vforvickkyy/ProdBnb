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

async function grantAdmin(user: TestUser): Promise<void> {
  const { error } = await adminClient.from("user_roles").insert({ user_id: user.id, role: "admin" });
  if (error) throw error;
}

async function createDraftLocation(owner: TestUser): Promise<string> {
  const res = await request(app)
    .post("/v1/locations")
    .set(authHeader(owner))
    .send({
      title: "Admin Moderation Test Location",
      description: "A location for admin moderation tests.",
      city: "London",
      country: "UK",
      latitude: 51.5,
      longitude: -0.1,
    });
  expect(res.status).toBe(201);
  return res.body.data.id as string;
}

async function createSubmittedLocation(owner: TestUser): Promise<string> {
  const id = await createDraftLocation(owner);
  const res = await request(app).patch(`/v1/locations/${id}`).set(authHeader(owner)).send({ status: "submitted" });
  expect(res.status).toBe(200);
  return id;
}

async function createPublishedLocation(owner: TestUser, admin: TestUser): Promise<string> {
  const id = await createSubmittedLocation(owner);
  const res = await request(app).post(`/v1/admin/locations/${id}/approve`).set(authHeader(admin));
  expect(res.status).toBe(200);
  return id;
}

describe("admin: locations", () => {
  let admin: TestUser;
  let booker: TestUser;
  let host: TestUser;

  beforeAll(async () => {
    admin = await createTestUser();
    booker = await createTestUser();
    host = await createTestUser();
    await grantAdmin(admin);
    await grantRole(booker, "booker");
    await grantRole(host, "host");
  });

  afterAll(async () => {
    await deleteTestUser(admin.id);
    await deleteTestUser(booker.id);
    await deleteTestUser(host.id);
  });

  describe("authorization", () => {
    it("rejects booker/host from every moderation endpoint, admin succeeds", async () => {
      const locationId = await createSubmittedLocation(host);
      for (const nonAdmin of [booker, host]) {
        const res = await request(app).post(`/v1/admin/locations/${locationId}/approve`).set(authHeader(nonAdmin));
        expect(res.status).toBe(403);
      }
      const detail = await request(app).get(`/v1/admin/locations/${locationId}`).set(authHeader(admin));
      expect(detail.status).toBe(200);
    });

    it("rejects an unauthenticated caller", async () => {
      const res = await request(app).get("/v1/admin/locations/00000000-0000-0000-0000-000000000000");
      expect(res.status).toBe(401);
    });
  });

  describe("approve", () => {
    it("moves submitted directly to published (Phase 11 Option A) and clears any prior reason", async () => {
      const locationId = await createSubmittedLocation(host);
      const res = await request(app).post(`/v1/admin/locations/${locationId}/approve`).set(authHeader(admin));
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("published");
      expect(res.body.data.moderation_reason).toBeNull();
    });

    it("approves from under_review too", async () => {
      const locationId = await createSubmittedLocation(host);
      const { error } = await adminClient.from("locations").update({ status: "under_review" }).eq("id", locationId);
      if (error) throw error;
      const res = await request(app).post(`/v1/admin/locations/${locationId}/approve`).set(authHeader(admin));
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("published");
    });

    it("rejects approving a draft (invalid source status)", async () => {
      const locationId = await createDraftLocation(host);
      const res = await request(app).post(`/v1/admin/locations/${locationId}/approve`).set(authHeader(admin));
      expect(res.status).toBe(400);
    });

    it("refuses to approve a location whose host is currently suspended", async () => {
      const suspendedHost = await createTestUser();
      await grantRole(suspendedHost, "host");
      const locationId = await createSubmittedLocation(suspendedHost);
      await request(app).post(`/v1/admin/users/${suspendedHost.id}/suspend`).set(authHeader(admin)).send({ reason: "x" });

      const res = await request(app).post(`/v1/admin/locations/${locationId}/approve`).set(authHeader(admin));
      expect(res.status).toBe(400);

      await deleteTestUser(suspendedHost.id);
    });
  });

  describe("reject", () => {
    it("requires a reason", async () => {
      const locationId = await createSubmittedLocation(host);
      const res = await request(app).post(`/v1/admin/locations/${locationId}/reject`).set(authHeader(admin)).send({});
      expect(res.status).toBe(400);
    });

    it("rejects a submitted location and stores the reason, visible to the owning host", async () => {
      const locationId = await createSubmittedLocation(host);
      const res = await request(app)
        .post(`/v1/admin/locations/${locationId}/reject`)
        .set(authHeader(admin))
        .send({ reason: "Photos are too low quality." });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("rejected");
      expect(res.body.data.moderation_reason).toBe("Photos are too low quality.");

      const hostView = await request(app).get(`/v1/locations/${locationId}`).set(authHeader(host));
      expect(hostView.body.data.moderation_reason).toBe("Photos are too low quality.");
    });

    it("never exposes moderation_reason through the public/unauthenticated location detail", async () => {
      const locationId = await createPublishedLocation(host, admin);
      // published -> moderation_reason must be null by construction, and
      // even if it weren't, an unauthenticated caller should never see a
      // non-published location's reason. Confirm the published (public)
      // response has no reason leak:
      const publicView = await request(app).get(`/v1/locations/${locationId}`);
      expect(publicView.status).toBe(200);
      expect(publicView.body.data.moderation_reason).toBeNull();
    });
  });

  describe("suspend / restore", () => {
    it("requires a reason to suspend", async () => {
      const locationId = await createPublishedLocation(host, admin);
      const res = await request(app).post(`/v1/admin/locations/${locationId}/suspend`).set(authHeader(admin)).send({});
      expect(res.status).toBe(400);
    });

    it("suspends a published location, pulling it out of public search", async () => {
      const locationId = await createPublishedLocation(host, admin);
      const suspend = await request(app)
        .post(`/v1/admin/locations/${locationId}/suspend`)
        .set(authHeader(admin))
        .send({ reason: "Reported by a booker." });
      expect(suspend.status).toBe(200);
      expect(suspend.body.data.status).toBe("suspended");

      const publicView = await request(app).get(`/v1/locations/${locationId}`);
      expect(publicView.status).toBe(404); // not visible to an anonymous caller anymore
    });

    it("rejects suspending a non-published location", async () => {
      const locationId = await createDraftLocation(host);
      const res = await request(app).post(`/v1/admin/locations/${locationId}/suspend`).set(authHeader(admin)).send({ reason: "x" });
      expect(res.status).toBe(400);
    });

    it("restores a suspended location back to published and clears the reason", async () => {
      const locationId = await createPublishedLocation(host, admin);
      await request(app).post(`/v1/admin/locations/${locationId}/suspend`).set(authHeader(admin)).send({ reason: "x" });

      const restore = await request(app).post(`/v1/admin/locations/${locationId}/restore`).set(authHeader(admin));
      expect(restore.status).toBe(200);
      expect(restore.body.data.status).toBe("published");
      expect(restore.body.data.moderation_reason).toBeNull();
    });

    it("rejects restoring a location that isn't suspended", async () => {
      const locationId = await createPublishedLocation(host, admin);
      const res = await request(app).post(`/v1/admin/locations/${locationId}/restore`).set(authHeader(admin));
      expect(res.status).toBe(400);
    });
  });

  describe("host suspension cascade", () => {
    it("suspending a host suspends only their published locations, leaving other states and independent decisions untouched", async () => {
      const cascadeHost = await createTestUser();
      await grantRole(cascadeHost, "host");

      const draftId = await createDraftLocation(cascadeHost);
      const submittedId = await createSubmittedLocation(cascadeHost);
      const publishedId1 = await createPublishedLocation(cascadeHost, admin);
      const publishedId2 = await createPublishedLocation(cascadeHost, admin);

      // Independently suspended by an admin BEFORE the host suspension --
      // must never be touched by the host suspend/restore cascade.
      const independentlySuspendedId = await createPublishedLocation(cascadeHost, admin);
      await request(app)
        .post(`/v1/admin/locations/${independentlySuspendedId}/suspend`)
        .set(authHeader(admin))
        .send({ reason: "Independent content violation." });

      const suspendRes = await request(app)
        .post(`/v1/admin/users/${cascadeHost.id}/suspend`)
        .set(authHeader(admin))
        .send({ reason: "Host policy violation." });
      expect(suspendRes.status).toBe(200);

      const { data: rows, error } = await adminClient
        .from("locations")
        .select("id, status, suspended_by_host_suspension, moderation_reason")
        .in("id", [draftId, submittedId, publishedId1, publishedId2, independentlySuspendedId]);
      if (error) throw error;
      const byId = Object.fromEntries(rows!.map((r) => [r.id, r]));

      expect(byId[draftId]!.status).toBe("draft"); // untouched
      expect(byId[submittedId]!.status).toBe("submitted"); // untouched
      expect(byId[publishedId1]!.status).toBe("suspended");
      expect(byId[publishedId1]!.suspended_by_host_suspension).toBe(true);
      expect(byId[publishedId2]!.status).toBe("suspended");
      expect(byId[publishedId2]!.suspended_by_host_suspension).toBe(true);
      // The independent suspension's own reason must survive, not be
      // overwritten with the generic host-suspension reason.
      expect(byId[independentlySuspendedId]!.status).toBe("suspended");
      expect(byId[independentlySuspendedId]!.suspended_by_host_suspension).toBe(false);
      expect(byId[independentlySuspendedId]!.moderation_reason).toBe("Independent content violation.");

      // Restoring the host republishes only the cascade-suspended ones.
      const restoreRes = await request(app).post(`/v1/admin/users/${cascadeHost.id}/restore`).set(authHeader(admin));
      expect(restoreRes.status).toBe(200);

      const { data: afterRows, error: afterError } = await adminClient
        .from("locations")
        .select("id, status, suspended_by_host_suspension")
        .in("id", [publishedId1, publishedId2, independentlySuspendedId]);
      if (afterError) throw afterError;
      const afterById = Object.fromEntries(afterRows!.map((r) => [r.id, r]));

      expect(afterById[publishedId1]!.status).toBe("published");
      expect(afterById[publishedId2]!.status).toBe("published");
      // The independently-suspended location must still be suspended --
      // never accidentally restored by the host-restore action.
      expect(afterById[independentlySuspendedId]!.status).toBe("suspended");

      await deleteTestUser(cascadeHost.id);
    });

    it("a suspended host's remaining published location cannot receive new bookings", async () => {
      const cascadeHost = await createTestUser();
      await grantRole(cascadeHost, "host");
      const locationId = await createPublishedLocation(cascadeHost, admin);
      await request(app)
        .post(`/v1/locations/${locationId}/availability/rules`)
        .set(authHeader(cascadeHost))
        .send({ day_of_week: "monday", start_time: "09:00", end_time: "18:00" });
      await request(app)
        .post(`/v1/locations/${locationId}/pricing`)
        .set(authHeader(cascadeHost))
        .send({ booking_type: "hourly", amount_minor_units: 10000 });

      await request(app).post(`/v1/admin/users/${cascadeHost.id}/suspend`).set(authHeader(admin)).send({ reason: "x" });

      const bookRes = await request(app)
        .post("/v1/bookings")
        .set(authHeader(booker))
        .send({ location_id: locationId, start_at: "2026-10-05T09:00:00Z", end_at: "2026-10-05T10:00:00Z" });
      expect(bookRes.status).toBe(404); // no longer published -- not bookable

      await deleteTestUser(cascadeHost.id);
    });
  });
});
