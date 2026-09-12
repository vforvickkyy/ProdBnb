import { randomUUID } from "crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { anonClient, createUserScopedClient } from "../src/lib/supabase";
import { adminClient, createTestUser, deleteTestUser, TestUser } from "./setup";

// Phase 27-2: messaging AUTHORIZATION, proven at the database layer.
//
// Every assertion below goes through a real Supabase session talking to
// PostgREST directly, bypassing this backend's Express app entirely -- the
// standard tests/hardening.test.ts established. That distinction is the whole
// point of this phase: there is no messaging API yet, so "the API rejects it"
// is not available as an excuse, and once there IS one, a client can still go
// around it. The database has to refuse on its own.
//
// Two properties get the most attention here because they are the ones most
// easily broken by a well-meaning future edit:
//   1. `messages` has NO authenticated write grant of any kind, so sender_id,
//      conversation_id, created_at, client_message_id and body are all
//      unforgeable rather than merely validated.
//   2. An admin gets NOTHING from the participant policies. Admin access to
//      private correspondence is a separate, audited path (admin_message_access
//      plus a later Admin Messaging service), never an invisible widening of an
//      ordinary participant read.

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

async function createPublishedLocation(owner: TestUser, title: string): Promise<string> {
  const res = await request(app)
    .post("/v1/locations")
    .set(authHeader(owner))
    .send({ title, city: "London", country: "UK", timezone: "UTC" });
  expect(res.status).toBe(201);
  const locationId = res.body.data.id as string;
  const { error } = await adminClient.from("locations").update({ status: "published" }).eq("id", locationId);
  if (error) throw error;
  return locationId;
}

/** Created the way the future service layer will: service-role, after authorization. */
async function createConversation(bookerId: string, locationId: string): Promise<string> {
  const { data, error } = await adminClient
    .from("conversations")
    .insert({ booker_id: bookerId, location_id: locationId })
    .select("id")
    .single();
  if (error) throw error;
  return data!.id as string;
}

async function insertMessage(conversationId: string, senderId: string, body: string): Promise<string> {
  const { data, error } = await adminClient
    .from("messages")
    .insert({ conversation_id: conversationId, sender_id: senderId, body, client_message_id: randomUUID() })
    .select("id")
    .single();
  if (error) throw error;
  return data!.id as string;
}

describe("Phase 27-2: messaging authorization at the database layer", () => {
  let host: TestUser;
  let booker: TestUser;
  let outsider: TestUser;
  let admin: TestUser;

  let locationA: string;
  let locationB: string;
  let conversationA: string;
  let conversationB: string;
  let bookerMessageA: string;
  let hostMessageA: string;
  let messageB: string;

  beforeAll(async () => {
    host = await createTestUser();
    booker = await createTestUser();
    outsider = await createTestUser();
    admin = await createTestUser();
    await grantRole(host, "host");
    await grantRole(booker, "booker");
    await grantRole(outsider, "booker");
    await grantAdmin(admin);

    locationA = await createPublishedLocation(host, "Authz Listing A");
    locationB = await createPublishedLocation(host, "Authz Listing B");

    // The booker participates in BOTH threads -- so the cross-conversation
    // cursor test below isolates the new constraint from the participation one.
    conversationA = await createConversation(booker.id, locationA);
    conversationB = await createConversation(booker.id, locationB);

    bookerMessageA = await insertMessage(conversationA, booker.id, "Booker asking about availability");
    hostMessageA = await insertMessage(conversationA, host.id, "Host replying with dates");
    messageB = await insertMessage(conversationB, booker.id, "A different listing entirely");
  });

  afterAll(async () => {
    await deleteTestUser(booker.id); // cascades both conversations away first
    await deleteTestUser(outsider.id);
    await deleteTestUser(admin.id);
    await adminClient.from("locations").delete().in("id", [locationA, locationB]);
    await deleteTestUser(host.id);
  });

  // --------------------------------------------------------------------------
  // is_conversation_participant()
  // --------------------------------------------------------------------------

  describe("is_conversation_participant()", () => {
    it("is true for the booker and for the listing's host", async () => {
      for (const participant of [booker, host]) {
        const client = createUserScopedClient(participant.accessToken);
        const { data, error } = await client.rpc("is_conversation_participant", {
          _conversation_id: conversationA,
        });
        expect(error).toBeNull();
        expect(data, `${participant.email} should be a participant`).toBe(true);
      }
    });

    it("is false for a third party", async () => {
      const client = createUserScopedClient(outsider.accessToken);
      const { data } = await client.rpc("is_conversation_participant", { _conversation_id: conversationA });
      expect(data).toBe(false);
    });

    it("is false for an admin who is not a participant", async () => {
      const client = createUserScopedClient(admin.accessToken);
      const { data } = await client.rpc("is_conversation_participant", { _conversation_id: conversationA });
      expect(data).toBe(false);
    });

    it("fails closed for an unauthenticated caller", async () => {
      const { data } = await anonClient.rpc("is_conversation_participant", { _conversation_id: conversationA });
      expect(data).toBe(false);
    });

    it("fails closed for a conversation that does not exist", async () => {
      const client = createUserScopedClient(booker.accessToken);
      const { data } = await client.rpc("is_conversation_participant", { _conversation_id: randomUUID() });
      expect(data).toBe(false);
    });

    it("takes no user id -- there is no caller-supplied identity to trust", async () => {
      // A second overload accepting an arbitrary _user_id would let anyone probe
      // anyone else's membership. Assert the single-argument signature is the
      // only one that exists.
      const { data, error } = await adminClient.rpc("is_conversation_participant", {
        _conversation_id: conversationA,
        _user_id: booker.id,
      });
      expect(error).toBeTruthy();
      expect(data).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Participant reads
  // --------------------------------------------------------------------------

  describe("participant access", () => {
    it("the booker can read their own conversation and its messages", async () => {
      const client = createUserScopedClient(booker.accessToken);

      const { data: conversations, error } = await client.from("conversations").select("id").eq("id", conversationA);
      expect(error).toBeNull();
      expect(conversations).toHaveLength(1);

      const { data: messages } = await client
        .from("messages")
        .select("id")
        .eq("conversation_id", conversationA);
      expect(messages?.map((m) => m.id).sort()).toEqual([bookerMessageA, hostMessageA].sort());
    });

    it("the host can read the conversation on their listing and its messages", async () => {
      const client = createUserScopedClient(host.accessToken);

      const { data: conversations, error } = await client.from("conversations").select("id").eq("id", conversationA);
      expect(error).toBeNull();
      expect(conversations).toHaveLength(1);

      const { data: messages } = await client
        .from("messages")
        .select("id")
        .eq("conversation_id", conversationA);
      expect(messages).toHaveLength(2);
    });

    it("a participant sees both sides of the thread, not only their own messages", async () => {
      const client = createUserScopedClient(host.accessToken);
      const { data } = await client.from("messages").select("sender_id").eq("conversation_id", conversationA);
      const senders = new Set((data ?? []).map((m) => m.sender_id as string));
      expect(senders).toEqual(new Set([booker.id, host.id]));
    });
  });

  // --------------------------------------------------------------------------
  // Third-party denial
  // --------------------------------------------------------------------------

  describe("third-party denial", () => {
    it("a third user sees zero conversation rows and zero message rows", async () => {
      const client = createUserScopedClient(outsider.accessToken);

      const { data: byId, error: conversationError } = await client
        .from("conversations")
        .select("id")
        .eq("id", conversationA);
      expect(conversationError).toBeNull();
      expect(byId).toHaveLength(0);

      // Unfiltered too -- not just "can't fetch that id", but "has nothing".
      const { data: all } = await client.from("conversations").select("id");
      expect(all).toHaveLength(0);

      const { data: messages } = await client.from("messages").select("id").eq("conversation_id", conversationA);
      expect(messages).toHaveLength(0);

      const { data: allMessages } = await client.from("messages").select("id");
      expect(allMessages).toHaveLength(0);
    });

    it("a third user cannot reach a specific message even knowing its id", async () => {
      const client = createUserScopedClient(outsider.accessToken);
      const { data } = await client.from("messages").select("id, body").eq("id", hostMessageA);
      expect(data).toHaveLength(0);
    });

    it("anon sees nothing on any messaging table", async () => {
      for (const table of ["conversations", "messages", "conversation_reads", "admin_message_access"]) {
        const { data } = await anonClient.from(table).select("id");
        expect(data ?? [], `anon must not read ${table}`).toHaveLength(0);
      }
    });
  });

  // --------------------------------------------------------------------------
  // Admin participant isolation -- the load-bearing assertion of this phase
  // --------------------------------------------------------------------------

  describe("admin participant isolation", () => {
    it("an admin's normal scoped client sees zero conversations and zero messages", async () => {
      const client = createUserScopedClient(admin.accessToken);

      const { data: conversations, error } = await client.from("conversations").select("id");
      expect(error).toBeNull();
      expect(conversations).toHaveLength(0);

      const { data: messages } = await client.from("messages").select("id");
      expect(messages).toHaveLength(0);
    });

    it("an admin cannot read a specific conversation or message by id either", async () => {
      const client = createUserScopedClient(admin.accessToken);

      const { data: conversation } = await client.from("conversations").select("id").eq("id", conversationA);
      expect(conversation).toHaveLength(0);

      const { data: message } = await client.from("messages").select("id, body").eq("id", hostMessageA);
      expect(message).toHaveLength(0);
    });

    it("an admin cannot read another user's read cursor", async () => {
      const { data: cursor } = await adminClient
        .from("conversation_reads")
        .insert({ conversation_id: conversationA, user_id: booker.id })
        .select("id")
        .single();

      const client = createUserScopedClient(admin.accessToken);
      const { data } = await client.from("conversation_reads").select("id").eq("id", cursor!.id);
      expect(data).toHaveLength(0);

      await adminClient.from("conversation_reads").delete().eq("id", cursor!.id);
    });
  });

  // --------------------------------------------------------------------------
  // Direct message writes -- refused by the database, not by an API
  // --------------------------------------------------------------------------

  describe("direct message writes", () => {
    it("a participant cannot INSERT a message", async () => {
      const client = createUserScopedClient(booker.accessToken);
      const { error } = await client.from("messages").insert({
        conversation_id: conversationA,
        sender_id: booker.id,
        body: "written straight to PostgREST",
        client_message_id: randomUUID(),
      });
      expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE);

      const { data: unchanged } = await adminClient
        .from("messages")
        .select("id")
        .eq("conversation_id", conversationA);
      expect(unchanged).toHaveLength(2);
    });

    it("a participant cannot forge sender_id, created_at or client_message_id", async () => {
      const client = createUserScopedClient(booker.accessToken);
      const { error } = await client.from("messages").insert({
        conversation_id: conversationA,
        sender_id: host.id, // impersonation
        body: "pretending to be the host, backdated",
        client_message_id: randomUUID(),
        created_at: "2020-01-01T00:00:00Z", // backdating
      });
      expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it("a host cannot insert a message into a conversation on someone else's listing", async () => {
      const client = createUserScopedClient(outsider.accessToken);
      const { error } = await client.from("messages").insert({
        conversation_id: conversationA,
        sender_id: outsider.id,
        body: "not my conversation",
        client_message_id: randomUUID(),
      });
      expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it("a participant cannot UPDATE a message", async () => {
      const client = createUserScopedClient(booker.accessToken);
      const { error } = await client
        .from("messages")
        .update({ body: "edited after the fact" })
        .eq("id", bookerMessageA);
      expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE);

      const { data } = await adminClient.from("messages").select("body").eq("id", bookerMessageA).single();
      expect(data!.body).toBe("Booker asking about availability");
    });

    it("a participant cannot DELETE a message", async () => {
      const client = createUserScopedClient(booker.accessToken);
      const { error } = await client.from("messages").delete().eq("id", bookerMessageA);
      expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE);

      const { data } = await adminClient.from("messages").select("id").eq("id", bookerMessageA);
      expect(data).toHaveLength(1);
    });

    it("an admin's scoped client cannot write messages either", async () => {
      const client = createUserScopedClient(admin.accessToken);

      const { error: insertError } = await client.from("messages").insert({
        conversation_id: conversationA,
        sender_id: admin.id,
        body: "admin injecting a message",
        client_message_id: randomUUID(),
      });
      expect(insertError?.code).toBe(INSUFFICIENT_PRIVILEGE);

      const { error: updateError } = await client
        .from("messages")
        .update({ body: "moderated" })
        .eq("id", bookerMessageA);
      expect(updateError?.code).toBe(INSUFFICIENT_PRIVILEGE);

      const { error: deleteError } = await client.from("messages").delete().eq("id", bookerMessageA);
      expect(deleteError?.code).toBe(INSUFFICIENT_PRIVILEGE);
    });
  });

  // --------------------------------------------------------------------------
  // Direct conversation writes
  // --------------------------------------------------------------------------

  describe("direct conversation writes", () => {
    it("a booker cannot INSERT a conversation, even for themselves", async () => {
      const client = createUserScopedClient(booker.accessToken);
      const freshLocation = await createPublishedLocation(host, "Authz Listing C");

      const { error } = await client
        .from("conversations")
        .insert({ booker_id: booker.id, location_id: freshLocation });
      expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE);

      await adminClient.from("locations").delete().eq("id", freshLocation);
    });

    it("a participant cannot UPDATE a conversation", async () => {
      const client = createUserScopedClient(booker.accessToken);
      const { error } = await client
        .from("conversations")
        .update({ last_message_at: new Date().toISOString() })
        .eq("id", conversationA);
      expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it("a participant cannot DELETE a conversation", async () => {
      const client = createUserScopedClient(booker.accessToken);
      const { error } = await client.from("conversations").delete().eq("id", conversationA);
      expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE);

      const { data } = await adminClient.from("conversations").select("id").eq("id", conversationA);
      expect(data).toHaveLength(1);
    });

    it("a host cannot re-point a conversation at a different listing", async () => {
      const client = createUserScopedClient(host.accessToken);
      const { error } = await client
        .from("conversations")
        .update({ location_id: locationB })
        .eq("id", conversationA);
      expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE);
    });
  });

  // --------------------------------------------------------------------------
  // Read cursor
  // --------------------------------------------------------------------------

  describe("read cursor", () => {
    it("a participant can create, read and update their own cursor", async () => {
      const client = createUserScopedClient(booker.accessToken);

      const { data: created, error: insertError } = await client
        .from("conversation_reads")
        .insert({ conversation_id: conversationA, user_id: booker.id, last_read_message_id: hostMessageA })
        .select("id, last_read_message_id")
        .single();
      expect(insertError).toBeNull();
      expect(created!.last_read_message_id).toBe(hostMessageA);

      const { data: read } = await client.from("conversation_reads").select("id").eq("id", created!.id);
      expect(read).toHaveLength(1);

      const { error: updateError } = await client
        .from("conversation_reads")
        .update({ last_read_at: new Date().toISOString(), last_read_message_id: bookerMessageA })
        .eq("id", created!.id);
      expect(updateError).toBeNull();

      await adminClient.from("conversation_reads").delete().eq("id", created!.id);
    });

    it("a user cannot create a cursor for a conversation they do not participate in", async () => {
      const client = createUserScopedClient(outsider.accessToken);
      const { error } = await client
        .from("conversation_reads")
        .insert({ conversation_id: conversationA, user_id: outsider.id });
      expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it("a user cannot create a cursor owned by somebody else", async () => {
      const client = createUserScopedClient(booker.accessToken);
      const { error } = await client
        .from("conversation_reads")
        .insert({ conversation_id: conversationA, user_id: host.id });
      expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it("a user can neither read nor modify somebody else's cursor", async () => {
      const { data: hostCursor } = await adminClient
        .from("conversation_reads")
        .insert({ conversation_id: conversationA, user_id: host.id })
        .select("id")
        .single();

      const client = createUserScopedClient(booker.accessToken);

      const { data: visible } = await client.from("conversation_reads").select("id").eq("id", hostCursor!.id);
      expect(visible).toHaveLength(0);

      // RLS filters the row out rather than erroring, so the update is a
      // no-op -- assert the row is genuinely untouched, not just that no
      // error came back.
      const { error: updateError } = await client
        .from("conversation_reads")
        .update({ last_read_at: new Date().toISOString() })
        .eq("id", hostCursor!.id);
      expect(updateError).toBeNull();

      const { data: untouched } = await adminClient
        .from("conversation_reads")
        .select("last_read_at")
        .eq("id", hostCursor!.id)
        .single();
      expect(untouched!.last_read_at).toBeNull();

      await adminClient.from("conversation_reads").delete().eq("id", hostCursor!.id);
    });

    it("a user cannot reassign their own cursor to another user", async () => {
      const client = createUserScopedClient(booker.accessToken);
      const { data: created } = await client
        .from("conversation_reads")
        .insert({ conversation_id: conversationA, user_id: booker.id })
        .select("id")
        .single();

      const { error } = await client
        .from("conversation_reads")
        .update({ user_id: host.id })
        .eq("id", created!.id);
      expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE);

      await adminClient.from("conversation_reads").delete().eq("id", created!.id);
    });

    // Phase 27-2 tightening. Before this, the WITH CHECK constrained
    // conversation_id but not last_read_message_id, so a cursor could point at
    // a message in an unrelated thread. The booker participates in BOTH
    // conversations here, so this isolates the new clause from the
    // participation clause.
    it("a cursor cannot point at a message from a different conversation", async () => {
      const client = createUserScopedClient(booker.accessToken);

      const { error: insertError } = await client
        .from("conversation_reads")
        .insert({ conversation_id: conversationA, user_id: booker.id, last_read_message_id: messageB });
      expect(insertError?.code).toBe(INSUFFICIENT_PRIVILEGE);

      // ...and the same is refused on update.
      const { data: created } = await client
        .from("conversation_reads")
        .insert({ conversation_id: conversationA, user_id: booker.id, last_read_message_id: bookerMessageA })
        .select("id")
        .single();

      const { error: updateError } = await client
        .from("conversation_reads")
        .update({ last_read_message_id: messageB })
        .eq("id", created!.id);
      expect(updateError?.code).toBe(INSUFFICIENT_PRIVILEGE);

      await adminClient.from("conversation_reads").delete().eq("id", created!.id);
    });

    it("holding a read cursor is not what grants access -- participation is", async () => {
      // A cursor planted by the backend for a non-participant grants nothing:
      // the conversation and its messages stay invisible.
      const { data: planted } = await adminClient
        .from("conversation_reads")
        .insert({ conversation_id: conversationA, user_id: outsider.id })
        .select("id")
        .single();

      const client = createUserScopedClient(outsider.accessToken);
      const { data: conversations } = await client.from("conversations").select("id").eq("id", conversationA);
      expect(conversations).toHaveLength(0);
      const { data: messages } = await client.from("messages").select("id").eq("conversation_id", conversationA);
      expect(messages).toHaveLength(0);

      await adminClient.from("conversation_reads").delete().eq("id", planted!.id);
    });

    it("authenticated has no DELETE grant on read cursors", async () => {
      const client = createUserScopedClient(booker.accessToken);
      const { data: created } = await client
        .from("conversation_reads")
        .insert({ conversation_id: conversationA, user_id: booker.id })
        .select("id")
        .single();

      const { error } = await client.from("conversation_reads").delete().eq("id", created!.id);
      expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE);

      await adminClient.from("conversation_reads").delete().eq("id", created!.id);
    });
  });

  // --------------------------------------------------------------------------
  // admin_message_access
  // --------------------------------------------------------------------------

  describe("admin_message_access", () => {
    let auditId: string;

    beforeAll(async () => {
      const { data, error } = await adminClient
        .from("admin_message_access")
        .insert({
          admin_user_id: admin.id,
          conversation_id: conversationA,
          action: "view_conversation",
          reason: "Dispute #4821 -- booker reports the host solicited an off-platform payment",
        })
        .select("id")
        .single();
      if (error) throw error;
      auditId = data!.id as string;
    });

    it("a normal user cannot read the audit log", async () => {
      for (const user of [booker, host, outsider]) {
        const client = createUserScopedClient(user.accessToken);
        const { data, error } = await client.from("admin_message_access").select("id");
        expect(error).toBeNull();
        expect(data, `${user.email} must not read the admin access log`).toHaveLength(0);
      }
    });

    it("a normal user cannot write the audit log", async () => {
      const client = createUserScopedClient(booker.accessToken);

      const { error: insertError } = await client.from("admin_message_access").insert({
        admin_user_id: booker.id,
        conversation_id: conversationA,
        action: "view_conversation",
        reason: "fabricated by a normal user",
      });
      expect(insertError?.code).toBe(INSUFFICIENT_PRIVILEGE);

      const { error: updateError } = await client
        .from("admin_message_access")
        .update({ reason: "rewritten" })
        .eq("id", auditId);
      expect(updateError?.code).toBe(INSUFFICIENT_PRIVILEGE);

      const { error: deleteError } = await client.from("admin_message_access").delete().eq("id", auditId);
      expect(deleteError?.code).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it("an admin can read the audit log", async () => {
      const client = createUserScopedClient(admin.accessToken);
      const { data, error } = await client
        .from("admin_message_access")
        .select("id, admin_user_id, conversation_id, action, reason")
        .eq("id", auditId);
      expect(error).toBeNull();
      expect(data).toHaveLength(1);
      expect(data![0]!.action).toBe("view_conversation");
      expect(data![0]!.admin_user_id).toBe(admin.id);
    });

    it("the log is append-only even for an admin's own scoped client", async () => {
      const client = createUserScopedClient(admin.accessToken);

      const { error: insertError } = await client.from("admin_message_access").insert({
        admin_user_id: admin.id,
        conversation_id: conversationA,
        action: "view_conversation",
        reason: "written from a client session rather than the service",
      });
      expect(insertError?.code).toBe(INSUFFICIENT_PRIVILEGE);

      const { error: updateError } = await client
        .from("admin_message_access")
        .update({ reason: "covering my tracks" })
        .eq("id", auditId);
      expect(updateError?.code).toBe(INSUFFICIENT_PRIVILEGE);

      const { error: deleteError } = await client.from("admin_message_access").delete().eq("id", auditId);
      expect(deleteError?.code).toBe(INSUFFICIENT_PRIVILEGE);

      const { data: stillThere } = await adminClient
        .from("admin_message_access")
        .select("reason")
        .eq("id", auditId)
        .single();
      expect(stillThere!.reason).toContain("Dispute #4821");
    });

    // Phase 27-2 correction: conversation_id no longer carries a foreign key,
    // so an audit record outlives the conversation it describes.
    it("an audit row survives deletion of the conversation it refers to", async () => {
      const throwawayBooker = await createTestUser();
      const throwawayLocation = await createPublishedLocation(host, "Authz Audit Survival Listing");
      const throwawayConversation = await createConversation(throwawayBooker.id, throwawayLocation);

      const { data: record, error } = await adminClient
        .from("admin_message_access")
        .insert({
          admin_user_id: admin.id,
          conversation_id: throwawayConversation,
          action: "view_conversation",
          reason: "abuse investigation on a thread that is later deleted",
        })
        .select("id")
        .single();
      expect(error).toBeNull();

      const { error: deleteError } = await adminClient
        .from("conversations")
        .delete()
        .eq("id", throwawayConversation);
      expect(deleteError).toBeNull();

      const { data: conversationGone } = await adminClient
        .from("conversations")
        .select("id")
        .eq("id", throwawayConversation);
      expect(conversationGone).toHaveLength(0);

      const { data: auditSurvives } = await adminClient
        .from("admin_message_access")
        .select("id, conversation_id, reason")
        .eq("id", record!.id);
      expect(auditSurvives).toHaveLength(1);
      expect(auditSurvives![0]!.conversation_id).toBe(throwawayConversation);

      await adminClient.from("admin_message_access").delete().eq("id", record!.id);
      await deleteTestUser(throwawayBooker.id);
      await adminClient.from("locations").delete().eq("id", throwawayLocation);
    });

    it("admin_message_access has no foreign key to conversations", async () => {
      // Guards the correction itself: re-adding an FK here would silently
      // restore the cascade that erased audit history.
      const { data, error } = await adminClient.rpc("is_conversation_participant", {
        _conversation_id: conversationA,
      });
      expect(error).toBeNull();
      expect(data).toBe(false); // service_role has no auth.uid() -- fails closed

      const orphanConversationId = randomUUID();
      const { data: inserted, error: insertError } = await adminClient
        .from("admin_message_access")
        .insert({
          admin_user_id: admin.id,
          conversation_id: orphanConversationId, // references nothing at all
          action: "view_conversation",
          reason: "proves conversation_id is a bare reference value",
        })
        .select("id")
        .single();
      expect(insertError).toBeNull();
      expect(inserted).toBeTruthy();

      await adminClient.from("admin_message_access").delete().eq("id", inserted!.id);
    });
  });
});
