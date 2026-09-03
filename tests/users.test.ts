import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { createUserScopedClient } from "../src/lib/supabase";
import { createTestUser, deleteTestUser, grantAdminRole, TestUser } from "./setup";

const app = createApp();

describe("user profiles", () => {
  let userA: TestUser;
  let userB: TestUser;

  beforeAll(async () => {
    userA = await createTestUser();
    userB = await createTestUser();
  });

  afterAll(async () => {
    await deleteTestUser(userA.id);
    await deleteTestUser(userB.id);
  });

  it("auto-creates a profile for a new auth user, with no roles yet", async () => {
    const res = await request(app).get("/v1/me").set("Authorization", `Bearer ${userA.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.profile.id).toBe(userA.id);
    expect(res.body.data.profile.status).toBe("active");
    expect(res.body.data.roles).toEqual([]);
  });

  it("updates allowed profile fields", async () => {
    const res = await request(app)
      .patch("/v1/me")
      .set("Authorization", `Bearer ${userA.accessToken}`)
      .send({ first_name: "Alex", last_name: "Producer" });

    expect(res.status).toBe(200);
    expect(res.body.data.profile.first_name).toBe("Alex");
    expect(res.body.data.profile.last_name).toBe("Producer");
  });

  it("rejects an update with no recognized fields", async () => {
    const res = await request(app).patch("/v1/me").set("Authorization", `Bearer ${userA.accessToken}`).send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects attempts to change account status through the profile update endpoint", async () => {
    const res = await request(app)
      .patch("/v1/me")
      .set("Authorization", `Bearer ${userA.accessToken}`)
      .send({ status: "suspended" });

    // `status` isn't a recognized field on this schema (.strict()), so this
    // fails validation before it ever reaches the database — a self-escalation
    // attempt never gets the chance to rely on the column-level grants either.
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("does not let one user read another user's profile row (RLS)", async () => {
    const bClient = createUserScopedClient(userB.accessToken);

    const { data, error } = await bClient.from("profiles").select("id").eq("id", userA.id);

    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("does not let one user update another user's profile row (RLS)", async () => {
    const bClient = createUserScopedClient(userB.accessToken);

    const { data, error } = await bClient
      .from("profiles")
      .update({ first_name: "Hijacked" })
      .eq("id", userA.id)
      .select();

    expect(error).toBeNull();
    expect(data).toEqual([]);

    const check = await request(app).get("/v1/me").set("Authorization", `Bearer ${userA.accessToken}`);
    expect(check.body.data.profile.first_name).not.toBe("Hijacked");
  });

  describe("admin listing", () => {
    it("forbids a non-admin from listing all profiles", async () => {
      const res = await request(app).get("/v1/admin/users").set("Authorization", `Bearer ${userA.accessToken}`);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("FORBIDDEN");
    });

    it("lets an admin list all profiles, including other users'", async () => {
      await grantAdminRole(userB.id);

      const res = await request(app)
        .get("/v1/admin/users")
        .set("Authorization", `Bearer ${userB.accessToken}`)
        .query({ page: 1, pageSize: 50 });

      expect(res.status).toBe(200);
      expect(res.body.meta).toMatchObject({ page: 1, pageSize: 50 });
      const ids = res.body.data.map((profile: { id: string }) => profile.id);
      expect(ids).toContain(userA.id);
      expect(ids).toContain(userB.id);
    });
  });
});
