import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { createTestUser, deleteTestUser, TestUser } from "./setup";

const app = createApp();

describe("role assignment", () => {
  let user: TestUser;

  beforeAll(async () => {
    user = await createTestUser();
  });

  afterAll(async () => {
    await deleteTestUser(user.id);
  });

  it("rejects an unrecognized role string", async () => {
    const res = await request(app)
      .post("/v1/me/roles")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ role: "superadmin" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("self-assigns the booker role", async () => {
    const res = await request(app)
      .post("/v1/me/roles")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ role: "booker" });

    expect(res.status).toBe(201);
    expect(res.body.data.roles).toEqual(["booker"]);
  });

  it("rejects re-assigning a role already held", async () => {
    const res = await request(app)
      .post("/v1/me/roles")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ role: "booker" });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CONFLICT");
  });

  it("lets the same account also hold the host role at the same time", async () => {
    const res = await request(app)
      .post("/v1/me/roles")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ role: "host" });

    expect(res.status).toBe(201);
    expect(res.body.data.roles.sort()).toEqual(["booker", "host"]);
  });

  it("refuses to self-assign the admin role", async () => {
    const res = await request(app)
      .post("/v1/me/roles")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ role: "admin" });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("removes one role while leaving the other intact", async () => {
    const res = await request(app)
      .delete("/v1/me/roles/booker")
      .set("Authorization", `Bearer ${user.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.roles).toEqual(["host"]);
  });

  it("404s when removing a role the user doesn't hold", async () => {
    const res = await request(app)
      .delete("/v1/me/roles/booker")
      .set("Authorization", `Bearer ${user.accessToken}`);

    expect(res.status).toBe(404);
  });

  it("refuses to remove the admin role via self-service", async () => {
    const res = await request(app)
      .delete("/v1/me/roles/admin")
      .set("Authorization", `Bearer ${user.accessToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });
});
