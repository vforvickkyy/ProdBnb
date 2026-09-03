import { createClient } from "@supabase/supabase-js";
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

describe("admin: audit log", () => {
  let admin: TestUser;
  let booker: TestUser;
  let host: TestUser;
  let targetUserId: string;

  beforeAll(async () => {
    admin = await createTestUser();
    booker = await createTestUser();
    host = await createTestUser();
    await grantAdmin(admin);
    await grantRole(booker, "booker");
    await grantRole(host, "host");

    const target = await createTestUser();
    targetUserId = target.id;
    await request(app).post(`/v1/admin/users/${targetUserId}/suspend`).set(authHeader(admin)).send({ reason: "audit log test" });
  });

  afterAll(async () => {
    await deleteTestUser(admin.id);
    await deleteTestUser(booker.id);
    await deleteTestUser(host.id);
    await deleteTestUser(targetUserId);
  });

  it("rejects booker/host, admin succeeds", async () => {
    for (const nonAdmin of [booker, host]) {
      const res = await request(app).get("/v1/admin/audit-log").set(authHeader(nonAdmin));
      expect(res.status).toBe(403);
    }
    const res = await request(app).get("/v1/admin/audit-log").set(authHeader(admin));
    expect(res.status).toBe(200);
  });

  it("filters by target_type/target_id/admin_id", async () => {
    const res = await request(app)
      .get("/v1/admin/audit-log")
      .set(authHeader(admin))
      .query({ target_type: "user", target_id: targetUserId, admin_id: admin.id });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    const entry = res.body.data[0];
    expect(entry.action).toBe("ADMIN_SUSPENDED_USER");
    expect(entry.admin_id).toBe(admin.id);
    expect(entry.target_type).toBe("user");
    expect(entry.target_id).toBe(targetUserId);
    expect(entry.reason).toBe("audit log test");
    expect(entry.created_at).toBeTruthy();
  });

  it("cannot be spoofed or edited by any admin -- no client-writable path exists at all", async () => {
    // Even using an authenticated ADMIN's own bearer token directly against
    // PostgREST (bypassing this backend's controllers entirely, simulating
    // a malicious/compromised frontend), there is no INSERT/UPDATE/DELETE
    // grant on admin_audit_log for `authenticated` -- only service_role can
    // write it, and only this backend's own writeAuditLog() ever does.
    const adminScopedClient = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${admin.accessToken}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const fakeInsert = await adminScopedClient
      .from("admin_audit_log")
      .insert({ admin_id: admin.id, action: "ADMIN_APPROVED_LOCATION", target_type: "location", target_id: booker.id });
    expect(fakeInsert.error).toBeTruthy();

    const { data: real } = await adminClient
      .from("admin_audit_log")
      .select("id")
      .eq("target_type", "user")
      .eq("target_id", targetUserId)
      .single();

    const fakeUpdate = await adminScopedClient.from("admin_audit_log").update({ reason: "tampered" }).eq("id", real!.id);
    expect(fakeUpdate.error).toBeTruthy();

    const fakeDelete = await adminScopedClient.from("admin_audit_log").delete().eq("id", real!.id);
    expect(fakeDelete.error).toBeTruthy();

    // Confirm the row is genuinely untouched.
    const { data: unchanged, error } = await adminClient.from("admin_audit_log").select("reason").eq("id", real!.id).single();
    if (error) throw error;
    expect(unchanged.reason).toBe("audit log test");
  });

  it("rejects an unauthenticated caller", async () => {
    const res = await request(app).get("/v1/admin/audit-log");
    expect(res.status).toBe(401);
  });
});
