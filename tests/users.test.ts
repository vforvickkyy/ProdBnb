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

  // ==========================================================================
  // Phase 26-MB — profile contact details (phone + postal address)
  // ==========================================================================

  describe("contact details (Phase 26-MB)", () => {
    let userC: TestUser;

    beforeAll(async () => {
      userC = await createTestUser();
    });

    afterAll(async () => {
      await deleteTestUser(userC.id);
    });

    it("returns null phone and address for a profile that never supplied them", async () => {
      const res = await request(app).get("/v1/me").set("Authorization", `Bearer ${userC.accessToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.profile.phone).toBeNull();
      expect(res.body.data.profile.address_line1).toBeNull();
      expect(res.body.data.profile.address_line2).toBeNull();
      expect(res.body.data.profile.address_city).toBeNull();
      expect(res.body.data.profile.address_region).toBeNull();
      expect(res.body.data.profile.address_country).toBeNull();
      expect(res.body.data.profile.address_postal_code).toBeNull();
    });

    it("still does not expose an email column on the profile", async () => {
      // email lives in auth.users and is sourced from the session — 26-MB did
      // not duplicate it here.
      const res = await request(app).get("/v1/me").set("Authorization", `Bearer ${userC.accessToken}`);

      expect(res.body.data.profile).not.toHaveProperty("email");
    });

    it("saves a phone number exactly as entered, without normalising it", async () => {
      const res = await request(app)
        .patch("/v1/me")
        .set("Authorization", `Bearer ${userC.accessToken}`)
        .send({ phone: "+91 98765 43210" });

      expect(res.status).toBe(200);
      expect(res.body.data.profile.phone).toBe("+91 98765 43210");
    });

    it("saves an address", async () => {
      const res = await request(app)
        .patch("/v1/me")
        .set("Authorization", `Bearer ${userC.accessToken}`)
        .send({
          address_line1: "12 Hill Road",
          address_line2: "Flat 4",
          address_city: "Mumbai",
          address_region: "Maharashtra",
          address_country: "India",
          address_postal_code: "400050",
        });

      expect(res.status).toBe(200);
      expect(res.body.data.profile).toMatchObject({
        address_line1: "12 Hill Road",
        address_line2: "Flat 4",
        address_city: "Mumbai",
        address_region: "Maharashtra",
        address_country: "India",
        address_postal_code: "400050",
      });
    });

    it("updates a previously saved phone and address", async () => {
      const res = await request(app)
        .patch("/v1/me")
        .set("Authorization", `Bearer ${userC.accessToken}`)
        .send({ phone: "+44 20 7946 0000", address_city: "London" });

      expect(res.status).toBe(200);
      expect(res.body.data.profile.phone).toBe("+44 20 7946 0000");
      expect(res.body.data.profile.address_city).toBe("London");
      // Untouched parts survive a partial update.
      expect(res.body.data.profile.address_line1).toBe("12 Hill Road");
    });

    it("clears phone and an address part with an explicit null", async () => {
      const res = await request(app)
        .patch("/v1/me")
        .set("Authorization", `Bearer ${userC.accessToken}`)
        .send({ phone: null, address_line2: null });

      expect(res.status).toBe(200);
      expect(res.body.data.profile.phone).toBeNull();
      expect(res.body.data.profile.address_line2).toBeNull();
      expect(res.body.data.profile.address_city).toBe("London");
    });

    it("accepts international phone formats", async () => {
      for (const phone of ["+14155552671", "020 7946 0000", "+81-3-1234-5678", "(555) 123-4567"]) {
        const res = await request(app)
          .patch("/v1/me")
          .set("Authorization", `Bearer ${userC.accessToken}`)
          .send({ phone });

        expect(res.status, `expected ${phone} to be accepted`).toBe(200);
        expect(res.body.data.profile.phone).toBe(phone);
      }
    });

    it("rejects a malformed phone number", async () => {
      for (const phone of ["not-a-phone", "", "abc123", "+"]) {
        const res = await request(app)
          .patch("/v1/me")
          .set("Authorization", `Bearer ${userC.accessToken}`)
          .send({ phone });

        expect(res.status, `expected ${JSON.stringify(phone)} to be rejected`).toBe(400);
        expect(res.body.error.code).toBe("VALIDATION_ERROR");
      }
    });

    it("rejects an empty-string address part rather than treating it as a clear", async () => {
      const res = await request(app)
        .patch("/v1/me")
        .set("Authorization", `Bearer ${userC.accessToken}`)
        .send({ address_city: "" });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects an over-long address part", async () => {
      const res = await request(app)
        .patch("/v1/me")
        .set("Authorization", `Bearer ${userC.accessToken}`)
        .send({ address_postal_code: "x".repeat(21) });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("still rejects unknown profile fields — the schema remains strict", async () => {
      for (const body of [{ address: "12 Hill Road" }, { phone_number: "123456" }, { city: "Mumbai" }]) {
        const res = await request(app)
          .patch("/v1/me")
          .set("Authorization", `Bearer ${userC.accessToken}`)
          .send(body);

        expect(res.status, `expected ${JSON.stringify(body)} to be rejected`).toBe(400);
        expect(res.body.error.code).toBe("VALIDATION_ERROR");
      }
    });

    it("keeps the pre-26-MB fields working unchanged", async () => {
      const res = await request(app)
        .patch("/v1/me")
        .set("Authorization", `Bearer ${userC.accessToken}`)
        .send({ first_name: "Ada", last_name: "Lovelace", avatar_url: "https://example.com/a.jpg" });

      expect(res.status).toBe(200);
      expect(res.body.data.profile.first_name).toBe("Ada");
      expect(res.body.data.profile.last_name).toBe("Lovelace");
      expect(res.body.data.profile.avatar_url).toBe("https://example.com/a.jpg");
    });

    it("accepts a name-only update from a client that knows nothing about phone/address", async () => {
      // Backward compatibility: an existing client must keep working untouched.
      const res = await request(app)
        .patch("/v1/me")
        .set("Authorization", `Bearer ${userC.accessToken}`)
        .send({ first_name: "Grace", last_name: "Hopper" });

      expect(res.status).toBe(200);
      expect(res.body.data.profile.first_name).toBe("Grace");
    });

    it("rejects an unauthenticated contact-details update", async () => {
      const res = await request(app).patch("/v1/me").send({ phone: "+14155552671" });

      expect(res.status).toBe(401);
    });

    it("does not let one user write another user's contact details (RLS + column grants)", async () => {
      const bClient = createUserScopedClient(userB.accessToken);

      const { data, error } = await bClient
        .from("profiles")
        .update({ phone: "+10000000000", address_city: "Hijacked" })
        .eq("id", userC.id)
        .select();

      expect(error).toBeNull();
      expect(data).toEqual([]);

      const check = await request(app).get("/v1/me").set("Authorization", `Bearer ${userC.accessToken}`);
      expect(check.body.data.profile.address_city).not.toBe("Hijacked");
    });

    it("still cannot change status through the profile endpoint now that more columns are writable", async () => {
      const res = await request(app)
        .patch("/v1/me")
        .set("Authorization", `Bearer ${userC.accessToken}`)
        .send({ phone: "+14155552671", status: "suspended" });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });
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
