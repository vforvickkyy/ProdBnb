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

describe("admin: dashboard", () => {
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

  it("rejects a non-admin, admin succeeds with a well-shaped summary", async () => {
    const denied = await request(app).get("/v1/admin/dashboard").set(authHeader(booker));
    expect(denied.status).toBe(403);

    const res = await request(app).get("/v1/admin/dashboard").set(authHeader(admin));
    expect(res.status).toBe(200);

    const data = res.body.data;
    expect(typeof data.total_users).toBe("number");
    expect(typeof data.active_hosts).toBe("number");
    expect(typeof data.published_locations).toBe("number");
    expect(typeof data.locations_awaiting_approval).toBe("number");
    expect(typeof data.upcoming_bookings).toBe("number");
    expect(Array.isArray(data.recent_bookings)).toBe(true);
    expect(typeof data.payment_activity_30d.count).toBe("number");
    expect(typeof data.payment_activity_30d.total_amount_minor_units).toBe("number");
    expect(typeof data.refund_activity_30d.count).toBe("number");
    expect(Array.isArray(data.recent_admin_actions)).toBe(true);
  });

  it("rejects an unauthenticated caller", async () => {
    const res = await request(app).get("/v1/admin/dashboard");
    expect(res.status).toBe(401);
  });

  it("reflects a real admin action in recent_admin_actions", async () => {
    const target = await createTestUser();
    await request(app).post(`/v1/admin/users/${target.id}/suspend`).set(authHeader(admin)).send({ reason: "dashboard test" });

    const res = await request(app).get("/v1/admin/dashboard").set(authHeader(admin));
    expect(res.body.data.recent_admin_actions.some((a: { action: string }) => a.action === "ADMIN_SUSPENDED_USER")).toBe(true);

    await deleteTestUser(target.id);
  });
});
