import { execFileSync } from "child_process";
import { randomUUID } from "crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { createUserScopedClient } from "../src/lib/supabase";
import { adminClient, createTestUser, deleteTestUser, TestUser } from "./setup";

// Phase 27-7: read / unread messaging state.
//
// API behaviour through supertest; the guarantees underneath it through real
// Supabase sessions talking to PostgREST directly, the way
// tests/messaging-authorization.test.ts does. The distinction matters more in
// this phase than in any previous one: Phase 27-7's central claim is that a
// read cursor can only ever move FORWARDS, and an invariant enforced only by
// Express is no invariant at all -- a client holding a real Supabase session
// can go around Express entirely. So the monotonicity, the grant revocation
// and the function ACLs are each asserted at the database layer.
//
// Several tests here encode a trap the 27-7 inspection measured rather than
// guessed. Where that is the case the comment says what was measured, so a
// future edit that "simplifies" the assertion knows what it is giving up.

const app = createApp();

const INSUFFICIENT_PRIVILEGE = "42501";

// ---------------------------------------------------------------------------
// Raw SQL access, the tests/messaging-realtime.test.ts pattern.
//
// pg_proc.proacl, pg_trigger and pg_publication_tables are not reachable
// through PostgREST, and this phase makes claims about all three: a DROP'd and
// recreated function's ACL, the absence of any read-state trigger, and the
// Phase 27-6 Realtime posture. Those tests skip rather than fail when Docker
// is unavailable, so the suite still runs in an environment without it.
// ---------------------------------------------------------------------------

const container: string | null = (() => {
  try {
    return (
      execFileSync("docker", ["ps", "--format", "{{.Names}}"], { encoding: "utf8" })
        .split("\n")
        .find((n) => n.startsWith("supabase_db_")) ?? null
    );
  } catch {
    return null;
  }
})();

function sql(query: string): string | null {
  if (!container) return null;
  return execFileSync(
    "docker",
    ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-Atq", "-c", query],
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }
  ).trim();
}

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

async function markRead(user: TestUser, conversationId: string, body: unknown) {
  const res = await request(app)
    .post(`/v1/conversations/${conversationId}/read`)
    .set(authHeader(user))
    .send(body as object);
  return { status: res.status, body: res.body };
}

/** The conversation as its own participant sees it, through the real read model. */
async function conversationDetail(user: TestUser, conversationId: string) {
  const res = await request(app).get(`/v1/conversations/${conversationId}`).set(authHeader(user));
  expect(res.status).toBe(200);
  return res.body.data as Record<string, unknown>;
}

async function unreadCount(user: TestUser, conversationId: string): Promise<number> {
  return (await conversationDetail(user, conversationId)).unread_count as number;
}

async function cursorRow(userId: string, conversationId: string) {
  const { data } = await adminClient
    .from("conversation_reads")
    .select("last_read_at, last_read_message_id")
    .eq("user_id", userId)
    .eq("conversation_id", conversationId)
    .maybeSingle();
  return data;
}

describe("Phase 27-7: read / unread messaging state", () => {
  let host: TestUser;
  let booker: TestUser;
  let outsider: TestUser;
  let admin: TestUser;

  let locationA: string;
  let conversationA: string;
  let otherConversation: string;

  // conversationA: 3 host messages then 1 booker message, strictly ordered.
  let hostMsg1: string;
  let hostMsg2: string;
  let hostMsg3: string;
  let bookerMsg1: string;
  let foreignMessage: string;

  beforeAll(async () => {
    [host, booker, outsider, admin] = await Promise.all([
      createTestUser(),
      createTestUser(),
      createTestUser(),
      createTestUser(),
    ]);
    await grantRole(host, "host");
    await grantRole(booker, "booker");
    await grantRole(outsider, "booker");
    await grantAdmin(admin);

    locationA = await makeLocation(host.id, "Read State Studio");
    conversationA = await openConversation(booker, locationA);

    hostMsg1 = await seedMessage(conversationA, host.id, "h1", "2026-09-01T10:00:00Z");
    hostMsg2 = await seedMessage(conversationA, host.id, "h2", "2026-09-01T11:00:00Z");
    hostMsg3 = await seedMessage(conversationA, host.id, "h3", "2026-09-01T12:00:00Z");
    bookerMsg1 = await seedMessage(conversationA, booker.id, "b1", "2026-09-01T13:00:00Z");

    // A second thread the booker also participates in, so a cross-conversation
    // message id is one they CAN read -- isolating the conversation check from
    // the participation check.
    const locationB = await makeLocation(host.id, "Other Studio");
    otherConversation = await openConversation(booker, locationB);
    foreignMessage = await seedMessage(otherConversation, host.id, "elsewhere", "2026-09-01T10:30:00Z");
  });

  afterAll(async () => {
    await adminClient.from("conversation_reads").delete().in("conversation_id", [conversationA, otherConversation]);
    await adminClient.from("conversations").update({ last_message_id: null }).in("id", [conversationA, otherConversation]);
    await adminClient.from("messages").delete().in("conversation_id", [conversationA, otherConversation]);
    await adminClient.from("conversations").delete().in("id", [conversationA, otherConversation]);
    await Promise.all([deleteTestUser(host.id), deleteTestUser(booker.id), deleteTestUser(outsider.id), deleteTestUser(admin.id)]);
  });

  // --------------------------------------------------------------------------
  // Unread counting
  // --------------------------------------------------------------------------

  describe("unread counts", () => {
    it("with no cursor row at all, every counterparty message is unread", async () => {
      await adminClient.from("conversation_reads").delete().eq("conversation_id", conversationA);
      // 3 host messages; the booker's own message is NOT counted.
      expect(await unreadCount(booker, conversationA)).toBe(3);
    });

    it("the sender's own messages are never unread to them", async () => {
      await adminClient.from("conversation_reads").delete().eq("conversation_id", conversationA);
      // The host sees only the booker's single message.
      expect(await unreadCount(host, conversationA)).toBe(1);
    });

    it("a cursor row that exists but is NULL still means everything is unread", async () => {
      await adminClient.from("conversation_reads").delete().eq("conversation_id", conversationA);
      const { error } = await adminClient
        .from("conversation_reads")
        .insert({ conversation_id: conversationA, user_id: booker.id });
      expect(error).toBeNull();
      expect(await unreadCount(booker, conversationA)).toBe(3);
    });

    it("counts down as the cursor advances: 3 -> 1 -> 0", async () => {
      await adminClient.from("conversation_reads").delete().eq("conversation_id", conversationA);
      expect(await unreadCount(booker, conversationA)).toBe(3);

      expect((await markRead(booker, conversationA, { last_read_message_id: hostMsg2 })).status).toBe(200);
      expect(await unreadCount(booker, conversationA)).toBe(1);

      expect((await markRead(booker, conversationA, { last_read_message_id: bookerMsg1 })).status).toBe(200);
      expect(await unreadCount(booker, conversationA)).toBe(0);
    });

    it("a new message after marking read is unread again", async () => {
      await adminClient.from("conversation_reads").delete().eq("conversation_id", conversationA);
      await markRead(booker, conversationA, { last_read_message_id: bookerMsg1 });
      expect(await unreadCount(booker, conversationA)).toBe(0);

      const fresh = await seedMessage(conversationA, host.id, "after-read", "2026-09-01T14:00:00Z");
      expect(await unreadCount(booker, conversationA)).toBe(1);

      await adminClient.from("conversations").update({ last_message_id: null }).eq("id", conversationA);
      await adminClient.from("messages").delete().eq("id", fresh);
    });

    it("is capped at 100, and the boundary is exact (99 / 100 / far beyond)", async () => {
      // The single most expensive guarantee in this phase: the cap is what
      // bounds the work, not merely the display. Measured uncapped, one long
      // unread thread dominates an entire Inbox page.
      const conv = await openConversation(outsider, await makeLocation(host.id, "Cap Studio"));
      const ids: string[] = [];
      const rows = Array.from({ length: 150 }, (_, i) => ({
        conversation_id: conv,
        sender_id: host.id,
        body: `c${i}`,
        client_message_id: randomUUID(),
        created_at: new Date(Date.UTC(2026, 8, 2, 0, 0, i)).toISOString(),
      }));
      const { data, error } = await adminClient.from("messages").insert(rows).select("id, created_at");
      expect(error).toBeNull();
      data!.forEach((r) => ids.push(r.id as string));

      // 150 unread -> capped
      expect(await unreadCount(outsider, conv)).toBe(100);

      // Leave exactly 100 unread -> reports 100 (indistinguishable from "more").
      const ordered = [...data!].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
      await markRead(outsider, conv, { last_read_message_id: ordered[49].id as string });
      expect(await unreadCount(outsider, conv)).toBe(100);

      // Leave exactly 99 -> reports the exact number, proving 100 is a cap and
      // not an off-by-one that swallows the 100th.
      await markRead(outsider, conv, { last_read_message_id: ordered[50].id as string });
      expect(await unreadCount(outsider, conv)).toBe(99);

      await adminClient.from("conversation_reads").delete().eq("conversation_id", conv);
      await adminClient.from("conversations").update({ last_message_id: null }).eq("id", conv);
      await adminClient.from("messages").delete().in("id", ids);
      await adminClient.from("conversations").delete().eq("id", conv);
    });

    it("is unaffected by which page of messages was fetched", async () => {
      await adminClient.from("conversation_reads").delete().eq("conversation_id", conversationA);
      const before = await unreadCount(booker, conversationA);

      const page = await request(app)
        .get(`/v1/conversations/${conversationA}/messages?limit=1`)
        .set(authHeader(booker));
      expect(page.status).toBe(200);
      expect(page.body.data).toHaveLength(1);

      // Reading history must never advance the cursor -- reading and marking
      // read are separate concepts.
      expect(await unreadCount(booker, conversationA)).toBe(before);
      expect(await cursorRow(booker.id, conversationA)).toBeNull();
    });

    it("still counts on a conversation whose listing has been unpublished", async () => {
      await adminClient.from("conversation_reads").delete().eq("conversation_id", conversationA);
      await adminClient.from("locations").update({ status: "archived" }).eq("id", locationA);

      const detail = await conversationDetail(booker, conversationA);
      expect((detail.location as Record<string, unknown>).status).toBe("archived");
      expect(detail.unread_count).toBe(3);

      await adminClient.from("locations").update({ status: "published" }).eq("id", locationA);
    });

    it("appears in the conversation LIST as well as the detail, with the same value", async () => {
      await adminClient.from("conversation_reads").delete().eq("conversation_id", conversationA);
      await markRead(booker, conversationA, { last_read_message_id: hostMsg1 });

      const list = await request(app).get("/v1/conversations?limit=100").set(authHeader(booker));
      expect(list.status).toBe(200);
      const row = (list.body.data as Array<Record<string, unknown>>).find((c) => c.id === conversationA);
      expect(row).toBeDefined();
      expect(row!.unread_count).toBe(2);
      expect(row!.unread_count).toBe(await unreadCount(booker, conversationA));
    });

    it("is per-viewer: the two participants see different numbers for one thread", async () => {
      await adminClient.from("conversation_reads").delete().eq("conversation_id", conversationA);
      expect(await unreadCount(booker, conversationA)).toBe(3);
      expect(await unreadCount(host, conversationA)).toBe(1);
    });

    it("survives a half-null cursor (the pointed-at message was deleted)", async () => {
      // Measured as reachable: conversation_reads.last_read_message_id is
      // ON DELETE SET NULL, so deleting the message a cursor points at leaves
      // last_read_at standing with a null id. Every comparison coalesces the
      // two halves independently, which is why there is deliberately no CHECK
      // tying them together (decision D-4). This must not crash and must not
      // reset the thread to fully unread.
      await adminClient.from("conversation_reads").delete().eq("conversation_id", conversationA);
      const doomed = await seedMessage(conversationA, host.id, "doomed", "2026-09-01T11:30:00Z");
      await markRead(booker, conversationA, { last_read_message_id: doomed });

      await adminClient.from("conversations").update({ last_message_id: null }).eq("id", conversationA);
      await adminClient.from("messages").delete().eq("id", doomed);

      const row = await cursorRow(booker.id, conversationA);
      expect(row!.last_read_message_id).toBeNull();
      expect(row!.last_read_at).not.toBeNull();

      // h3 and b1 are newer than the retained timestamp; b1 is the booker's own.
      expect(await unreadCount(booker, conversationA)).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // POST /v1/conversations/:id/read
  // --------------------------------------------------------------------------

  describe("POST /v1/conversations/:id/read", () => {
    it("returns 401 without a token", async () => {
      const res = await request(app)
        .post(`/v1/conversations/${conversationA}/read`)
        .send({ last_read_message_id: hostMsg1 });
      expect(res.status).toBe(401);
    });

    it("advances the cursor and returns the resulting state", async () => {
      await adminClient.from("conversation_reads").delete().eq("conversation_id", conversationA);
      const { status, body } = await markRead(booker, conversationA, { last_read_message_id: hostMsg2 });

      expect(status).toBe(200);
      expect(body.data).toEqual({
        conversation_id: conversationA,
        last_read_at: expect.any(String),
        last_read_message_id: hostMsg2,
        unread_count: 1,
      });
      // Exactly four fields -- no id, user_id, created_at or updated_at leaks
      // out of the underlying row.
      expect(Object.keys(body.data).sort()).toEqual([
        "conversation_id",
        "last_read_at",
        "last_read_message_id",
        "unread_count",
      ]);
    });

    it("derives last_read_at from the MESSAGE, never from the wall clock", async () => {
      // The single most important semantic guarantee in this phase. Measured:
      // a wall-clock cursor marks as read a message whose transaction commits
      // after the mark-read but is stamped before it -- one the reader could
      // never have seen. Pinning last_read_at to the message's own created_at
      // is what makes that impossible.
      await adminClient.from("conversation_reads").delete().eq("conversation_id", conversationA);
      const { body } = await markRead(booker, conversationA, { last_read_message_id: hostMsg2 });

      const { data: msg } = await adminClient.from("messages").select("created_at").eq("id", hostMsg2).single();
      expect(new Date(body.data.last_read_at as string).getTime()).toBe(new Date(msg!.created_at as string).getTime());

      // hostMsg2 is seeded in 2026-09; a now() cursor would be far later.
      expect(new Date(body.data.last_read_at as string).getTime()).toBeLessThan(Date.now());
    });

    it("is idempotent: marking the same message twice changes nothing", async () => {
      await adminClient.from("conversation_reads").delete().eq("conversation_id", conversationA);
      const first = await markRead(booker, conversationA, { last_read_message_id: hostMsg2 });
      const second = await markRead(booker, conversationA, { last_read_message_id: hostMsg2 });

      expect(second.status).toBe(200);
      expect(second.body.data).toEqual(first.body.data);
    });

    it("is monotonic: an OLDER message is a 200 no-op that returns the standing cursor", async () => {
      await adminClient.from("conversation_reads").delete().eq("conversation_id", conversationA);
      await markRead(booker, conversationA, { last_read_message_id: hostMsg3 });

      const { status, body } = await markRead(booker, conversationA, { last_read_message_id: hostMsg1 });
      expect(status).toBe(200);
      expect(body.data.last_read_message_id).toBe(hostMsg3);

      const row = await cursorRow(booker.id, conversationA);
      expect(row!.last_read_message_id).toBe(hostMsg3);
    });

    it("returns 404 for a conversation that does not exist", async () => {
      const { status } = await markRead(booker, randomUUID(), { last_read_message_id: hostMsg1 });
      expect(status).toBe(404);
    });

    it("returns 404 for a non-participant, and writes nothing", async () => {
      const { status } = await markRead(outsider, conversationA, { last_read_message_id: hostMsg1 });
      expect(status).toBe(404);
      expect(await cursorRow(outsider.id, conversationA)).toBeNull();
    });

    it("returns 404 for an admin who is not a participant, and gives them no cursor", async () => {
      // Admin access to correspondence is the separate, audited
      // admin_message_access path. An admin must never acquire or advance a
      // participant's read state merely by touching a conversation.
      const { status } = await markRead(admin, conversationA, { last_read_message_id: hostMsg1 });
      expect(status).toBe(404);
      expect(await cursorRow(admin.id, conversationA)).toBeNull();
    });

    it("returns 404 for a message that does not exist", async () => {
      const { status } = await markRead(booker, conversationA, { last_read_message_id: randomUUID() });
      expect(status).toBe(404);
    });

    it("returns 404 for a message from a DIFFERENT conversation the caller can read", async () => {
      // The booker participates in both threads, so RLS alone would let them
      // read `foreignMessage` -- this isolates the same-conversation rule from
      // the participation rule.
      await adminClient.from("conversation_reads").delete().eq("conversation_id", conversationA);
      const { status } = await markRead(booker, conversationA, { last_read_message_id: foreignMessage });
      expect(status).toBe(404);
      expect(await cursorRow(booker.id, conversationA)).toBeNull();
    });

    it("does not move an EXISTING cursor when the message id is invalid", async () => {
      // The failure mode this guards: the database function answers "nothing
      // to do" with the standing row, so a service that did not validate the
      // message would report an invalid request as a successful no-op.
      await adminClient.from("conversation_reads").delete().eq("conversation_id", conversationA);
      await markRead(booker, conversationA, { last_read_message_id: hostMsg2 });

      expect((await markRead(booker, conversationA, { last_read_message_id: randomUUID() })).status).toBe(404);
      expect((await markRead(booker, conversationA, { last_read_message_id: foreignMessage })).status).toBe(404);

      const row = await cursorRow(booker.id, conversationA);
      expect(row!.last_read_message_id).toBe(hostMsg2);
    });

    it("returns 400 for a malformed conversation id", async () => {
      const res = await request(app)
        .post("/v1/conversations/not-a-uuid/read")
        .set(authHeader(booker))
        .send({ last_read_message_id: hostMsg1 });
      expect(res.status).toBe(400);
    });

    it("returns 400 for a malformed, missing or null message id", async () => {
      expect((await markRead(booker, conversationA, { last_read_message_id: "nope" })).status).toBe(400);
      expect((await markRead(booker, conversationA, {})).status).toBe(400);
      expect((await markRead(booker, conversationA, { last_read_message_id: null })).status).toBe(400);
    });

    it("returns 400 for a client-supplied last_read_at -- it must never be accepted", async () => {
      // Not merely "ignored". A client that sends a timestamp and gets a 200
      // would believe it had set a cursor position it had not, and an accepted
      // `infinity` would zero that user's unread count permanently.
      const res = await markRead(booker, conversationA, {
        last_read_message_id: hostMsg1,
        last_read_at: "infinity",
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 for any other extra body field", async () => {
      for (const extra of [{ user_id: randomUUID() }, { conversation_id: randomUUID() }, { unread_count: 0 }]) {
        const res = await markRead(booker, conversationA, { last_read_message_id: hostMsg1, ...extra });
        expect(res.status).toBe(400);
      }
    });

    it("works for the HOST side of a thread, with no role requirement", async () => {
      await adminClient.from("conversation_reads").delete().eq("conversation_id", conversationA);
      const { status, body } = await markRead(host, conversationA, { last_read_message_id: bookerMsg1 });
      expect(status).toBe(200);
      expect(body.data.unread_count).toBe(0);
      expect(await unreadCount(host, conversationA)).toBe(0);
    });

    it("keeps the two participants' cursors independent", async () => {
      await adminClient.from("conversation_reads").delete().eq("conversation_id", conversationA);
      await markRead(booker, conversationA, { last_read_message_id: hostMsg3 });

      expect(await cursorRow(host.id, conversationA)).toBeNull();
      expect(await unreadCount(host, conversationA)).toBe(1);
      expect(await unreadCount(booker, conversationA)).toBe(0);
    });

    it("stays monotonic under concurrent requests", async () => {
      await adminClient.from("conversation_reads").delete().eq("conversation_id", conversationA);
      const results = await Promise.all([
        markRead(booker, conversationA, { last_read_message_id: hostMsg1 }),
        markRead(booker, conversationA, { last_read_message_id: bookerMsg1 }),
        markRead(booker, conversationA, { last_read_message_id: hostMsg2 }),
        markRead(booker, conversationA, { last_read_message_id: hostMsg3 }),
      ]);
      results.forEach((r) => expect(r.status).toBe(200));

      // The newest wins regardless of completion order: ON CONFLICT DO UPDATE
      // re-evaluates its guard against the latest COMMITTED row, not the
      // transaction snapshot, so a slower older writer cannot overwrite it.
      const row = await cursorRow(booker.id, conversationA);
      expect(row!.last_read_message_id).toBe(bookerMsg1);
      expect(await unreadCount(booker, conversationA)).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // Ordering: (created_at, id), never created_at alone
  // --------------------------------------------------------------------------

  describe("cursor ordering", () => {
    it("resolves an exact created_at tie by message id", async () => {
      // Ties are rare (one insert per transaction) but reachable, and a
      // timestamp-only cursor would treat the two as interchangeable.
      const tie = "2026-09-05T09:00:00Z";
      const a = await seedMessage(conversationA, host.id, "tie-a", tie);
      const b = await seedMessage(conversationA, host.id, "tie-b", tie);
      const [low, high] = [a, b].sort();

      await adminClient.from("conversation_reads").delete().eq("conversation_id", conversationA);
      expect((await markRead(booker, conversationA, { last_read_message_id: high })).status).toBe(200);

      // Same timestamp, smaller uuid -> strictly older -> refused.
      const back = await markRead(booker, conversationA, { last_read_message_id: low });
      expect(back.status).toBe(200);
      expect(back.body.data.last_read_message_id).toBe(high);

      // ...and forwards across the tie is accepted from the low side.
      await adminClient.from("conversation_reads").delete().eq("conversation_id", conversationA);
      await markRead(booker, conversationA, { last_read_message_id: low });
      const fwd = await markRead(booker, conversationA, { last_read_message_id: high });
      expect(fwd.body.data.last_read_message_id).toBe(high);

      await adminClient.from("conversations").update({ last_message_id: null }).eq("id", conversationA);
      await adminClient.from("messages").delete().in("id", [a, b]);
    });

    it("advancing from a NULL cursor row succeeds -- the COALESCE-sentinel guard", async () => {
      // The measured trap: `(excluded…) > (existing…)` is NULL, not true, when
      // the existing cursor is NULL, so a naive guard silently discards the
      // user's FIRST mark-read and the thread stays unread forever.
      await adminClient.from("conversation_reads").delete().eq("conversation_id", conversationA);
      const { error } = await adminClient
        .from("conversation_reads")
        .insert({ conversation_id: conversationA, user_id: booker.id });
      expect(error).toBeNull();

      const { status, body } = await markRead(booker, conversationA, { last_read_message_id: hostMsg2 });
      expect(status).toBe(200);
      expect(body.data.last_read_message_id).toBe(hostMsg2);

      const row = await cursorRow(booker.id, conversationA);
      expect(row!.last_read_at).not.toBeNull();
    });

    it("advances from a half-null cursor rather than refusing forever", async () => {
      await adminClient.from("conversation_reads").delete().eq("conversation_id", conversationA);
      const { error } = await adminClient.from("conversation_reads").insert({
        conversation_id: conversationA,
        user_id: booker.id,
        last_read_at: "2026-09-01T10:30:00Z",
        last_read_message_id: null,
      });
      expect(error).toBeNull();

      const { status, body } = await markRead(booker, conversationA, { last_read_message_id: hostMsg3 });
      expect(status).toBe(200);
      expect(body.data.last_read_message_id).toBe(hostMsg3);
    });
  });

  // --------------------------------------------------------------------------
  // Database-layer guarantees -- what a client cannot do by going around Express
  // --------------------------------------------------------------------------

  describe("database-layer read-state authorization", () => {
    it("authenticated has NO INSERT grant on conversation_reads (Phase 27-7)", async () => {
      // Phase 27-1 modelled this table as self-service, which left it the only
      // messaging table a client could write -- and measurably allowed a client
      // to move its own cursor BACKWARDS. Monotonicity is only a guarantee once
      // the grant is gone.
      const client = createUserScopedClient(booker.accessToken);
      const { error } = await client
        .from("conversation_reads")
        .insert({ conversation_id: conversationA, user_id: booker.id, last_read_message_id: hostMsg1 });
      expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it("authenticated has NO UPDATE grant -- a cursor cannot be moved backwards directly", async () => {
      await adminClient.from("conversation_reads").delete().eq("conversation_id", conversationA);
      await markRead(booker, conversationA, { last_read_message_id: hostMsg3 });

      const client = createUserScopedClient(booker.accessToken);
      const { error } = await client
        .from("conversation_reads")
        .update({ last_read_at: "2020-01-01T00:00:00Z", last_read_message_id: hostMsg1 })
        .eq("conversation_id", conversationA)
        .eq("user_id", booker.id);
      expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE);

      const row = await cursorRow(booker.id, conversationA);
      expect(row!.last_read_message_id).toBe(hostMsg3);
    });

    it("authenticated has NO DELETE grant -- deleting the row would reset unread state", async () => {
      // Deleting the cursor is the MAXIMAL backwards move: it returns the
      // thread to "nothing read". Revoking INSERT/UPDATE without DELETE would
      // close the front door and leave the back one open. Measured: before
      // this revoke, an authenticated participant's DELETE returned DELETE 1.
      await adminClient.from("conversation_reads").delete().eq("conversation_id", conversationA);
      await markRead(booker, conversationA, { last_read_message_id: hostMsg3 });

      const client = createUserScopedClient(booker.accessToken);
      const { error } = await client
        .from("conversation_reads")
        .delete()
        .eq("conversation_id", conversationA)
        .eq("user_id", booker.id);
      expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE);

      expect((await cursorRow(booker.id, conversationA))!.last_read_message_id).toBe(hostMsg3);
    });

    it("a participant can still READ their own cursor, and only their own", async () => {
      await adminClient.from("conversation_reads").delete().eq("conversation_id", conversationA);
      await markRead(booker, conversationA, { last_read_message_id: hostMsg2 });
      await markRead(host, conversationA, { last_read_message_id: bookerMsg1 });

      const client = createUserScopedClient(booker.accessToken);
      const { data } = await client.from("conversation_reads").select("user_id, last_read_message_id");
      expect(data!.every((r) => r.user_id === booker.id)).toBe(true);
      expect(data!.some((r) => r.last_read_message_id === hostMsg2)).toBe(true);
    });

    it("mark_conversation_read() refuses a non-participant at the database layer", async () => {
      // Not merely 404 from Express: the function authorizes independently, so
      // a client calling the RPC directly gets nothing.
      const client = createUserScopedClient(outsider.accessToken);
      const { data, error } = await client.rpc("mark_conversation_read", {
        _conversation_id: conversationA,
        _message_id: hostMsg1,
      });
      expect(error).toBeNull();
      expect(data).toEqual([]);
      expect(await cursorRow(outsider.id, conversationA)).toBeNull();
    });

    it("mark_conversation_read() cannot be aimed at another user -- it takes no user id", async () => {
      const client = createUserScopedClient(outsider.accessToken);
      const { error } = await client.rpc("mark_conversation_read", {
        _conversation_id: conversationA,
        _message_id: hostMsg1,
        _user_id: booker.id,
      });
      // No such parameter exists, so PostgREST cannot resolve the function.
      expect(error).not.toBeNull();
    });

    it("mark_conversation_read() refuses a cross-conversation message at the database layer", async () => {
      await adminClient.from("conversation_reads").delete().eq("conversation_id", conversationA);
      const client = createUserScopedClient(booker.accessToken);
      const { error } = await client.rpc("mark_conversation_read", {
        _conversation_id: conversationA,
        _message_id: foreignMessage,
      });
      expect(error).toBeNull();
      // No row was created: the insert-select matched nothing.
      expect(await cursorRow(booker.id, conversationA)).toBeNull();
    });

    it("anon can neither read nor write read state", async () => {
      const client = createUserScopedClient("");
      const { data } = await client.from("conversation_reads").select("id");
      expect(data ?? []).toHaveLength(0);

      const { error } = await client.rpc("mark_conversation_read", {
        _conversation_id: conversationA,
        _message_id: hostMsg1,
      });
      expect(error).not.toBeNull();
    });

    it("deleting a conversation cascades its read cursors away", async () => {
      const conv = await openConversation(outsider, await makeLocation(host.id, "Cascade Studio"));
      const msg = await seedMessage(conv, host.id, "x", "2026-09-06T10:00:00Z");
      await markRead(outsider, conv, { last_read_message_id: msg });
      expect(await cursorRow(outsider.id, conv)).not.toBeNull();

      await adminClient.from("conversations").update({ last_message_id: null }).eq("id", conv);
      await adminClient.from("messages").delete().eq("conversation_id", conv);
      await adminClient.from("conversations").delete().eq("id", conv);

      expect(await cursorRow(outsider.id, conv)).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Function ACLs -- DROP FUNCTION discards them, so they are asserted
  // --------------------------------------------------------------------------

  describe("function privileges", () => {
    it("both functions grant EXECUTE to authenticated and service_role ONLY", () => {
      // Phase 27-7 had to DROP and recreate get_conversations_for_viewer to add
      // unread_count (PostgreSQL cannot change a RETURNS TABLE return type in
      // place), and DROP discards the ACL. Two separate revokes are required
      // and both are asserted here:
      //
      //   * FROM public -- the default EXECUTE a new function is created with.
      //   * FROM anon   -- Supabase ships ALTER DEFAULT PRIVILEGES ... GRANT
      //                    ALL ON FUNCTIONS TO anon, authenticated,
      //                    service_role, which lands as a DIRECT grant to anon.
      //                    Revoking from PUBLIC does not remove it. Phase 27-3
      //                    revoked only from PUBLIC, so anon in fact held
      //                    EXECUTE on the Inbox read model in every freshly
      //                    built database until this phase.
      if (!container) return;
      for (const fn of ["get_conversations_for_viewer", "mark_conversation_read"]) {
        const acl = sql(
          `select coalesce(array_to_string(proacl, ','), '<default:PUBLIC>') from pg_proc where proname = '${fn}';`
        );
        expect(acl, `${fn} ACL`).not.toBe("<default:PUBLIC>");
        expect(acl, `${fn} must not grant anon`).not.toContain("anon=");
        // A bare `=X/` entry is the PUBLIC grant.
        expect(acl!.split(",").some((e) => e.startsWith("=")), `${fn} must not grant PUBLIC`).toBe(false);
        expect(acl, `${fn} must grant authenticated`).toContain("authenticated=X");
        expect(acl, `${fn} must grant service_role`).toContain("service_role=X");
      }
    });

    it("authenticated holds SELECT and nothing else on conversation_reads", () => {
      if (!container) return;
      for (const [priv, expected] of [
        ["SELECT", "t"],
        ["INSERT", "f"],
        ["UPDATE", "f"],
        ["DELETE", "f"],
      ] as const) {
        expect(
          sql(`select has_table_privilege('authenticated','public.conversation_reads','${priv}');`),
          `authenticated ${priv}`
        ).toBe(expected);
      }
      // service_role keeps full DML -- mark_conversation_read() is SECURITY
      // DEFINER and the backend's admin client relies on it.
      expect(sql(`select has_table_privilege('service_role','public.conversation_reads','UPDATE');`)).toBe("t");
    });

    it("anon cannot execute either messaging read-state function", async () => {
      const client = createUserScopedClient("");
      const list = await client.rpc("get_conversations_for_viewer", {
        _cursor_last_message_at: null,
        _cursor_id: null,
        _limit: 20,
        _conversation_id: null,
      });
      expect(list.error).not.toBeNull();

      const mark = await client.rpc("mark_conversation_read", {
        _conversation_id: conversationA,
        _message_id: hostMsg1,
      });
      expect(mark.error).not.toBeNull();
    });

    it("authenticated CAN execute both, so the revoke did not overshoot", async () => {
      const client = createUserScopedClient(booker.accessToken);
      const list = await client.rpc("get_conversations_for_viewer", {
        _cursor_last_message_at: null,
        _cursor_id: null,
        _limit: 20,
        _conversation_id: conversationA,
      });
      expect(list.error).toBeNull();
      expect(list.data).toHaveLength(1);
    });
  });

  // --------------------------------------------------------------------------
  // Phase 27-6 regression -- read state must add no Realtime surface
  // --------------------------------------------------------------------------

  describe("Realtime invariants still hold (Phase 27-6 regression)", () => {
    it("conversation_reads carries no broadcast trigger -- only its updated_at one", () => {
      // Decision D-6: read state is NOT broadcast. Option A. If a future phase
      // wants read receipts, that is a product decision with privacy weight,
      // not something to acquire as a side effect of unread counts.
      if (!container) return;
      expect(
        sql(
          `select coalesce(string_agg(tgname, ',' order by tgname), '') from pg_trigger
             where not tgisinternal and tgrelid = 'public.conversation_reads'::regclass;`
        )
      ).toBe("set_conversation_reads_updated_at");
    });

    it("no read.updated event exists anywhere, and no new realtime.send() caller was added", () => {
      if (!container) return;
      // Exactly one function calls realtime.send(): the Phase 27-6 publisher.
      expect(
        sql(
          `select coalesce(string_agg(p.proname, ',' order by p.proname), '') from pg_proc p
             join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.prosrc like '%realtime.send%';`
        )
      ).toBe("broadcast_message_created");
      expect(
        sql(
          `select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.prosrc like '%read.updated%';`
        )
      ).toBe("0");
    });

    it("realtime.messages still has no INSERT policy, and its SELECT policy is untouched", () => {
      if (!container) return;
      expect(
        sql(`select count(*) from pg_policies where schemaname='realtime' and tablename='messages' and cmd <> 'SELECT';`)
      ).toBe("0");
      expect(
        sql(`select coalesce(string_agg(policyname, ','), '') from pg_policies where schemaname='realtime' and tablename='messages';`)
      ).toBe("messaging_broadcast_participant_select");
    });

    it("the supabase_realtime publication is still empty and messages still has its two triggers", () => {
      if (!container) return;
      expect(
        sql(`select coalesce(string_agg(tablename, ','), '') from pg_publication_tables where pubname='supabase_realtime';`)
      ).toBe("");
      expect(
        sql(
          `select string_agg(tgname, ',' order by tgname) from pg_trigger
             where not tgisinternal and tgrelid='public.messages'::regclass;`
        )
      ).toBe("on_message_created,on_message_created_broadcast");
    });

    it("Phase 27-7 added no index -- the unread predicate rides the existing one", () => {
      if (!container) return;
      expect(sql(`select count(*) from pg_indexes where schemaname='public' and tablename='messages';`)).toBe("3");
      expect(sql(`select count(*) from pg_indexes where schemaname='public' and tablename='conversation_reads';`)).toBe("3");
    });
  });
});
