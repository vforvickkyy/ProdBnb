import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { createUserScopedClient } from "../src/lib/supabase";
import { adminClient, createTestUser, deleteTestUser, TestUser } from "./setup";

// Phase 12: closes a gap that `bookings`/`locations`/`location_media` all
// shared -- RLS checked row ownership only, never which columns a write
// could touch. These tests prove the fix directly at the level it matters:
// a real Supabase session, talking to PostgREST, bypassing this backend's
// Express app entirely -- not just "the API rejects it" (that was already
// true), but "the database itself refuses the query" (it previously did
// not), matching this project's own stated authorization principle.

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

async function publish(locationId: string): Promise<void> {
  const { error } = await adminClient.from("locations").update({ status: "published" }).eq("id", locationId);
  if (error) throw error;
}

async function addRule(locationId: string, owner: TestUser, day: string, start: string, end: string): Promise<void> {
  const res = await request(app)
    .post(`/v1/locations/${locationId}/availability/rules`)
    .set(authHeader(owner))
    .send({ day_of_week: day, start_time: start, end_time: end });
  expect(res.status).toBe(201);
}

async function addHourlyPricing(locationId: string, owner: TestUser, amount = 10_000): Promise<void> {
  const res = await request(app)
    .post(`/v1/locations/${locationId}/pricing`)
    .set(authHeader(owner))
    .send({ booking_type: "hourly", amount_minor_units: amount });
  expect(res.status).toBe(201);
}

const MON = "2026-10-05"; // a Monday

async function createLocation(owner: TestUser): Promise<string> {
  const res = await request(app)
    .post("/v1/locations")
    .set(authHeader(owner))
    .send({ title: "Hardening Test Location", city: "London", country: "UK", timezone: "UTC" });
  expect(res.status).toBe(201);
  return res.body.data.id as string;
}

async function createBookableLocation(owner: TestUser): Promise<string> {
  const locationId = await createLocation(owner);
  await addRule(locationId, owner, "monday", "09:00", "18:00");
  await addHourlyPricing(locationId, owner);
  await publish(locationId);
  return locationId;
}

describe("Phase 12 hardening: bookings/locations/location_media are no longer directly writable", () => {
  let host: TestUser;
  let booker: TestUser;
  let admin: TestUser;
  let locationId: string;
  let bookingId: string;

  beforeAll(async () => {
    host = await createTestUser();
    booker = await createTestUser();
    admin = await createTestUser();
    await grantRole(host, "host");
    await grantRole(booker, "booker");
    await grantAdmin(admin);

    locationId = await createBookableLocation(host);

    const res = await request(app)
      .post("/v1/bookings")
      .set(authHeader(booker))
      .send({ location_id: locationId, booking_type: "hourly", start_at: `${MON}T10:00:00Z`, end_at: `${MON}T12:00:00Z` });
    expect(res.status).toBe(201);
    bookingId = res.body.data.id as string;
  });

  afterAll(async () => {
    await deleteTestUser(host.id);
    await deleteTestUser(booker.id);
    await deleteTestUser(admin.id);
  });

  it("a booker cannot rewrite their own booking's price via direct PostgREST", async () => {
    const bookerClient = createUserScopedClient(booker.accessToken);
    const { error } = await bookerClient
      .from("bookings")
      .update({ total_amount_minor_units: 1, base_amount_minor_units: 1 })
      .eq("id", bookingId);
    expect(error).toBeTruthy();
    expect(error!.code).toBe("42501");

    const { data: unchanged } = await adminClient
      .from("bookings")
      .select("total_amount_minor_units, base_amount_minor_units")
      .eq("id", bookingId)
      .single();
    expect(unchanged!.total_amount_minor_units).toBe(20_000); // 2 hours * 10,000
    expect(unchanged!.base_amount_minor_units).toBe(20_000);
  });

  it("a booker cannot self-confirm their own requested booking via direct PostgREST", async () => {
    const bookerClient = createUserScopedClient(booker.accessToken);
    const { error } = await bookerClient.from("bookings").update({ status: "confirmed" }).eq("id", bookingId);
    expect(error).toBeTruthy();
    expect(error!.code).toBe("42501");

    const { data: unchanged } = await adminClient.from("bookings").select("status").eq("id", bookingId).single();
    expect(unchanged!.status).toBe("requested");
  });

  it("a booker cannot fabricate a completed booking via direct PostgREST insert", async () => {
    const bookerClient = createUserScopedClient(booker.accessToken);
    const { error } = await bookerClient.from("bookings").insert({
      location_id: locationId,
      booker_id: booker.id,
      booking_type: "hourly",
      start_at: `${MON}T14:00:00Z`,
      end_at: `${MON}T15:00:00Z`,
      status: "completed",
      base_amount_minor_units: 1,
      total_amount_minor_units: 1,
      currency: "INR",
    });
    expect(error).toBeTruthy();
    expect(error!.code).toBe("42501");
  });

  it("a host cannot self-publish a draft location via direct PostgREST", async () => {
    const draftId = await createLocation(host);
    const hostClient = createUserScopedClient(host.accessToken);
    const { error } = await hostClient.from("locations").update({ status: "published" }).eq("id", draftId);
    expect(error).toBeTruthy();
    expect(error!.code).toBe("42501");

    const { data: unchanged } = await adminClient.from("locations").select("status").eq("id", draftId).single();
    expect(unchanged!.status).toBe("draft");
  });

  it("even an admin's own scoped client cannot write location status directly -- only the service-role-backed moderation endpoints can", async () => {
    const draftId = await createLocation(host);
    const adminScopedClient = createUserScopedClient(admin.accessToken);
    const { error } = await adminScopedClient.from("locations").update({ status: "published" }).eq("id", draftId);
    expect(error).toBeTruthy();
    expect(error!.code).toBe("42501");
  });

  it("a host cannot fabricate a location_media row pointing at an arbitrary storage_key via direct PostgREST", async () => {
    const hostClient = createUserScopedClient(host.accessToken);
    const { error } = await hostClient
      .from("location_media")
      .insert({ location_id: locationId, media_type: "photo", storage_key: "locations/someone-elses-location/x/original", position: 0 });
    expect(error).toBeTruthy();
    expect(error!.code).toBe("42501");
  });

  it("a host may still edit ordinary content fields on their own location directly through the app (unaffected by the lockdown)", async () => {
    const res = await request(app).patch(`/v1/locations/${locationId}`).set(authHeader(host)).send({ description: "Updated via the app." });
    expect(res.status).toBe(200);
    expect(res.body.data.description).toBe("Updated via the app.");
  });
});

describe("Phase 12 hardening: transitionBooking compare-and-swap", () => {
  let host: TestUser;
  let booker: TestUser;
  let locationId: string;
  let bookingId: string;

  beforeAll(async () => {
    host = await createTestUser();
    booker = await createTestUser();
    await grantRole(host, "host");
    await grantRole(booker, "booker");
    locationId = await createBookableLocation(host);

    const res = await request(app)
      .post("/v1/bookings")
      .set(authHeader(booker))
      .send({ location_id: locationId, booking_type: "hourly", start_at: `${MON}T09:00:00Z`, end_at: `${MON}T10:00:00Z` });
    expect(res.status).toBe(201);
    bookingId = res.body.data.id as string;
  });

  afterAll(async () => {
    await deleteTestUser(host.id);
    await deleteTestUser(booker.id);
  });

  it("two truly concurrent transitions on the same requested booking never both apply -- exactly one succeeds", async () => {
    // Both requests read status='requested' via loadBookingAccess() and pass
    // their pre-check before either has committed its UPDATE -- without the
    // compare-and-swap guard added in transitionBooking(), both could apply
    // (host reject + host confirm both "succeeding", each firing its own,
    // contradictory notification). Mirrors the existing booking-creation
    // concurrency tests' Promise.all shape (see tests/bookings.test.ts).
    const [confirmRes, rejectRes] = await Promise.all([
      request(app).post(`/v1/bookings/${bookingId}/confirm`).set(authHeader(host)),
      request(app).post(`/v1/bookings/${bookingId}/reject`).set(authHeader(host)),
    ]);

    const succeeded = [confirmRes, rejectRes].filter((r) => r.status === 200);
    const failed = [confirmRes, rejectRes].filter((r) => r.status !== 200);
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect([400, 409]).toContain(failed[0]!.status);

    const { data } = await adminClient.from("bookings").select("status").eq("id", bookingId).single();
    expect(["confirmed", "rejected"]).toContain(data!.status);
  });
});

describe("Phase 12 hardening: refund balance trigger (DB-level backstop)", () => {
  let admin: TestUser;
  let booker: TestUser;
  let host: TestUser;
  let paymentId: string;

  beforeAll(async () => {
    admin = await createTestUser();
    booker = await createTestUser();
    host = await createTestUser();
    await grantAdmin(admin);
    await grantRole(booker, "booker");
    await grantRole(host, "host");

    const locationId = await createBookableLocation(host);
    const bookingRes = await request(app)
      .post("/v1/bookings")
      .set(authHeader(booker))
      .send({ location_id: locationId, booking_type: "hourly", start_at: `${MON}T16:00:00Z`, end_at: `${MON}T17:00:00Z` });
    expect(bookingRes.status).toBe(201);
    const bookingId = bookingRes.body.data.id as string;

    // Seed a settled payment directly (this test targets the DB trigger in
    // isolation, not the createPayment/Cashfree flow already covered by
    // tests/payments.test.ts).
    const { data: payment, error } = await adminClient
      .from("payments")
      .insert({
        booking_id: bookingId,
        provider: "cashfree",
        provider_order_id: `pb_hardening_${bookingId}`,
        status: "success",
        amount_minor_units: 10_000,
        currency: "INR",
      })
      .select("id")
      .single();
    if (error) throw error;
    paymentId = payment!.id as string;
  });

  afterAll(async () => {
    await deleteTestUser(admin.id);
    await deleteTestUser(booker.id);
    await deleteTestUser(host.id);
  });

  it("rejects a raw insert that would overdraw the payment's balance, even bypassing the app's own pre-check", async () => {
    const { error } = await adminClient.from("payment_refunds").insert({
      payment_id: paymentId,
      provider_refund_id: `pbr_over_${paymentId}`,
      status: "pending",
      amount_minor_units: 10_001, // one more than the payment itself
    });
    expect(error).toBeTruthy();
    expect(error!.code).toBe("23514");
  });

  it("allows a full refund and then rejects any further refund against the same payment", async () => {
    const first = await adminClient.from("payment_refunds").insert({
      payment_id: paymentId,
      provider_refund_id: `pbr_full_${paymentId}`,
      status: "success",
      amount_minor_units: 10_000,
    });
    expect(first.error).toBeNull();

    const second = await adminClient.from("payment_refunds").insert({
      payment_id: paymentId,
      provider_refund_id: `pbr_extra_${paymentId}`,
      status: "pending",
      amount_minor_units: 1,
    });
    expect(second.error).toBeTruthy();
    expect(second.error!.code).toBe("23514");
  });
});

describe("Phase 12 hardening: optionalAuth respects account suspension", () => {
  let user: TestUser;
  let draftLocationId: string;

  beforeAll(async () => {
    user = await createTestUser();
    await grantRole(user, "host");
    draftLocationId = await createLocation(user); // never published -- stays 'draft'
  });

  afterAll(async () => {
    await deleteTestUser(user.id);
  });

  it("a suspended owner's token falls back to anonymous on optionalAuth routes -- their own draft becomes invisible, not just read-only", async () => {
    // While active, the owner sees their own draft via optionalAuth's
    // owner-visibility branch (GET /v1/locations/:id is optionalAuth-gated).
    const before = await request(app).get(`/v1/locations/${draftLocationId}`).set(authHeader(user));
    expect(before.status).toBe(200);

    const { error } = await adminClient.from("profiles").update({ status: "suspended" }).eq("id", user.id);
    if (error) throw error;

    try {
      // Same token, same draft -- optionalAuth now downgrades a suspended
      // caller to anonymous (Phase 12) instead of silently keeping their
      // owner-level visibility, and a draft is never publicly visible.
      const after = await request(app).get(`/v1/locations/${draftLocationId}`).set(authHeader(user));
      expect(after.status).toBe(404);
    } finally {
      await adminClient.from("profiles").update({ status: "active" }).eq("id", user.id);
    }
  });
});
