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

describe("admin: users", () => {
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
    it("rejects an unauthenticated caller from every admin user endpoint", async () => {
      const list = await request(app).get("/v1/admin/users");
      expect(list.status).toBe(401);
      const detail = await request(app).get(`/v1/admin/users/${booker.id}`);
      expect(detail.status).toBe(401);
    });

    it("rejects a booker and a host from every admin user endpoint (403)", async () => {
      for (const nonAdmin of [booker, host]) {
        const list = await request(app).get("/v1/admin/users").set(authHeader(nonAdmin));
        expect(list.status).toBe(403);
        const detail = await request(app).get(`/v1/admin/users/${booker.id}`).set(authHeader(nonAdmin));
        expect(detail.status).toBe(403);
        const suspend = await request(app)
          .post(`/v1/admin/users/${booker.id}/suspend`)
          .set(authHeader(nonAdmin))
          .send({ reason: "test" });
        expect(suspend.status).toBe(403);
      }
    });

    it("lets an admin access every admin user endpoint", async () => {
      const list = await request(app).get("/v1/admin/users").set(authHeader(admin));
      expect(list.status).toBe(200);
      const detail = await request(app).get(`/v1/admin/users/${booker.id}`).set(authHeader(admin));
      expect(detail.status).toBe(200);
    });
  });

  describe("listing, search, filtering", () => {
    it("lists users with roles flattened in", async () => {
      const res = await request(app).get("/v1/admin/users").set(authHeader(admin)).query({ pageSize: 100 });
      expect(res.status).toBe(200);
      const found = res.body.data.find((u: { id: string }) => u.id === host.id);
      expect(found).toBeDefined();
      expect(found.roles).toContain("host");
    });

    it("filters by role", async () => {
      const res = await request(app).get("/v1/admin/users").set(authHeader(admin)).query({ role: "host", pageSize: 100 });
      const ids = res.body.data.map((u: { id: string }) => u.id);
      expect(ids).toContain(host.id);
      expect(ids).not.toContain(booker.id);
    });

    it("filters by status", async () => {
      const res = await request(app).get("/v1/admin/users").set(authHeader(admin)).query({ status: "active", pageSize: 100 });
      const ids = res.body.data.map((u: { id: string }) => u.id);
      expect(ids).toContain(booker.id);
    });

    it("searches by name", async () => {
      await request(app).patch("/v1/me").set(authHeader(host)).send({ first_name: "Zzyzx", last_name: "Findme" });
      const res = await request(app).get("/v1/admin/users").set(authHeader(admin)).query({ search: "Zzyzx" });
      expect(res.body.data.map((u: { id: string }) => u.id)).toContain(host.id);
    });
  });

  describe("user detail", () => {
    it("includes profile, roles, and email (via the Admin Auth API), but never secrets", async () => {
      const res = await request(app).get(`/v1/admin/users/${booker.id}`).set(authHeader(admin));
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(booker.id);
      expect(res.body.data.roles).toContain("booker");
      expect(res.body.data.email).toBe(booker.email);
      expect(typeof res.body.data.bookings_count).toBe("number");
      expect(typeof res.body.data.locations_count).toBe("number");
      const serialized = JSON.stringify(res.body);
      expect(serialized.toLowerCase()).not.toContain("password");
      expect(serialized).not.toContain("access_token");
      expect(serialized).not.toContain("refresh_token");
    });

    it("404s for a nonexistent user", async () => {
      const res = await request(app)
        .get("/v1/admin/users/00000000-0000-0000-0000-000000000000")
        .set(authHeader(admin));
      expect(res.status).toBe(404);
    });
  });

  describe("suspend / restore", () => {
    it("requires a reason to suspend", async () => {
      const target = await createTestUser();
      const res = await request(app).post(`/v1/admin/users/${target.id}/suspend`).set(authHeader(admin)).send({});
      expect(res.status).toBe(400);
      await deleteTestUser(target.id);
    });

    it("suspends a user, blocking their own future authenticated requests", async () => {
      const target = await createTestUser();
      await grantRole(target, "booker");

      const before = await request(app).get("/v1/me").set(authHeader(target));
      expect(before.status).toBe(200);

      const suspend = await request(app)
        .post(`/v1/admin/users/${target.id}/suspend`)
        .set(authHeader(admin))
        .send({ reason: "policy violation" });
      expect(suspend.status).toBe(200);
      expect(suspend.body.data.status).toBe("suspended");

      const after = await request(app).get("/v1/me").set(authHeader(target));
      expect(after.status).toBe(403);

      await deleteTestUser(target.id);
    });

    it("rejects suspending an already-suspended user", async () => {
      const target = await createTestUser();
      await request(app).post(`/v1/admin/users/${target.id}/suspend`).set(authHeader(admin)).send({ reason: "x" });
      const again = await request(app).post(`/v1/admin/users/${target.id}/suspend`).set(authHeader(admin)).send({ reason: "x" });
      expect(again.status).toBe(400);
      await deleteTestUser(target.id);
    });

    it("restores a suspended user, re-enabling authenticated requests", async () => {
      const target = await createTestUser();
      await grantRole(target, "booker");
      await request(app).post(`/v1/admin/users/${target.id}/suspend`).set(authHeader(admin)).send({ reason: "x" });

      const restore = await request(app).post(`/v1/admin/users/${target.id}/restore`).set(authHeader(admin));
      expect(restore.status).toBe(200);
      expect(restore.body.data.status).toBe("active");

      const after = await request(app).get("/v1/me").set(authHeader(target));
      expect(after.status).toBe(200);

      await deleteTestUser(target.id);
    });

    it("rejects restoring a user who isn't suspended", async () => {
      const target = await createTestUser();
      const res = await request(app).post(`/v1/admin/users/${target.id}/restore`).set(authHeader(admin));
      expect(res.status).toBe(400);
      await deleteTestUser(target.id);
    });
  });
});
