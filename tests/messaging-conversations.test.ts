import { randomUUID } from "crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { anonClient, createUserScopedClient } from "../src/lib/supabase";
import { adminClient, createTestUser, deleteTestUser, TestUser } from "./setup";

// Phase 27-3: the three conversation endpoints.
//
// API behaviour is asserted through supertest; the authorization assumptions
// underneath it are asserted against real Supabase sessions talking to
// PostgREST/RPC directly, the way tests/messaging-authorization.test.ts does --
// an endpoint that returns the right thing for the wrong reason is not proven.

const app = createApp();

const MON = "2026-10-05"; // a Monday

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

/** Fixture listings go straight in via service-role -- the API creation path is covered by locations.test.ts. */
async function makeLocation(hostId: string, title: string, status = "published"): Promise<string> {
  const { data, error } = await adminClient
    .from("locations")
    .insert({ host_id: hostId, title, city: "London", country: "UK", timezone: "UTC", status })
    .select("id")
    .single();
  if (error) throw error;
  return data!.id as string;
}

/** A published listing that can actually take a booking (weekly rule + hourly price). */
async function makeBookableLocation(owner: TestUser, title: string): Promise<string> {
  const created = await request(app)
    .post("/v1/locations")
    .set(authHeader(owner))
    .send({ title, city: "London", country: "UK", timezone: "UTC" });
  expect(created.status).toBe(201);
  const locationId = created.body.data.id as string;

  const rule = await request(app)
    .post(`/v1/locations/${locationId}/availability/rules`)
    .set(authHeader(owner))
    .send({ day_of_week: "monday", start_time: "09:00", end_time: "20:00" });
  expect(rule.status).toBe(201);

  const pricing = await request(app)
    .post(`/v1/locations/${locationId}/pricing`)
    .set(authHeader(owner))
    .send({ booking_type: "hourly", amount_minor_units: 10_000 });
  expect(pricing.status).toBe(201);

  const { error } = await adminClient.from("locations").update({ status: "published" }).eq("id", locationId);
  if (error) throw error;
  return locationId;
}

async function makeBooking(booker: TestUser, locationId: string, startHour: string, endHour: string): Promise<string> {
  const res = await request(app)
    .post("/v1/bookings")
    .set(authHeader(booker))
    .send({
      location_id: locationId,
      booking_type: "hourly",
      start_at: `${MON}T${startHour}:00:00Z`,
      end_at: `${MON}T${endHour}:00:00Z`,
    });
  expect(res.status).toBe(201);
  return res.body.data.id as string;
}

async function openConversation(
  user: TestUser,
  locationId: string,
  bookingId?: string | null
): Promise<{ status: number; body: Record<string, unknown> }> {
  const payload: Record<string, unknown> = { location_id: locationId };
  if (bookingId !== undefined) payload.booking_id = bookingId;
  const res = await request(app).post("/v1/conversations").set(authHeader(user)).send(payload);
  return { status: res.status, body: res.body };
}

describe("Phase 27-3: conversation APIs", () => {
  let host: TestUser;
  let booker: TestUser;
  let outsider: TestUser;
  let admin: TestUser;
  let hostOnly: TestUser;
  let dual: TestUser;
  let pager: TestUser;

  let locationA: string;
  let locationB: string;
  let locationDraft: string;
  let locationArchivedAtSetup: string;
  let locationBookable: string;
  let locationDual: string;

  let bookingBooker: string;
  let bookingBooker2: string;
  let bookingOutsider: string;

  let conversationA: string;
  let conversationB: string;

  const pagerConversationIds: string[] = [];

  beforeAll(async () => {
    host = await createTestUser();
    booker = await createTestUser();
    outsider = await createTestUser();
    admin = await createTestUser();
    hostOnly = await createTestUser();
    dual = await createTestUser();
    pager = await createTestUser();

    await grantRole(host, "host");
    await grantRole(booker, "booker");
    await grantRole(outsider, "booker");
    await grantRole(hostOnly, "host");
    await grantRole(dual, "booker");
    await grantRole(dual, "host");
    await grantRole(pager, "booker");
    await grantAdmin(admin);

    locationA = await makeLocation(host.id, "Authz Listing A");
    locationB = await makeLocation(host.id, "Authz Listing B");
    locationDraft = await makeLocation(host.id, "Draft Listing", "draft");
    locationArchivedAtSetup = await makeLocation(host.id, "Already Archived Listing", "archived");
    locationDual = await makeLocation(dual.id, "Dual User's Own Listing");
    locationBookable = await makeBookableLocation(host, "Bookable Listing");

    bookingBooker = await makeBooking(booker, locationBookable, "10", "12");
    bookingBooker2 = await makeBooking(booker, locationBookable, "13", "15");
    bookingOutsider = await makeBooking(outsider, locationBookable, "16", "17");

    const a = await openConversation(booker, locationA);
    expect(a.status).toBe(201);
    conversationA = (a.body.data as { id: string }).id;

    const b = await openConversation(booker, locationB);
    expect(b.status).toBe(201);
    conversationB = (b.body.data as { id: string }).id;

    // `dual` is the BOOKER here...
    const dualAsBooker = await openConversation(dual, locationA);
    expect(dualAsBooker.status).toBe(201);
    // ...and the HOST here.
    const dualAsHost = await openConversation(booker, locationDual);
    expect(dualAsHost.status).toBe(201);

    // Six conversations for the pagination walk, with three pairs of EXACTLY
    // tied last_message_at values -- the case a timestamp-only cursor breaks
    // on. Written via service-role with explicit timestamps so the tie is
    // guaranteed rather than incidental.
    const stamps = [
      "2026-09-01T10:00:00.000Z",
      "2026-09-01T10:00:00.000Z",
      "2026-09-02T10:00:00.000Z",
      "2026-09-02T10:00:00.000Z",
      "2026-09-03T10:00:00.000Z",
      "2026-09-03T10:00:00.000Z",
    ];
    for (let i = 0; i < stamps.length; i += 1) {
      const locationId = await makeLocation(host.id, `Pager Listing ${i}`);
      const { data, error } = await adminClient
        .from("conversations")
        .insert({ booker_id: pager.id, location_id: locationId, last_message_at: stamps[i] })
        .select("id")
        .single();
      if (error) throw error;
      pagerConversationIds.push(data!.id as string);
    }
  });

  afterAll(async () => {
    for (const user of [booker, outsider, dual, pager]) {
      await deleteTestUser(user.id); // cascades their conversations away first
    }
    await adminClient.from("locations").delete().eq("host_id", host.id);
    await adminClient.from("locations").delete().eq("host_id", dual.id);
    await deleteTestUser(host.id);
    await deleteTestUser(hostOnly.id);
    await deleteTestUser(admin.id);
  });

  // ==========================================================================
  // GET /v1/conversations
  // ==========================================================================

  describe("GET /v1/conversations", () => {
    it("requires authentication", async () => {
      const res = await request(app).get("/v1/conversations");
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("UNAUTHENTICATED");
    });

    it("returns the booker's own conversations", async () => {
      const res = await request(app).get("/v1/conversations").set(authHeader(booker));
      expect(res.status).toBe(200);
      const ids = (res.body.data as { id: string }[]).map((c) => c.id);
      expect(ids).toContain(conversationA);
      expect(ids).toContain(conversationB);
      expect((res.body.data as { viewer_role: string }[]).every((c) => c.viewer_role === "booker")).toBe(true);
    });

    it("returns conversations on the host's own listings", async () => {
      const res = await request(app).get("/v1/conversations").set(authHeader(host));
      expect(res.status).toBe(200);
      const ids = (res.body.data as { id: string }[]).map((c) => c.id);
      expect(ids).toContain(conversationA);
      expect((res.body.data as { viewer_role: string }[]).every((c) => c.viewer_role === "host")).toBe(true);
    });

    it("a user who is both booker and host sees both sides in one Inbox", async () => {
      const res = await request(app).get("/v1/conversations").set(authHeader(dual));
      expect(res.status).toBe(200);
      const roles = (res.body.data as { viewer_role: string }[]).map((c) => c.viewer_role);
      expect(roles).toContain("booker");
      expect(roles).toContain("host");
      expect(res.body.data).toHaveLength(2);
    });

    it("a third party sees an empty list", async () => {
      const res = await request(app).get("/v1/conversations").set(authHeader(outsider));
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
      expect(res.body.meta).toEqual({ limit: 20, has_more: false, next_cursor: null });
      // Phase 27-7: every list row carries the viewer's own unread count.
      expect(
        (res.body.data as { unread_count: unknown }[]).every((c) => typeof c.unread_count === "number")
      ).toBe(true);
    });

    it("an admin who is not a participant sees an empty list -- no admin bypass", async () => {
      const res = await request(app).get("/v1/conversations").set(authHeader(admin));
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    it("orders by last_message_at descending", async () => {
      const res = await request(app).get("/v1/conversations?limit=100").set(authHeader(pager));
      expect(res.status).toBe(200);
      const stamps = (res.body.data as { last_message_at: string }[]).map((c) => Date.parse(c.last_message_at));
      for (let i = 0; i < stamps.length - 1; i += 1) {
        expect(stamps[i]!).toBeGreaterThanOrEqual(stamps[i + 1]!);
      }
    });

    it("walks every page with no duplicates and no missing rows, across tied timestamps", async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;

      do {
        const url: string = cursor
          ? `/v1/conversations?limit=2&cursor=${encodeURIComponent(cursor)}`
          : "/v1/conversations?limit=2";
        const res = await request(app).get(url).set(authHeader(pager));
        expect(res.status).toBe(200);
        expect(res.body.data.length).toBeLessThanOrEqual(2);
        seen.push(...(res.body.data as { id: string }[]).map((c) => c.id));
        cursor = res.body.meta.has_more ? (res.body.meta.next_cursor as string) : null;
        pages += 1;
        expect(pages).toBeLessThan(10); // never loops
      } while (cursor);

      expect(pages).toBe(3);
      expect(new Set(seen).size).toBe(seen.length); // no duplicates
      expect(seen.sort()).toEqual([...pagerConversationIds].sort()); // nothing missed
    });

    it("is deterministic across tied timestamps -- the same walk twice yields the same order", async () => {
      async function walk(): Promise<string[]> {
        const ids: string[] = [];
        let cursor: string | null = null;
        do {
          const url: string = cursor
            ? `/v1/conversations?limit=1&cursor=${encodeURIComponent(cursor)}`
            : "/v1/conversations?limit=1";
          const res = await request(app).get(url).set(authHeader(pager));
          ids.push(...(res.body.data as { id: string }[]).map((c) => c.id));
          cursor = res.body.meta.has_more ? (res.body.meta.next_cursor as string) : null;
        } while (cursor);
        return ids;
      }
      const first = await walk();
      const second = await walk();
      expect(first).toEqual(second);
      expect(first).toHaveLength(6);
    });

    it("reports has_more and next_cursor correctly on the last page", async () => {
      const res = await request(app).get("/v1/conversations?limit=100").set(authHeader(pager));
      expect(res.body.meta.has_more).toBe(false);
      expect(res.body.meta.next_cursor).toBeNull();
      expect(res.body.data).toHaveLength(6);
    });

    it("defaults limit to 20 and echoes it in meta", async () => {
      const res = await request(app).get("/v1/conversations").set(authHeader(pager));
      expect(res.body.meta.limit).toBe(20);
      expect(res.body.meta).not.toHaveProperty("total");
      expect(res.body.meta).not.toHaveProperty("page");
      expect(res.body.meta).not.toHaveProperty("pageSize");
    });

    it("accepts the minimum and maximum limit", async () => {
      const min = await request(app).get("/v1/conversations?limit=1").set(authHeader(pager));
      expect(min.status).toBe(200);
      expect(min.body.data).toHaveLength(1);

      const max = await request(app).get("/v1/conversations?limit=100").set(authHeader(pager));
      expect(max.status).toBe(200);
      expect(max.body.meta.limit).toBe(100);
    });

    it("rejects a limit outside 1-100", async () => {
      for (const limit of ["0", "101", "-1", "abc"]) {
        const res = await request(app).get(`/v1/conversations?limit=${limit}`).set(authHeader(pager));
        expect(res.status, `limit=${limit}`).toBe(400);
        expect(res.body.error.code).toBe("VALIDATION_ERROR");
      }
    });

    it("rejects a malformed or tampered cursor with 400, never a 500", async () => {
      for (const cursor of ["not-base64!!", "Zm9vfGJhcg", Buffer.from("2026-01-01T00:00:00Z|not-a-uuid").toString("base64url"), Buffer.from(`nonsense|${randomUUID()}`).toString("base64url"), "!!!"]) {
        const res = await request(app)
          .get(`/v1/conversations?limit=2&cursor=${encodeURIComponent(cursor)}`)
          .set(authHeader(pager));
        expect(res.status, `cursor=${cursor}`).toBe(400);
        expect(res.body.error.code).toBe("VALIDATION_ERROR");
      }
    });

    it("no identity query parameter can widen the result set", async () => {
      const baseline = await request(app).get("/v1/conversations").set(authHeader(outsider));
      expect(baseline.body.data).toEqual([]);

      // Every shape someone might hope acts as an authorization filter.
      const attempts = [
        `booker_id=${booker.id}`,
        `host_id=${host.id}`,
        `user_id=${booker.id}`,
        `booker_id=eq.${booker.id}`,
        `page=1&pageSize=100`,
        `booker_id=${booker.id}&host_id=${host.id}&user_id=${host.id}`,
      ];
      for (const qs of attempts) {
        const res = await request(app).get(`/v1/conversations?${qs}`).set(authHeader(outsider));
        expect(res.status, qs).toBe(200);
        expect(res.body.data, qs).toEqual([]);
      }

      // And a participant's own view is unchanged by them either -- same rows,
      // same roles, whatever identity is named in the query string.
      const plain = await request(app).get("/v1/conversations?limit=100").set(authHeader(booker));
      const spiked = await request(app)
        .get(`/v1/conversations?limit=100&booker_id=${outsider.id}&host_id=${host.id}&user_id=${host.id}`)
        .set(authHeader(booker));
      expect(spiked.status).toBe(200);
      expect(spiked.body.data).toEqual(plain.body.data);
      expect((spiked.body.data as { viewer_role: string }[]).every((c) => c.viewer_role === "booker")).toBe(true);
    });
  });

  // ==========================================================================
  // GET /v1/conversations/:id
  // ==========================================================================

  describe("GET /v1/conversations/:id", () => {
    it("requires authentication", async () => {
      const res = await request(app).get(`/v1/conversations/${conversationA}`);
      expect(res.status).toBe(401);
    });

    it("the booker can retrieve their conversation", async () => {
      const res = await request(app).get(`/v1/conversations/${conversationA}`).set(authHeader(booker));
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(conversationA);
      expect(res.body.data.viewer_role).toBe("booker");
      expect(res.body.data.counterparty.id).toBe(host.id);
      expect(res.body.data.location).toMatchObject({ id: locationA, title: "Authz Listing A", city: "London", status: "published" });
    });

    it("the host can retrieve the same conversation, with the opposite viewer_role and counterparty", async () => {
      const res = await request(app).get(`/v1/conversations/${conversationA}`).set(authHeader(host));
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(conversationA);
      expect(res.body.data.viewer_role).toBe("host");
      expect(res.body.data.counterparty.id).toBe(booker.id);
    });

    it("a third party receives 404, not 403", async () => {
      const res = await request(app).get(`/v1/conversations/${conversationA}`).set(authHeader(outsider));
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
    });

    it("an admin who is not a participant receives 404", async () => {
      const res = await request(app).get(`/v1/conversations/${conversationA}`).set(authHeader(admin));
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
    });

    it("a nonexistent conversation receives 404 -- indistinguishable from an unauthorized one", async () => {
      const missing = await request(app).get(`/v1/conversations/${randomUUID()}`).set(authHeader(booker));
      const unauthorized = await request(app).get(`/v1/conversations/${conversationA}`).set(authHeader(outsider));
      expect(missing.status).toBe(404);
      expect(missing.body.error).toEqual(unauthorized.body.error);
    });

    it("a malformed UUID receives 400", async () => {
      const res = await request(app).get("/v1/conversations/not-a-uuid").set(authHeader(booker));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("exposes only the safe DTO -- no messages, no read CURSOR, no private profile fields", async () => {
      const res = await request(app).get(`/v1/conversations/${conversationA}`).set(authHeader(host));
      const body = res.body.data as Record<string, unknown>;

      // Phase 27-7 added `unread_count` and nothing else. The read CURSOR
      // itself (last_read_at / last_read_message_id) deliberately stays out:
      // it is returned only by POST /v1/conversations/:id/read, to the one
      // user it belongs to.
      expect(Object.keys(body).sort()).toEqual(
        [
          "booking_id",
          "counterparty",
          "created_at",
          "id",
          "last_message_at",
          "location",
          "unread_count",
          "updated_at",
          "viewer_role",
        ].sort()
      );
      expect(typeof body.unread_count).toBe("number");
      for (const forbidden of ["messages", "message", "last_read_at", "last_read_message_id", "last_message_id", "booker_id", "host_id"]) {
        expect(body, forbidden).not.toHaveProperty(forbidden);
      }

      const counterparty = body.counterparty as Record<string, unknown>;
      expect(Object.keys(counterparty).sort()).toEqual(["avatar_url", "first_name", "id", "last_name"].sort());
      for (const forbidden of ["phone", "email", "status", "address_line1", "address_city", "address_country", "address_postal_code", "created_at"]) {
        expect(counterparty, forbidden).not.toHaveProperty(forbidden);
      }

      const location = body.location as Record<string, unknown>;
      expect(Object.keys(location).sort()).toEqual(["city", "id", "primary_media_url", "status", "title"].sort());
      for (const forbidden of ["host_id", "address_line1", "latitude", "longitude", "moderation_reason", "description"]) {
        expect(location, forbidden).not.toHaveProperty(forbidden);
      }
    });

    it("the list rows use the identical DTO shape", async () => {
      const list = await request(app).get("/v1/conversations").set(authHeader(booker));
      const detail = await request(app).get(`/v1/conversations/${conversationA}`).set(authHeader(booker));
      const fromList = (list.body.data as { id: string }[]).find((c) => c.id === conversationA);
      expect(fromList).toEqual(detail.body.data);
    });
  });

  // ==========================================================================
  // Unpublish regression -- the reason the SECURITY DEFINER RPC exists
  // ==========================================================================

  describe("an existing conversation survives its listing being unpublished", () => {
    it("stays retrievable, with its listing and counterparty summary intact", async () => {
      const locationId = await makeLocation(host.id, "Listing To Archive");
      const opened = await openConversation(booker, locationId);
      expect(opened.status).toBe(201);
      const conversationId = (opened.body.data as { id: string }).id;

      const before = await request(app).get(`/v1/conversations/${conversationId}`).set(authHeader(booker));
      expect(before.status).toBe(200);
      expect(before.body.data.location.title).toBe("Listing To Archive");

      // Archive through the same service-role path the moderation/host
      // transitions already use.
      const { error } = await adminClient.from("locations").update({ status: "archived" }).eq("id", locationId);
      if (error) throw error;

      // Prove the underlying RLS really does hide the listing now -- otherwise
      // this test would pass for the wrong reason.
      const bookerClient = createUserScopedClient(booker.accessToken);
      const { data: rawLocation } = await bookerClient.from("locations").select("id").eq("id", locationId);
      expect(rawLocation).toHaveLength(0);

      const after = await request(app).get(`/v1/conversations/${conversationId}`).set(authHeader(booker));
      expect(after.status).toBe(200);
      expect(after.body.data.location.title).toBe("Listing To Archive");
      expect(after.body.data.location.city).toBe("London");
      expect(after.body.data.location.status).toBe("archived"); // reported honestly
      expect(after.body.data.counterparty.id).toBe(host.id);
      expect(after.body.data.counterparty).not.toHaveProperty("phone");

      const inList = await request(app).get("/v1/conversations?limit=100").set(authHeader(booker));
      expect((inList.body.data as { id: string }[]).map((c) => c.id)).toContain(conversationId);

      // ...but a NEW conversation against that listing is refused -- the
      // deliberate asymmetry between opening and continuing.
      const blocked = await openConversation(outsider, locationId);
      expect(blocked.status).toBe(404);
    });
  });

  // ==========================================================================
  // POST /v1/conversations
  // ==========================================================================

  describe("POST /v1/conversations", () => {
    it("requires authentication", async () => {
      const res = await request(app).post("/v1/conversations").send({ location_id: locationA });
      expect(res.status).toBe(401);
    });

    it("requires the booker role -- a host cannot initiate", async () => {
      const res = await openConversation(hostOnly, locationA);
      expect(res.status).toBe(403);
      expect((res.body.error as { code: string }).code).toBe("FORBIDDEN");
    });

    it("creates a conversation for a booker against a published listing", async () => {
      const locationId = await makeLocation(host.id, "Fresh Listing");
      const res = await openConversation(outsider, locationId);
      expect(res.status).toBe(201);
      const body = res.body.data as { id: string; viewer_role: string; booking_id: string | null };
      expect(body.viewer_role).toBe("booker");
      expect(body.booking_id).toBeNull();

      const { data } = await adminClient
        .from("conversations")
        .select("booker_id, location_id")
        .eq("id", body.id)
        .single();
      expect(data!.booker_id).toBe(outsider.id);
      expect(data!.location_id).toBe(locationId);
    });

    it("is idempotent -- a repeated request returns the same conversation", async () => {
      const first = await openConversation(booker, locationA);
      const second = await openConversation(booker, locationA);
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect((first.body.data as { id: string }).id).toBe(conversationA);
      expect((second.body.data as { id: string }).id).toBe(conversationA);
    });

    it("N concurrent identical requests produce exactly one conversation", async () => {
      const locationId = await makeLocation(host.id, "Race Listing");

      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          request(app).post("/v1/conversations").set(authHeader(outsider)).send({ location_id: locationId })
        )
      );

      expect(results.every((r) => r.status === 201)).toBe(true);
      const ids = new Set(results.map((r) => r.body.data.id as string));
      expect(ids.size).toBe(1);

      // The authoritative check: the database itself holds exactly one row.
      const { data } = await adminClient
        .from("conversations")
        .select("id")
        .eq("booker_id", outsider.id)
        .eq("location_id", locationId);
      expect(data).toHaveLength(1);
      expect(data![0]!.id).toBe([...ids][0]);
    });

    it("returns 404 for a nonexistent location", async () => {
      const res = await openConversation(outsider, randomUUID());
      expect(res.status).toBe(404);
      expect((res.body.error as { code: string }).code).toBe("NOT_FOUND");
    });

    it("returns 404 for a draft listing -- never confirming it exists", async () => {
      const res = await openConversation(outsider, locationDraft);
      expect(res.status).toBe(404);
    });

    it("returns 404 for an archived listing", async () => {
      const res = await openConversation(outsider, locationArchivedAtSetup);
      expect(res.status).toBe(404);
    });

    it("rejects a self-conversation with 400", async () => {
      const res = await openConversation(dual, locationDual);
      expect(res.status).toBe(400);
      expect((res.body.error as { code: string }).code).toBe("VALIDATION_ERROR");

      const { data } = await adminClient
        .from("conversations")
        .select("id")
        .eq("booker_id", dual.id)
        .eq("location_id", locationDual);
      expect(data).toHaveLength(0);
    });

    it("accepts a booking the caller owns for that listing", async () => {
      const res = await openConversation(booker, locationBookable, bookingBooker);
      expect(res.status).toBe(201);
      expect((res.body.data as { booking_id: string }).booking_id).toBe(bookingBooker);
    });

    it("does NOT re-point booking_id on a subsequent get-or-create", async () => {
      const again = await openConversation(booker, locationBookable, bookingBooker2);
      expect(again.status).toBe(201);
      expect((again.body.data as { booking_id: string }).booking_id).toBe(bookingBooker);

      const withNull = await openConversation(booker, locationBookable, null);
      expect((withNull.body.data as { booking_id: string }).booking_id).toBe(bookingBooker);

      const { data } = await adminClient
        .from("conversations")
        .select("booking_id")
        .eq("booker_id", booker.id)
        .eq("location_id", locationBookable)
        .single();
      expect(data!.booking_id).toBe(bookingBooker);
    });

    it("rejects a booking belonging to another user with 400", async () => {
      const res = await openConversation(booker, locationBookable, bookingOutsider);
      expect(res.status).toBe(400);
      expect((res.body.error as { code: string }).code).toBe("VALIDATION_ERROR");
    });

    it("rejects a booking for a different location with 400", async () => {
      const res = await openConversation(booker, locationA, bookingBooker);
      expect(res.status).toBe(400);
      expect((res.body.error as { code: string }).code).toBe("VALIDATION_ERROR");
    });

    it("rejects a nonexistent booking with 400", async () => {
      const res = await openConversation(outsider, locationB, randomUUID());
      expect(res.status).toBe(400);
    });

    it("rejects unknown body fields, including every identity field", async () => {
      const bodies: Record<string, unknown>[] = [
        { location_id: locationA, booker_id: outsider.id },
        { location_id: locationA, host_id: host.id },
        { location_id: locationA, participants: [outsider.id] },
        { location_id: locationA, sender_id: outsider.id },
        { location_id: locationA, user_id: outsider.id },
        { location_id: locationA, viewer_role: "host" },
        { location_id: locationA, id: randomUUID() },
        { location_id: locationA, last_message_at: "2020-01-01T00:00:00Z" },
      ];
      for (const body of bodies) {
        const res = await request(app).post("/v1/conversations").set(authHeader(outsider)).send(body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(res.body.error.code).toBe("VALIDATION_ERROR");
      }
    });

    it("rejects a missing or malformed location_id", async () => {
      for (const body of [{}, { location_id: "not-a-uuid" }, { location_id: null }]) {
        const res = await request(app).post("/v1/conversations").set(authHeader(outsider)).send(body);
        expect(res.status, JSON.stringify(body)).toBe(400);
      }
    });

    it("a forged booker_id can never change the authenticated identity", async () => {
      // Strict validation refuses it outright...
      const locationId = await makeLocation(host.id, "Forgery Listing");
      const forged = await request(app)
        .post("/v1/conversations")
        .set(authHeader(outsider))
        .send({ location_id: locationId, booker_id: booker.id });
      expect(forged.status).toBe(400);

      // ...and the honest request that follows belongs to the caller, not to
      // whoever they named.
      const honest = await openConversation(outsider, locationId);
      expect(honest.status).toBe(201);
      const { data } = await adminClient
        .from("conversations")
        .select("booker_id")
        .eq("id", (honest.body.data as { id: string }).id)
        .single();
      expect(data!.booker_id).toBe(outsider.id);
      expect(data!.booker_id).not.toBe(booker.id);
    });
  });

  // ==========================================================================
  // Security -- the layer beneath the API
  // ==========================================================================

  describe("security", () => {
    it("the RPC does not accept a caller-supplied user id", async () => {
      const client = createUserScopedClient(outsider.accessToken);
      const { data, error } = await client.rpc("get_conversations_for_viewer", {
        _cursor_last_message_at: null,
        _cursor_id: null,
        _limit: 20,
        _conversation_id: null,
        _user_id: booker.id,
      });
      expect(error).toBeTruthy();
      expect(data).toBeNull();
    });

    it("the RPC cannot be used to read another user's conversations", async () => {
      const client = createUserScopedClient(outsider.accessToken);
      const { data } = await client.rpc("get_conversations_for_viewer", {
        _cursor_last_message_at: null,
        _cursor_id: null,
        _limit: 100,
        _conversation_id: conversationA,
      });
      expect(data ?? []).toHaveLength(0);
    });

    it("the RPC yields nothing to an anonymous caller", async () => {
      const { data } = await anonClient.rpc("get_conversations_for_viewer", {
        _cursor_last_message_at: null,
        _cursor_id: null,
        _limit: 100,
        _conversation_id: null,
      });
      // anon holds no EXECUTE grant, so this errors; even if it were granted,
      // auth.uid() is null and the function fails closed. Either way: no data.
      expect(data ?? []).toHaveLength(0);
    });

    it("an admin cannot enumerate conversations through the RPC either", async () => {
      const client = createUserScopedClient(admin.accessToken);
      const { data } = await client.rpc("get_conversations_for_viewer", {
        _cursor_last_message_at: null,
        _cursor_id: null,
        _limit: 100,
        _conversation_id: null,
      });
      expect(data ?? []).toHaveLength(0);
    });

    it("cross-location access is denied -- a booker only ever sees listings they have a thread on", async () => {
      const res = await request(app).get("/v1/conversations?limit=100").set(authHeader(booker));
      const locationIds = (res.body.data as { location: { id: string } }[]).map((c) => c.location.id);
      // Listings this booker has never opened a conversation about.
      expect(locationIds).not.toContain(locationDraft);
      expect(locationIds).not.toContain(locationArchivedAtSetup);

      // And the pager's six conversations belong to nobody else's Inbox.
      const pagerIds = (res.body.data as { id: string }[]).map((c) => c.id);
      for (const id of pagerConversationIds) {
        expect(pagerIds).not.toContain(id);
      }
    });

    it("Phase 27-2's direct-write refusals still hold -- conversations are not client-writable", async () => {
      const client = createUserScopedClient(booker.accessToken);
      const { error } = await client
        .from("conversations")
        .insert({ booker_id: booker.id, location_id: locationDraft });
      expect(error?.code).toBe("42501");
    });
  });
});
