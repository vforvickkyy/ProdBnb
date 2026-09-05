import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "../src/config/env";
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

describe("admin: system status", () => {
  let admin: TestUser;
  let booker: TestUser;

  beforeAll(async () => {
    admin = await createTestUser();
    booker = await createTestUser();
    await grantAdmin(admin);
    await grantRole(booker, "booker");
  });

  afterAll(async () => {
    await deleteTestUser(admin.id);
    await deleteTestUser(booker.id);
  });

  it("rejects a non-admin and an unauthenticated caller", async () => {
    const noAuth = await request(app).get("/v1/admin/system/status");
    expect(noAuth.status).toBe(401);

    const nonAdmin = await request(app).get("/v1/admin/system/status").set(authHeader(booker));
    expect(nonAdmin.status).toBe(403);
  });

  it("reports config state sourced from validated env, with no secret ever present", async () => {
    const res = await request(app).get("/v1/admin/system/status").set(authHeader(admin));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      environment: env.NODE_ENV,
      payments: { provider: env.PAYMENT_PROVIDER, mode: env.CASHFREE_ENV },
      notifications: { provider: env.NOTIFICATION_PROVIDER },
      media: { configured: true },
    });

    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain(env.CASHFREE_SECRET_KEY);
    expect(serialized).not.toContain(env.R2_SECRET_ACCESS_KEY);
    expect(serialized).not.toContain(env.SUPABASE_SERVICE_ROLE_KEY);
    expect(serialized).not.toContain(env.R2_ACCESS_KEY_ID);
  });
});
