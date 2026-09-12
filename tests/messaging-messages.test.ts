import { randomUUID } from "crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { createUserScopedClient } from "../src/lib/supabase";
import { adminClient, createTestUser, deleteTestUser, TestUser } from "./setup";

// Phase 27-4: message retrieval and sending.
//
// API behaviour through supertest; the authorization and storage guarantees
// underneath it through real Supabase sessions talking to PostgREST directly,
// the way tests/messaging-authorization.test.ts does. An endpoint that returns
// the right thing for the wrong reason is not proven.

const app = createApp();

const INSUFFICIENT_PRIVILEGE = "42501";

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

async function makeLocation(hostId: string, title: string, status = "published"): Promise<string> {
  const { data, error } = await adminClient
    .from("locations")
    .insert({ host_id: hostId, title, city: "London", country: "UK", timezone: "UTC", status })
    .select("id")
    .single();
  if (error) throw error;
  return data!.id as string;
}

async function openConversation(user: TestUser, locationId: string): Promise<string> {
  const res = await request(app).post("/v1/conversations").set(authHeader(user)).send({ location_id: locationId });
  expect(res.status).toBe(201);
  return res.body.data.id as string;
}

/** Seeded directly so `created_at` can be controlled exactly (ties, ordering). */
async function seedMessage(conversationId: string, senderId: string, body: string, createdAt?: string): Promise<string> {
  const row: Record<string, unknown> = {
    conversation_id: conversationId,
    sender_id: senderId,
    body,
    client_message_id: randomUUID(),
  };
  if (createdAt) row.created_at = createdAt;
  const { data, error } = await adminClient.from("messages").insert(row).select("id").single();
  if (error) throw error;
  return data!.id as string;
}

async function postMessage(
  user: TestUser,
  conversationId: string,
  body: unknown,
  clientMessageId?: string | undefined
): Promise<{ status: number; body: Record<string, never> & { data: Record<string, unknown>; error: { code: string } } }> {
  const payload: Record<string, unknown> = { body };
  if (clientMessageId !== undefined) payload.client_message_id = clientMessageId;
  const res = await request(app)
    .post(`/v1/conversations/${conversationId}/messages`)
    .set(authHeader(user))
    .send(payload);
  return { status: res.status, body: res.body };
}

async function send(user: TestUser, conversationId: string, text: string): Promise<Record<string, unknown>> {
  const res = await postMessage(user, conversationId, text, randomUUID());
  expect(res.status).toBe(201);
  return res.body.data;
}

describe("Phase 27-4: message APIs", () => {
  let host: TestUser;
  let booker: TestUser;
  let outsider: TestUser;
  let admin: TestUser;

  let conversationMain: string;
  let conversationEmpty: string;
  let conversationSend: string;
  let conversationSend2: string;
  let conversationArchived: string;
  let locationArchived: string;

  const mainMessageIds: string[] = [];

  const T1 = "2026-09-01T10:00:00.000Z";
  const T2 = "2026-09-02T10:00:00.000Z";
  const T3 = "2026-09-03T10:00:00.000Z";

  beforeAll(async () => {
    host = await createTestUser();
    booker = await createTestUser();
    outsider = await createTestUser();
    admin = await createTestUser();
    await grantRole(host, "host");
    await grantRole(booker, "booker");
    await grantRole(outsider, "booker");
    await grantAdmin(admin);

    conversationMain = await openConversation(booker, await makeLocation(host.id, "Msg Main"));
    conversationEmpty = await openConversation(booker, await makeLocation(host.id, "Msg Empty"));
    conversationSend = await openConversation(booker, await makeLocation(host.id, "Msg Send"));
    conversationSend2 = await openConversation(booker, await makeLocation(host.id, "Msg Send Two"));

    locationArchived = await makeLocation(host.id, "Msg To Archive");
    conversationArchived = await openConversation(booker, locationArchived);

    // Six messages, three pairs of EXACTLY tied created_at, alternating
    // senders -- the case a timestamp-only cursor breaks on.
    mainMessageIds.push(await seedMessage(conversationMain, booker.id, "m1 (tied T1)", T1));
    mainMessageIds.push(await seedMessage(conversationMain, host.id, "m2 (tied T1)", T1));
    mainMessageIds.push(await seedMessage(conversationMain, booker.id, "m3 (tied T2)", T2));
    mainMessageIds.push(await seedMessage(conversationMain, host.id, "m4 (tied T2)", T2));
    mainMessageIds.push(await seedMessage(conversationMain, booker.id, "m5 (tied T3)", T3));
    mainMessageIds.push(await seedMessage(conversationMain, host.id, "m6 (tied T3)", T3));
  });

  afterAll(async () => {
    await deleteTestUser(booker.id); // cascades their conversations away first
    await deleteTestUser(outsider.id);
    await deleteTestUser(admin.id);
    await adminClient.from("locations").delete().eq("host_id", host.id);
    await deleteTestUser(host.id);
  });

  // ==========================================================================
  // GET /v1/conversations/:id/messages
  // ==========================================================================

  describe("GET /v1/conversations/:id/messages", () => {
    it("requires authentication", async () => {
      const res = await request(app).get(`/v1/conversations/${conversationMain}/messages`);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("UNAUTHENTICATED");
    });

    it("the booker can read the conversation's messages", async () => {
      const res = await request(app).get(`/v1/conversations/${conversationMain}/messages`).set(authHeader(booker));
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(6);
    });

    it("the host can read the same messages", async () => {
      const res = await request(app).get(`/v1/conversations/${conversationMain}/messages`).set(authHeader(host));
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(6);
    });

    it("both senders' messages are visible to both participants", async () => {
      for (const user of [booker, host]) {
        const res = await request(app).get(`/v1/conversations/${conversationMain}/messages`).set(authHeader(user));
        const senders = new Set((res.body.data as { sender_id: string }[]).map((m) => m.sender_id));
        expect(senders, user.email).toEqual(new Set([booker.id, host.id]));
      }
    });

    it("a third party receives 404, not an empty page", async () => {
      const res = await request(app).get(`/v1/conversations/${conversationMain}/messages`).set(authHeader(outsider));
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
    });

    it("an admin who is not a participant receives 404 -- no admin bypass", async () => {
      const res = await request(app).get(`/v1/conversations/${conversationMain}/messages`).set(authHeader(admin));
      expect(res.status).toBe(404);
    });

    it("a nonexistent conversation is indistinguishable from an unauthorized one", async () => {
      const missing = await request(app).get(`/v1/conversations/${randomUUID()}/messages`).set(authHeader(booker));
      const unauthorized = await request(app)
        .get(`/v1/conversations/${conversationMain}/messages`)
        .set(authHeader(outsider));
      expect(missing.status).toBe(404);
      expect(missing.body.error).toEqual(unauthorized.body.error);
    });

    it("a malformed conversation UUID is rejected", async () => {
      const res = await request(app).get("/v1/conversations/not-a-uuid/messages").set(authHeader(booker));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("an empty conversation returns 200 with an empty page", async () => {
      const res = await request(app).get(`/v1/conversations/${conversationEmpty}/messages`).set(authHeader(booker));
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
      expect(res.body.meta).toEqual({ limit: 50, has_more: false, next_cursor: null });
    });

    it("returns exactly the six-field DTO and nothing else", async () => {
      const res = await request(app).get(`/v1/conversations/${conversationMain}/messages`).set(authHeader(host));
      const message = res.body.data[0] as Record<string, unknown>;
      expect(Object.keys(message).sort()).toEqual(
        ["body", "client_message_id", "conversation_id", "created_at", "id", "sender_id"].sort()
      );
      for (const forbidden of ["sender", "sender_name", "first_name", "avatar_url", "phone", "email", "updated_at", "is_read", "read_at", "attachments", "booking_id", "location"]) {
        expect(message, forbidden).not.toHaveProperty(forbidden);
      }
    });

    it("orders newest-first by created_at DESC, id DESC", async () => {
      const res = await request(app)
        .get(`/v1/conversations/${conversationMain}/messages?limit=100`)
        .set(authHeader(booker));
      const rows = res.body.data as { id: string; created_at: string }[];
      expect(rows).toHaveLength(6);

      // The full ordering invariant, checked pairwise: created_at descends,
      // and where it ties, id descends.
      for (let i = 0; i < rows.length - 1; i += 1) {
        const a = rows[i]!;
        const b = rows[i + 1]!;
        const at = Date.parse(a.created_at);
        const bt = Date.parse(b.created_at);
        expect(at).toBeGreaterThanOrEqual(bt);
        if (at === bt) {
          expect(a.id > b.id).toBe(true); // id DESC breaks the tie
        }
      }

      // Deliberately asserted on TIMESTAMPS, not on specific message bodies:
      // the six fixtures form three tied pairs, so which member of a pair
      // lands first is decided by the random v4 uuid tiebreak and legitimately
      // varies between runs. Asserting a particular body here would be a test
      // that passes or fails on the luck of the uuid draw.
      //
      // Compared as INSTANTS, not strings: Postgres renders timestamptz as
      // `2026-09-03T10:00:00+00:00`, which is the same moment as the JS literal
      // `2026-09-03T10:00:00.000Z` but not the same characters.
      expect(Date.parse(rows[0]!.created_at)).toBe(Date.parse(T3));
      expect(Date.parse(rows[1]!.created_at)).toBe(Date.parse(T3));
      expect(Date.parse(rows[4]!.created_at)).toBe(Date.parse(T1));
      expect(Date.parse(rows[5]!.created_at)).toBe(Date.parse(T1));
    });

    it("walks every page with no duplicates and no missing rows, across tied timestamps", async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;

      do {
        const url: string = cursor
          ? `/v1/conversations/${conversationMain}/messages?limit=2&cursor=${encodeURIComponent(cursor)}`
          : `/v1/conversations/${conversationMain}/messages?limit=2`;
        const res = await request(app).get(url).set(authHeader(booker));
        expect(res.status).toBe(200);
        expect(res.body.data.length).toBeLessThanOrEqual(2);
        seen.push(...(res.body.data as { id: string }[]).map((m) => m.id));
        cursor = res.body.meta.has_more ? (res.body.meta.next_cursor as string) : null;
        pages += 1;
        expect(pages).toBeLessThan(10); // never loops
      } while (cursor);

      expect(pages).toBe(3);
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen.sort()).toEqual([...mainMessageIds].sort());
    });

    it("is deterministic across tied timestamps -- the same walk twice yields the same order", async () => {
      async function walk(): Promise<string[]> {
        const ids: string[] = [];
        let cursor: string | null = null;
        do {
          const url: string = cursor
            ? `/v1/conversations/${conversationMain}/messages?limit=1&cursor=${encodeURIComponent(cursor)}`
            : `/v1/conversations/${conversationMain}/messages?limit=1`;
          const res = await request(app).get(url).set(authHeader(booker));
          ids.push(...(res.body.data as { id: string }[]).map((m) => m.id));
          cursor = res.body.meta.has_more ? (res.body.meta.next_cursor as string) : null;
        } while (cursor);
        return ids;
      }
      const first = await walk();
      expect(first).toHaveLength(6);
      expect(await walk()).toEqual(first);
    });

    it("reports has_more and next_cursor correctly on the final page", async () => {
      const res = await request(app)
        .get(`/v1/conversations/${conversationMain}/messages?limit=100`)
        .set(authHeader(booker));
      expect(res.body.meta.has_more).toBe(false);
      expect(res.body.meta.next_cursor).toBeNull();
      expect(res.body.meta.limit).toBe(100);
    });

    it("defaults limit to 50 and returns no total/page/pageSize", async () => {
      const res = await request(app).get(`/v1/conversations/${conversationMain}/messages`).set(authHeader(booker));
      expect(res.body.meta.limit).toBe(50);
      expect(res.body.meta).not.toHaveProperty("total");
      expect(res.body.meta).not.toHaveProperty("page");
      expect(res.body.meta).not.toHaveProperty("pageSize");
    });

    it("accepts the minimum and maximum limit", async () => {
      const min = await request(app)
        .get(`/v1/conversations/${conversationMain}/messages?limit=1`)
        .set(authHeader(booker));
      expect(min.status).toBe(200);
      expect(min.body.data).toHaveLength(1);
      expect(min.body.meta.has_more).toBe(true);

      const max = await request(app)
        .get(`/v1/conversations/${conversationMain}/messages?limit=100`)
        .set(authHeader(booker));
      expect(max.status).toBe(200);
      expect(max.body.data).toHaveLength(6);
    });

    it("rejects a limit outside 1-100", async () => {
      for (const limit of ["0", "101", "-1", "abc"]) {
        const res = await request(app)
          .get(`/v1/conversations/${conversationMain}/messages?limit=${limit}`)
          .set(authHeader(booker));
        expect(res.status, `limit=${limit}`).toBe(400);
        expect(res.body.error.code).toBe("VALIDATION_ERROR");
      }
    });

    it("rejects a malformed or tampered cursor with 400, never a 500", async () => {
      const cursors = [
        "not-base64!!",
        "Zm9vfGJhcg",
        Buffer.from("2026-01-01T00:00:00Z|not-a-uuid").toString("base64url"),
        Buffer.from(`nonsense|${randomUUID()}`).toString("base64url"),
        "!!!",
      ];
      for (const cursor of cursors) {
        const res = await request(app)
          .get(`/v1/conversations/${conversationMain}/messages?cursor=${encodeURIComponent(cursor)}`)
          .set(authHeader(booker));
        expect(res.status, cursor).toBe(400);
        expect(res.body.error.code).toBe("VALIDATION_ERROR");
      }
    });

    it("a cursor minted in one conversation cannot reach another conversation's messages", async () => {
      const first = await request(app)
        .get(`/v1/conversations/${conversationMain}/messages?limit=1`)
        .set(authHeader(booker));
      const cursor = first.body.meta.next_cursor as string;

      await send(booker, conversationSend2, "only message in send2");
      const res = await request(app)
        .get(`/v1/conversations/${conversationSend2}/messages?cursor=${encodeURIComponent(cursor)}`)
        .set(authHeader(booker));
      expect(res.status).toBe(200);
      // The cursor is a position, not a capability -- it can only ever filter
      // within the conversation named in the path.
      const ids = (res.body.data as { id: string }[]).map((m) => m.id);
      for (const id of mainMessageIds) {
        expect(ids).not.toContain(id);
      }
    });

    it("no query parameter can widen the result set", async () => {
      const plain = await request(app)
        .get(`/v1/conversations/${conversationMain}/messages?limit=100`)
        .set(authHeader(booker));
      const spiked = await request(app)
        .get(
          `/v1/conversations/${conversationMain}/messages?limit=100&sender_id=${host.id}&conversation_id=${conversationEmpty}&user_id=${outsider.id}&page=1&pageSize=100`
        )
        .set(authHeader(booker));
      expect(spiked.status).toBe(200);
      expect(spiked.body.data).toEqual(plain.body.data);
    });

    it("reading messages does NOT create or advance a read cursor (Phase 27-7 boundary)", async () => {
      const before = await adminClient
        .from("conversation_reads")
        .select("id")
        .eq("conversation_id", conversationMain);
      expect(before.data).toHaveLength(0);

      await request(app).get(`/v1/conversations/${conversationMain}/messages`).set(authHeader(booker));
      await request(app).get(`/v1/conversations/${conversationMain}/messages`).set(authHeader(host));

      const after = await adminClient
        .from("conversation_reads")
        .select("id, last_read_at, last_read_message_id")
        .eq("conversation_id", conversationMain);
      expect(after.data).toHaveLength(0);
    });
  });

  // ==========================================================================
  // POST /v1/conversations/:id/messages
  // ==========================================================================

  describe("POST /v1/conversations/:id/messages", () => {
    it("requires authentication", async () => {
      const res = await request(app)
        .post(`/v1/conversations/${conversationSend}/messages`)
        .send({ body: "hi", client_message_id: randomUUID() });
      expect(res.status).toBe(401);
    });

    it("the booker can send, and the stored sender is the authenticated user", async () => {
      const message = await send(booker, conversationSend, "Booker asking about the loading bay");
      expect(message.sender_id).toBe(booker.id);
      expect(message.conversation_id).toBe(conversationSend);

      const { data } = await adminClient.from("messages").select("sender_id").eq("id", message.id as string).single();
      expect(data!.sender_id).toBe(booker.id);
    });

    it("the host can send into the same conversation -- no booker role required", async () => {
      const message = await send(host, conversationSend, "Host replying with access details");
      expect(message.sender_id).toBe(host.id);
    });

    it("returns exactly the six-field DTO", async () => {
      const message = await send(booker, conversationSend, "shape check");
      expect(Object.keys(message).sort()).toEqual(
        ["body", "client_message_id", "conversation_id", "created_at", "id", "sender_id"].sort()
      );
    });

    it("a third party cannot send into someone else's conversation", async () => {
      const res = await postMessage(outsider, conversationSend, "intruding", randomUUID());
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
    });

    it("an admin who is not a participant cannot send", async () => {
      const res = await postMessage(admin, conversationSend, "admin injecting", randomUUID());
      expect(res.status).toBe(404);
    });

    it("rejects a nonexistent conversation and a malformed UUID", async () => {
      const missing = await postMessage(booker, randomUUID(), "nowhere", randomUUID());
      expect(missing.status).toBe(404);

      const malformed = await request(app)
        .post("/v1/conversations/not-a-uuid/messages")
        .set(authHeader(booker))
        .send({ body: "x", client_message_id: randomUUID() });
      expect(malformed.status).toBe(400);
    });
  });

  // ==========================================================================
  // Body validation
  // ==========================================================================

  describe("message body validation", () => {
    it("accepts a single character and exactly 4000 characters", async () => {
      const one = await send(booker, conversationSend, "x");
      expect(one.body).toBe("x");

      const max = await send(booker, conversationSend, "a".repeat(4000));
      expect((max.body as string).length).toBe(4000);
    });

    it("rejects 4001 characters", async () => {
      const res = await postMessage(booker, conversationSend, "a".repeat(4001), randomUUID());
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects an empty and a whitespace-only body", async () => {
      for (const body of ["", "   ", "\n\n", "\t\t", "\r\n", " \t \n "]) {
        const res = await postMessage(booker, conversationSend, body, randomUUID());
        expect(res.status, JSON.stringify(body)).toBe(400);
      }
    });

    it("rejects a missing or non-string body", async () => {
      const missing = await request(app)
        .post(`/v1/conversations/${conversationSend}/messages`)
        .set(authHeader(booker))
        .send({ client_message_id: randomUUID() });
      expect(missing.status).toBe(400);

      const wrongType = await postMessage(booker, conversationSend, 42, randomUUID());
      expect(wrongType.status).toBe(400);
    });

    it("trims leading and trailing whitespace before storing", async () => {
      const message = await send(booker, conversationSend, "   padded but valid   ");
      expect(message.body).toBe("padded but valid");

      const { data } = await adminClient.from("messages").select("body").eq("id", message.id as string).single();
      expect(data!.body).toBe("padded but valid");
    });

    it("preserves interior newlines verbatim", async () => {
      const text = "line one\nline two\n\nline four";
      const message = await send(booker, conversationSend, `  ${text}  `);
      expect(message.body).toBe(text);
    });

    it("stores potentially dangerous content literally -- never interpreted", async () => {
      const payload = "<script>alert('x')</script> & \" ' -- DROP TABLE messages; --";
      const message = await send(booker, conversationSend, payload);
      expect(message.body).toBe(payload);

      const { data } = await adminClient.from("messages").select("body").eq("id", message.id as string).single();
      expect(data!.body).toBe(payload);
      const { count } = await adminClient.from("messages").select("id", { count: "exact", head: true });
      expect(count).toBeGreaterThan(0); // the table still exists
    });
  });

  // ==========================================================================
  // Identity / security
  // ==========================================================================

  describe("identity and security", () => {
    it("rejects every server-derived field in the body", async () => {
      const bodies: Record<string, unknown>[] = [
        { body: "x", client_message_id: randomUUID(), sender_id: host.id },
        { body: "x", client_message_id: randomUUID(), conversation_id: conversationEmpty },
        { body: "x", client_message_id: randomUUID(), created_at: "2020-01-01T00:00:00Z" },
        { body: "x", client_message_id: randomUUID(), id: randomUUID() },
        { body: "x", client_message_id: randomUUID(), user_id: host.id },
        { body: "x", client_message_id: randomUUID(), unknown_field: true },
      ];
      for (const payload of bodies) {
        const res = await request(app)
          .post(`/v1/conversations/${conversationSend}/messages`)
          .set(authHeader(booker))
          .send(payload);
        expect(res.status, JSON.stringify(payload)).toBe(400);
        expect(res.body.error.code).toBe("VALIDATION_ERROR");
      }
    });

    it("requires client_message_id and rejects a non-UUID one", async () => {
      const missing = await postMessage(booker, conversationSend, "no key");
      expect(missing.status).toBe(400);

      const bad = await postMessage(booker, conversationSend, "bad key", "not-a-uuid");
      expect(bad.status).toBe(400);
    });

    it("a forged sender_id never changes the stored sender", async () => {
      const forged = await request(app)
        .post(`/v1/conversations/${conversationSend}/messages`)
        .set(authHeader(booker))
        .send({ body: "pretending to be the host", client_message_id: randomUUID(), sender_id: host.id });
      expect(forged.status).toBe(400);

      const honest = await send(booker, conversationSend, "honest message");
      const { data } = await adminClient.from("messages").select("sender_id").eq("id", honest.id as string).single();
      expect(data!.sender_id).toBe(booker.id);
      expect(data!.sender_id).not.toBe(host.id);
    });

    it("the path conversation id is authoritative", async () => {
      const message = await send(booker, conversationSend2, "belongs to send2");
      expect(message.conversation_id).toBe(conversationSend2);
      const { data } = await adminClient
        .from("messages")
        .select("conversation_id")
        .eq("id", message.id as string)
        .single();
      expect(data!.conversation_id).toBe(conversationSend2);
    });

    it("Phase 27-2 direct-write refusals still hold -- clients cannot touch messages via PostgREST", async () => {
      const client = createUserScopedClient(booker.accessToken);

      const insert = await client.from("messages").insert({
        conversation_id: conversationSend,
        sender_id: booker.id,
        body: "written straight to PostgREST",
        client_message_id: randomUUID(),
      });
      expect(insert.error?.code).toBe(INSUFFICIENT_PRIVILEGE);

      const update = await client.from("messages").update({ body: "edited" }).eq("id", mainMessageIds[0]!);
      expect(update.error?.code).toBe(INSUFFICIENT_PRIVILEGE);

      const remove = await client.from("messages").delete().eq("id", mainMessageIds[0]!);
      expect(remove.error?.code).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it("the message RPC is SECURITY INVOKER -- RLS still filters it for a non-participant", async () => {
      const client = createUserScopedClient(outsider.accessToken);
      const { data } = await client.rpc("get_conversation_messages", {
        _conversation_id: conversationMain,
        _cursor_created_at: null,
        _cursor_id: null,
        _limit: 100,
      });
      expect(data ?? []).toHaveLength(0);
    });

    it("an admin cannot read messages through the RPC either", async () => {
      const client = createUserScopedClient(admin.accessToken);
      const { data } = await client.rpc("get_conversation_messages", {
        _conversation_id: conversationMain,
        _cursor_created_at: null,
        _cursor_id: null,
        _limit: 100,
      });
      expect(data ?? []).toHaveLength(0);
    });
  });

  // ==========================================================================
  // Idempotency
  // ==========================================================================

  describe("idempotency", () => {
    it("the same client_message_id twice returns the identical message", async () => {
      const key = randomUUID();
      const first = await postMessage(booker, conversationSend, "send once", key);
      const second = await postMessage(booker, conversationSend, "send once", key);

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.body.data.id).toBe(first.body.data.id);
      expect(second.body.data.created_at).toBe(first.body.data.created_at);
      expect(second.body.data.body).toBe(first.body.data.body);
      expect(second.body.data.client_message_id).toBe(key);
    });

    it("a replay with a different body returns the ORIGINAL message -- a retry is not an edit", async () => {
      const key = randomUUID();
      const first = await postMessage(booker, conversationSend, "the original text", key);
      const replay = await postMessage(booker, conversationSend, "a completely different body", key);

      expect(replay.status).toBe(201);
      expect(replay.body.data.id).toBe(first.body.data.id);
      expect(replay.body.data.body).toBe("the original text");
      expect(replay.body.data.created_at).toBe(first.body.data.created_at);
    });

    it("the same key in a different conversation creates a separate message", async () => {
      const key = randomUUID();
      const a = await postMessage(booker, conversationSend, "thread one", key);
      const b = await postMessage(booker, conversationSend2, "thread two", key);
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      expect(b.body.data.id).not.toBe(a.body.data.id);
    });

    it("the same key from the other participant creates a separate message", async () => {
      const key = randomUUID();
      const fromBooker = await postMessage(booker, conversationSend, "from the booker", key);
      const fromHost = await postMessage(host, conversationSend, "from the host", key);
      expect(fromHost.status).toBe(201);
      expect(fromHost.body.data.id).not.toBe(fromBooker.body.data.id);
      expect(fromHost.body.data.sender_id).toBe(host.id);
      expect(fromHost.body.data.body).toBe("from the host");
    });

    it("N concurrent identical sends create exactly one message", async () => {
      const key = randomUUID();
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          request(app)
            .post(`/v1/conversations/${conversationSend}/messages`)
            .set(authHeader(booker))
            .send({ body: "concurrent double tap", client_message_id: key })
        )
      );

      expect(results.every((r) => r.status === 201)).toBe(true);
      const ids = new Set(results.map((r) => r.body.data.id as string));
      expect(ids.size).toBe(1);

      const { data } = await adminClient
        .from("messages")
        .select("id")
        .eq("conversation_id", conversationSend)
        .eq("sender_id", booker.id)
        .eq("client_message_id", key);
      expect(data).toHaveLength(1);
      expect(data![0]!.id).toBe([...ids][0]);
    });
  });

  // ==========================================================================
  // Conversation metadata (the trigger)
  // ==========================================================================

  describe("conversation metadata", () => {
    it("sending advances last_message_id, last_message_at and updated_at", async () => {
      const locationId = await makeLocation(host.id, "Msg Metadata");
      const conversationId = await openConversation(booker, locationId);
      const { data: before } = await adminClient
        .from("conversations")
        .select("last_message_id, last_message_at, updated_at")
        .eq("id", conversationId)
        .single();
      expect(before!.last_message_id).toBeNull();

      await new Promise((r) => setTimeout(r, 30));
      const message = await send(booker, conversationId, "first message in this thread");

      const { data: after } = await adminClient
        .from("conversations")
        .select("last_message_id, last_message_at, updated_at")
        .eq("id", conversationId)
        .single();
      expect(after!.last_message_id).toBe(message.id);
      expect(after!.last_message_at).toBe(message.created_at);
      expect(new Date(after!.updated_at as string).getTime()).toBeGreaterThan(
        new Date(before!.updated_at as string).getTime()
      );
    });

    it("sending moves the conversation to the head of the Inbox", async () => {
      const locationId = await makeLocation(host.id, "Msg Inbox Head");
      const conversationId = await openConversation(booker, locationId);
      await send(booker, conversationId, "newest activity anywhere");

      const inbox = await request(app).get("/v1/conversations?limit=100").set(authHeader(booker));
      expect(inbox.status).toBe(200);
      expect((inbox.body.data as { id: string }[])[0]!.id).toBe(conversationId);
    });

    it("an out-of-order older message cannot move the metadata backwards", async () => {
      const locationId = await makeLocation(host.id, "Msg Monotonic");
      const conversationId = await openConversation(booker, locationId);
      const newest = await send(booker, conversationId, "the newest message");

      // Forced in behind the newest, the way a concurrent insert committing
      // late would arrive.
      await seedMessage(conversationId, host.id, "an older message", new Date(Date.now() - 3_600_000).toISOString());

      const { data } = await adminClient
        .from("conversations")
        .select("last_message_id, last_message_at")
        .eq("id", conversationId)
        .single();
      expect(data!.last_message_id).toBe(newest.id);
      expect(data!.last_message_at).toBe(newest.created_at);
    });
  });

  // ==========================================================================
  // Unpublished listing (Phase 27-3 behaviour preserved)
  // ==========================================================================

  describe("an archived listing does not affect an existing conversation", () => {
    it("messages remain both readable and writable", async () => {
      await send(booker, conversationArchived, "sent while the listing was live");

      const { error } = await adminClient.from("locations").update({ status: "archived" }).eq("id", locationArchived);
      if (error) throw error;

      // Prove the listing really is hidden now, so this passes for the right reason.
      const bookerClient = createUserScopedClient(booker.accessToken);
      const { data: rawLocation } = await bookerClient.from("locations").select("id").eq("id", locationArchived);
      expect(rawLocation).toHaveLength(0);

      const read = await request(app)
        .get(`/v1/conversations/${conversationArchived}/messages`)
        .set(authHeader(booker));
      expect(read.status).toBe(200);
      expect(read.body.data).toHaveLength(1);

      const written = await send(booker, conversationArchived, "sent after it was archived");
      expect(written.conversation_id).toBe(conversationArchived);

      const hostRead = await request(app)
        .get(`/v1/conversations/${conversationArchived}/messages`)
        .set(authHeader(host));
      expect(hostRead.status).toBe(200);
      expect(hostRead.body.data).toHaveLength(2);

      const hostWrite = await send(host, conversationArchived, "the host can still reply");
      expect(hostWrite.sender_id).toBe(host.id);
    });
  });

  // ==========================================================================
  // Phase 27-5: cursor index alignment
  // ==========================================================================

  describe("deep pagination stays index-aligned (Phase 27-5)", () => {
    // This is a QUERY-PLAN regression guard, not a functional one -- every
    // functional property of pagination is already covered above.
    //
    // Phase 27-4 shipped the keyset cursor as an OR-chain, which is correct but
    // which PostgreSQL cannot use as an index range condition under a generic
    // parameterized plan (the plan PostgREST actually gets). It landed in
    // `Filter`, so a deep page rescanned and discarded every newer row --
    // O(offset), the exact thing keyset pagination exists to avoid. Measured
    // before the fix: 158 buffers at a 4,000-row-deep cursor versus 3 for the
    // first page. Phase 27-5 replaced it with a single row comparison using
    // COALESCE sentinels.
    //
    // Asserted STRUCTURALLY -- the cursor predicate must appear inside
    // `Index Cond`, not `Filter` -- rather than against any timing or buffer
    // count. Two things make that the right call:
    //   * EXPLAIN of the function CALL only ever shows `Function Scan` (the
    //     body's LIMIT blocks SQL-function inlining), and that node's buffer
    //     count folds in first-call planning and catalog reads, so it is not a
    //     usable measure of page access.
    //   * Timings and buffer counts drift with the Postgres version, page
    //     layout and cache state. Whether the predicate is a range condition
    //     does not.
    //
    // So the guard is two-part: the shipped function must still be written with
    // the row comparison, and that predicate shape must still plan as an index
    // range condition against the real table and index.
    //
    // Needs raw SQL (EXPLAIN is not reachable through PostgREST/supabase-js) and
    // so shells out to the local stack's container. It skips rather than fails
    // where that is unavailable, because this asserts a plan property, not
    // correctness -- every functional guarantee is covered by the tests above.
    it("the cursor predicate plans as an Index Cond, not a Filter", async () => {
      const { execFileSync } = await import("child_process");

      let container: string;
      try {
        container = execFileSync("docker", ["ps", "--format", "{{.Names}}"], { encoding: "utf8" })
          .split("\n")
          .find((n) => n.startsWith("supabase_db_"))!;
        if (!container) throw new Error("no supabase_db container");
      } catch {
        console.warn("[27-5] skipping plan regression: local Supabase container not reachable");
        return;
      }

      // Self-contained and rolled back: seeds 5,000 messages, measures the real
      // function at a 4,000-deep cursor and at the first page, leaves nothing.
      const sql = `
begin;
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values ('f1000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-000000000000','authenticated','authenticated','p275h@example.com','x',now(),now(),now()),
       ('f2000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-000000000000','authenticated','authenticated','p275b@example.com','x',now(),now(),now());
insert into public.locations (id, host_id, title, city, country, timezone, status)
values ('f3000000-0000-0000-0000-0000000000a3','f1000000-0000-0000-0000-0000000000a1','P275','London','UK','UTC','published');
insert into public.conversations (id, booker_id, location_id, last_message_at)
values ('f4000000-0000-0000-0000-0000000000a4','f2000000-0000-0000-0000-0000000000a2','f3000000-0000-0000-0000-0000000000a3', now() - interval '2 year');
insert into public.messages (conversation_id, sender_id, body, client_message_id, created_at)
select 'f4000000-0000-0000-0000-0000000000a4','f2000000-0000-0000-0000-0000000000a2','m'||g, gen_random_uuid(), now() - (g || ' seconds')::interval
from generate_series(1,5000) g;
analyze public.messages;
select created_at as cts, id as cid from public.messages
where conversation_id='f4000000-0000-0000-0000-0000000000a4'
order by created_at desc, id desc offset 4000 limit 1 \\gset
set plan_cache_mode = force_generic_plan;
-- The predicate exactly as get_conversation_messages() declares it. Prepared
-- with real parameters, because the generic plan is the one PostgREST gets and
-- is the only one in which the OR-chain's failure is visible.
prepare q (uuid, timestamptz, uuid, int) as
 select m.id, m.conversation_id, m.sender_id, m.body, m.client_message_id, m.created_at
 from public.messages m
 where m.conversation_id = $1
   and (m.created_at, m.id) < (coalesce($2,'infinity'::timestamptz), coalesce($3,'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid))
 order by m.created_at desc, m.id desc
 limit greatest(least(coalesce($4,50),101),1);
\\echo MARK_DEEP
explain (analyze, buffers, costs off) execute q('f4000000-0000-0000-0000-0000000000a4', :'cts', :'cid', 51);
rollback;
`;

      const out = execFileSync("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-f", "-"], {
        input: sql,
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      });

      const plan = out.slice(out.indexOf("MARK_DEEP"));

      // The cursor boundary must be part of the index range condition, on the
      // index Phase 27-1 already created.
      expect(plan).toContain("messages_conversation_id_created_at_id_idx");
      expect(plan).toMatch(/Index Cond:[\s\S]*ROW\(created_at, id\)/);

      // ...and must NOT have degraded into a post-scan filter, which is exactly
      // what a revert to the OR-chain -- or to the tempting
      // `_cursor_created_at is null or (...)` form -- would produce.
      expect(plan).not.toMatch(/Filter:[\s\S]*created_at/);
      expect(plan).not.toContain("Rows Removed by Filter");

      // Corroborating guard on the shipped function itself: the predicate must
      // remain a single row comparison, not an OR-chain.
      const def = execFileSync(
        "docker",
        [
          "exec",
          "-i",
          container,
          "psql",
          "-U",
          "postgres",
          "-d",
          "postgres",
          "-Atc",
          "select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='get_conversation_messages';",
        ],
        { encoding: "utf8" }
      );
      // Comments are stripped first: the function body deliberately *describes*
      // the rejected `_cursor_created_at is null or ...` form, so matching the
      // raw text would assert on prose rather than on code.
      const code = def.replace(/--[^\n]*/g, "");
      expect(code).toContain("coalesce(_cursor_created_at");
      expect(code).not.toMatch(/_cursor_created_at\s+is\s+null\s+or/i);
    });
  });
});
