import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { createTestUser, deleteTestUser, TestUser } from "./setup";

const app = createApp();

function authHeader(user: TestUser): { Authorization: string } {
  return { Authorization: `Bearer ${user.accessToken}` };
}

describe("devices", () => {
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

  it("rejects an unauthenticated registration", async () => {
    const res = await request(app).post("/v1/devices").send({ device_token: "tok-unauth", platform: "ios" });
    expect(res.status).toBe(401);
  });

  it("registers a new device for the caller, never echoing the raw token back", async () => {
    const res = await request(app)
      .post("/v1/devices")
      .set(authHeader(userA))
      .send({ device_token: "tok-device-1", platform: "ios", environment: "sandbox" });
    expect(res.status).toBe(201);
    expect(res.body.data.platform).toBe("ios");
    expect(res.body.data.environment).toBe("sandbox");
    expect(res.body.data.is_active).toBe(true);
    expect(res.body.data.user_id).toBe(userA.id);
    expect(JSON.stringify(res.body)).not.toContain("tok-device-1");
  });

  it("rejects an invalid platform value", async () => {
    const res = await request(app).post("/v1/devices").set(authHeader(userA)).send({ device_token: "tok-bad", platform: "windows" });
    expect(res.status).toBe(400);
  });

  it("re-registering the same token for the same user just refreshes it (no duplicate row)", async () => {
    const first = await request(app)
      .post("/v1/devices")
      .set(authHeader(userA))
      .send({ device_token: "tok-device-2", platform: "ios" });
    const second = await request(app)
      .post("/v1/devices")
      .set(authHeader(userA))
      .send({ device_token: "tok-device-2", platform: "ios" });
    expect(second.status).toBe(201);
    expect(second.body.data.id).toBe(first.body.data.id);

    const list = await request(app).get("/v1/devices").set(authHeader(userA));
    expect(list.body.data.filter((d: { id: string }) => d.id === first.body.data.id)).toHaveLength(1);
  });

  it("lists only the caller's own devices", async () => {
    await request(app).post("/v1/devices").set(authHeader(userB)).send({ device_token: "tok-userB-1", platform: "android" });

    const listA = await request(app).get("/v1/devices").set(authHeader(userA));
    expect(listA.status).toBe(200);
    expect(listA.body.data.every((d: { user_id: string }) => d.user_id === userA.id)).toBe(true);

    const listB = await request(app).get("/v1/devices").set(authHeader(userB));
    expect(listB.body.data.some((d: { user_id: string }) => d.user_id === userA.id)).toBe(false);
  });

  it("registering an existing token under a DIFFERENT user reassigns it (shared-device / re-login case)", async () => {
    const registered = await request(app)
      .post("/v1/devices")
      .set(authHeader(userA))
      .send({ device_token: "tok-shared-device", platform: "ios" });
    expect(registered.body.data.user_id).toBe(userA.id);

    const reassigned = await request(app)
      .post("/v1/devices")
      .set(authHeader(userB))
      .send({ device_token: "tok-shared-device", platform: "ios" });
    expect(reassigned.status).toBe(201);
    expect(reassigned.body.data.id).toBe(registered.body.data.id); // same row, reassigned
    expect(reassigned.body.data.user_id).toBe(userB.id);
    expect(reassigned.body.data.is_active).toBe(true);

    const listA = await request(app).get("/v1/devices").set(authHeader(userA));
    expect(listA.body.data.map((d: { id: string }) => d.id)).not.toContain(registered.body.data.id);

    const listB = await request(app).get("/v1/devices").set(authHeader(userB));
    expect(listB.body.data.map((d: { id: string }) => d.id)).toContain(registered.body.data.id);
  });

  it("soft-deletes a device (is_active: false, still listed for history)", async () => {
    const registered = await request(app)
      .post("/v1/devices")
      .set(authHeader(userA))
      .send({ device_token: "tok-to-remove", platform: "ios" });
    const deviceId = registered.body.data.id;

    const del = await request(app).delete(`/v1/devices/${deviceId}`).set(authHeader(userA));
    expect(del.status).toBe(200);
    expect(del.body.data.deleted).toBe(true);

    const list = await request(app).get("/v1/devices").set(authHeader(userA));
    const found = list.body.data.find((d: { id: string }) => d.id === deviceId);
    expect(found).toBeDefined();
    expect(found.is_active).toBe(false);
  });

  it("404s when trying to remove another user's device", async () => {
    const registered = await request(app)
      .post("/v1/devices")
      .set(authHeader(userA))
      .send({ device_token: "tok-not-yours", platform: "ios" });

    const res = await request(app).delete(`/v1/devices/${registered.body.data.id}`).set(authHeader(userB));
    expect(res.status).toBe(404);
  });
});
