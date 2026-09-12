import { randomUUID } from "crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { createUserScopedClient } from "../src/lib/supabase";
import { adminClient, createTestUser, deleteTestUser, TestUser } from "./setup";

// Phase 27-1: the messaging DATA MODEL only. There is no messaging API yet
// (routes/services/schemas are later sub-phases), so every write below goes
// through the service-role client, exactly as the eventual backend service
// will -- and every *refusal* is asserted against a real user's own scoped
// client talking to PostgREST directly, bypassing Express entirely. That is
// the distinction tests/hardening.test.ts already established for
// bookings/locations/location_media: not "the API rejects it" (there is no
// API to reject it yet), but "the database itself refuses the query".

const app = createApp();

const UNIQUE_VIOLATION = "23505";
const FK_VIOLATION = "23503";
const NOT_NULL_VIOLATION = "23502";
const CHECK_VIOLATION = "23514";
const INSUFFICIENT_PRIVILEGE = "42501";

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

async function createLocation(owner: TestUser, title = "Messaging Test Location"): Promise<string> {
  const res = await request(app)
    .post("/v1/locations")
    .set(authHeader(owner))
    .send({ title, city: "London", country: "UK", timezone: "UTC" });
  expect(res.status).toBe(201);
  return res.body.data.id as string;
}

async function publish(locationId: string): Promise<void> {
  const { error } = await adminClient.from("locations").update({ status: "published" }).eq("id", locationId);
  if (error) throw error;
}

async function createPublishedLocation(owner: TestUser, title?: string): Promise<string> {
  const locationId = await createLocation(owner, title);
  await publish(locationId);
  return locationId;
}

/** A published location that can actually take a booking (rule + hourly price). */
async function createBookableLocation(owner: TestUser): Promise<string> {
  const locationId = await createLocation(owner, "Messaging Bookable Location");
  const ruleRes = await request(app)
    .post(`/v1/locations/${locationId}/availability/rules`)
    .set(authHeader(owner))
    .send({ day_of_week: "monday", start_time: "09:00", end_time: "18:00" });
  expect(ruleRes.status).toBe(201);
  const priceRes = await request(app)
    .post(`/v1/locations/${locationId}/pricing`)
    .set(authHeader(owner))
    .send({ booking_type: "hourly", amount_minor_units: 10_000 });
  expect(priceRes.status).toBe(201);
  await publish(locationId);
  return locationId;
}

/** Creates a conversation the way the eventual service layer will: service-role. */
async function createConversation(bookerId: string, locationId: string, bookingId?: string): Promise<string> {
  const { data, error } = await adminClient
    .from("conversations")
    .insert({ booker_id: bookerId, location_id: locationId, booking_id: bookingId ?? null })
    .select("id")
    .single();
  if (error) throw error;
  return data!.id as string;
}

async function insertMessage(
  conversationId: string,
  senderId: string,
  body: string,
  clientMessageId = randomUUID()
): Promise<string> {
  const { data, error } = await adminClient
    .from("messages")
    .insert({ conversation_id: conversationId, sender_id: senderId, body, client_message_id: clientMessageId })
    .select("id")
    .single();
  if (error) throw error;
  return data!.id as string;
}

describe("Phase 27-1: messaging data model", () => {
  let host: TestUser;
  let booker: TestUser;
  let outsider: TestUser;
  let admin: TestUser;
  let locationId: string;
  let bookableLocationId: string;
  let bookingId: string;
  let conversationId: string;

  beforeAll(async () => {
    host = await createTestUser();
    booker = await createTestUser();
    outsider = await createTestUser();
    admin = await createTestUser();
    await grantRole(host, "host");
    await grantRole(booker, "booker");
    await grantRole(outsider, "booker");
    await grantAdmin(admin);

    locationId = await createPublishedLocation(host);
    bookableLocationId = await createBookableLocation(host);

    const bookingRes = await request(app)
      .post("/v1/bookings")
      .set(authHeader(booker))
      .send({
        location_id: bookableLocationId,
        booking_type: "hourly",
        start_at: `${MON}T10:00:00Z`,
        end_at: `${MON}T12:00:00Z`,
      });
    expect(bookingRes.status).toBe(201);
    bookingId = bookingRes.body.data.id as string;

    conversationId = await createConversation(booker.id, locationId);
  });

  afterAll(async () => {
    await deleteTestUser(host.id);
    await deleteTestUser(booker.id);
    await deleteTestUser(outsider.id);
    await deleteTestUser(admin.id);
  });

  // --------------------------------------------------------------------------
  // Tables, keys and defaults
  // --------------------------------------------------------------------------

  describe("tables and defaults", () => {
    it("all four Phase 27-1 tables exist and are queryable by the service role", async () => {
      for (const table of ["conversations", "messages", "conversation_reads", "admin_message_access"]) {
        const { error } = await adminClient.from(table).select("id").limit(1);
        expect(error, `${table} should exist`).toBeNull();
      }
    });

    it("conversations.id is server-generated and last_message_at defaults to creation time", async () => {
      const { data, error } = await adminClient
        .from("conversations")
        .select("id, last_message_at, last_message_id, booking_id, created_at, updated_at")
        .eq("id", conversationId)
        .single();
      expect(error).toBeNull();
      expect(data!.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(data!.last_message_id).toBeNull();
      expect(data!.booking_id).toBeNull();
      expect(new Date(data!.last_message_at as string).getTime()).toBeCloseTo(
        new Date(data!.created_at as string).getTime(),
        -3
      );
    });

    it("messages.created_at has a server-side default -- no client value is ever needed", async () => {
      const before = Date.now();
      const messageId = await insertMessage(conversationId, booker.id, "Default timestamp check");
      const { data } = await adminClient.from("messages").select("created_at").eq("id", messageId).single();
      const createdAt = new Date(data!.created_at as string).getTime();
      expect(createdAt).toBeGreaterThanOrEqual(before - 5_000);
      expect(createdAt).toBeLessThanOrEqual(Date.now() + 5_000);
    });

    it("conversation_reads.updated_at is maintained by the shared set_updated_at trigger", async () => {
      const { data: inserted, error } = await adminClient
        .from("conversation_reads")
        .insert({ conversation_id: conversationId, user_id: host.id })
        .select("id, updated_at, last_read_at, last_read_message_id")
        .single();
      expect(error).toBeNull();
      expect(inserted!.last_read_at).toBeNull();
      expect(inserted!.last_read_message_id).toBeNull();

      await new Promise((resolve) => setTimeout(resolve, 20));
      const { data: updated } = await adminClient
        .from("conversation_reads")
        .update({ last_read_at: new Date().toISOString() })
        .eq("id", inserted!.id)
        .select("updated_at")
        .single();
      expect(new Date(updated!.updated_at as string).getTime()).toBeGreaterThan(
        new Date(inserted!.updated_at as string).getTime()
      );

      await adminClient.from("conversation_reads").delete().eq("id", inserted!.id);
    });

    it("conversations requires booker_id and location_id", async () => {
      const missingLocation = await adminClient.from("conversations").insert({ booker_id: booker.id });
      expect(missingLocation.error?.code).toBe(NOT_NULL_VIOLATION);

      const missingBooker = await adminClient.from("conversations").insert({ location_id: locationId });
      expect(missingBooker.error?.code).toBe(NOT_NULL_VIOLATION);
    });

    it("messages requires conversation_id, sender_id, body and client_message_id", async () => {
      const noClientId = await adminClient
        .from("messages")
        .insert({ conversation_id: conversationId, sender_id: booker.id, body: "no idempotency key" });
      expect(noClientId.error?.code).toBe(NOT_NULL_VIOLATION);

      const noBody = await adminClient
        .from("messages")
        .insert({ conversation_id: conversationId, sender_id: booker.id, client_message_id: randomUUID() });
      expect(noBody.error?.code).toBe(NOT_NULL_VIOLATION);
    });
  });

  // --------------------------------------------------------------------------
  // Conversation identity -- unique (booker_id, location_id)
  // --------------------------------------------------------------------------

  describe("conversation identity", () => {
    it("a second conversation for the same (booker, location) is rejected", async () => {
      const { error } = await adminClient
        .from("conversations")
        .insert({ booker_id: booker.id, location_id: locationId });
      expect(error?.code).toBe(UNIQUE_VIOLATION);
    });

    it("the same booker gets a separate conversation per listing, even for one host", async () => {
      const secondLocationId = await createPublishedLocation(host, "Messaging Second Listing");
      const secondConversationId = await createConversation(booker.id, secondLocationId);
      expect(secondConversationId).not.toBe(conversationId);
    });

    it("two different bookers each get their own conversation on one listing", async () => {
      const outsiderConversationId = await createConversation(outsider.id, locationId);
      expect(outsiderConversationId).not.toBe(conversationId);
    });

    it("booking_id is optional context, not identity -- a booking does not create a second thread", async () => {
      // Pointing the existing thread at a booking is an UPDATE of the same row.
      const { error } = await adminClient
        .from("conversations")
        .update({ booking_id: bookingId })
        .eq("id", conversationId);
      expect(error).toBeNull();

      // And a would-be "booking thread" on the same listing still collides.
      const { error: duplicate } = await adminClient
        .from("conversations")
        .insert({ booker_id: booker.id, location_id: locationId, booking_id: bookingId });
      expect(duplicate?.code).toBe(UNIQUE_VIOLATION);

      await adminClient.from("conversations").update({ booking_id: null }).eq("id", conversationId);
    });
  });

  // --------------------------------------------------------------------------
  // Message body CHECK
  // --------------------------------------------------------------------------

  describe("message body constraint", () => {
    it("rejects an empty body", async () => {
      const { error } = await adminClient.from("messages").insert({
        conversation_id: conversationId,
        sender_id: booker.id,
        body: "",
        client_message_id: randomUUID(),
      });
      expect(error?.code).toBe(CHECK_VIOLATION);
    });

    // Regression guard: single-argument btrim() strips spaces only, so the
    // newline and tab cases below were accepted until the trim set was
    // spelled out explicitly in the migration.
    it("rejects a whitespace-only body -- the CHECK is on the TRIMMED length", async () => {
      for (const body of ["   ", "\n\n", "\t\t", "\r\n", "\t \n \r ", "\f", "\v"]) {
        const { error } = await adminClient.from("messages").insert({
          conversation_id: conversationId,
          sender_id: booker.id,
          body,
          client_message_id: randomUUID(),
        });
        expect(error?.code, `body ${JSON.stringify(body)} should be rejected`).toBe(CHECK_VIOLATION);
      }
    });

    it("rejects a body longer than 4000 characters", async () => {
      const { error } = await adminClient.from("messages").insert({
        conversation_id: conversationId,
        sender_id: booker.id,
        body: "a".repeat(4001),
        client_message_id: randomUUID(),
      });
      expect(error?.code).toBe(CHECK_VIOLATION);
    });

    it("accepts both ends of the valid range (1 and 4000 characters)", async () => {
      const shortest = await insertMessage(conversationId, booker.id, "x");
      expect(shortest).toBeTruthy();

      const longest = await insertMessage(conversationId, booker.id, "a".repeat(4000));
      expect(longest).toBeTruthy();
    });

    it("stores the body verbatim -- surrounding whitespace is validated, never silently rewritten", async () => {
      const body = "  padded but valid  ";
      const messageId = await insertMessage(conversationId, booker.id, body);
      const { data } = await adminClient.from("messages").select("body").eq("id", messageId).single();
      expect(data!.body).toBe(body);
    });
  });

  // --------------------------------------------------------------------------
  // Idempotency -- unique (conversation_id, sender_id, client_message_id)
  // --------------------------------------------------------------------------

  describe("client_message_id idempotency scope", () => {
    it("the same key twice from the same sender in the same conversation is rejected", async () => {
      const clientMessageId = randomUUID();
      await insertMessage(conversationId, booker.id, "First send", clientMessageId);

      const { error } = await adminClient.from("messages").insert({
        conversation_id: conversationId,
        sender_id: booker.id,
        body: "Retry of the same tap",
        client_message_id: clientMessageId,
      });
      expect(error?.code).toBe(UNIQUE_VIOLATION);
    });

    it("the same key from a DIFFERENT sender in the same conversation is allowed", async () => {
      const clientMessageId = randomUUID();
      const fromBooker = await insertMessage(conversationId, booker.id, "Booker message", clientMessageId);
      // Without sender_id in the unique key this would collide, and the
      // idempotent re-read would hand the host the booker's message.
      const fromHost = await insertMessage(conversationId, host.id, "Host message", clientMessageId);
      expect(fromHost).not.toBe(fromBooker);
    });

    it("the same key from the same sender in a DIFFERENT conversation is allowed", async () => {
      const otherLocationId = await createPublishedLocation(host, "Messaging Idempotency Listing");
      const otherConversationId = await createConversation(booker.id, otherLocationId);

      const clientMessageId = randomUUID();
      const first = await insertMessage(conversationId, booker.id, "Thread one", clientMessageId);
      const second = await insertMessage(otherConversationId, booker.id, "Thread two", clientMessageId);
      expect(second).not.toBe(first);
    });
  });

  // --------------------------------------------------------------------------
  // conversation_reads uniqueness
  // --------------------------------------------------------------------------

  describe("conversation_reads uniqueness", () => {
    it("one read cursor per (conversation, user)", async () => {
      const { data: first, error: firstError } = await adminClient
        .from("conversation_reads")
        .insert({ conversation_id: conversationId, user_id: booker.id })
        .select("id")
        .single();
      expect(firstError).toBeNull();

      const { error } = await adminClient
        .from("conversation_reads")
        .insert({ conversation_id: conversationId, user_id: booker.id });
      expect(error?.code).toBe(UNIQUE_VIOLATION);

      // ...but the other participant gets their own row in the same thread.
      const { error: hostError } = await adminClient
        .from("conversation_reads")
        .insert({ conversation_id: conversationId, user_id: host.id });
      expect(hostError).toBeNull();

      await adminClient.from("conversation_reads").delete().eq("id", first!.id);
      await adminClient
        .from("conversation_reads")
        .delete()
        .eq("conversation_id", conversationId)
        .eq("user_id", host.id);
    });
  });

  // --------------------------------------------------------------------------
  // Foreign keys
  // --------------------------------------------------------------------------

  describe("foreign keys", () => {
    it("a conversation cannot reference a nonexistent location, booker or booking", async () => {
      const badLocation = await adminClient
        .from("conversations")
        .insert({ booker_id: booker.id, location_id: randomUUID() });
      expect(badLocation.error?.code).toBe(FK_VIOLATION);

      const badBooker = await adminClient
        .from("conversations")
        .insert({ booker_id: randomUUID(), location_id: locationId });
      expect(badBooker.error?.code).toBe(FK_VIOLATION);

      const badBooking = await adminClient
        .from("conversations")
        .insert({ booker_id: outsider.id, location_id: bookableLocationId, booking_id: randomUUID() });
      expect(badBooking.error?.code).toBe(FK_VIOLATION);
    });

    it("a message cannot reference a nonexistent conversation or sender", async () => {
      const badConversation = await adminClient.from("messages").insert({
        conversation_id: randomUUID(),
        sender_id: booker.id,
        body: "orphan",
        client_message_id: randomUUID(),
      });
      expect(badConversation.error?.code).toBe(FK_VIOLATION);

      const badSender = await adminClient.from("messages").insert({
        conversation_id: conversationId,
        sender_id: randomUUID(),
        body: "ghost sender",
        client_message_id: randomUUID(),
      });
      expect(badSender.error?.code).toBe(FK_VIOLATION);
    });
  });

  // --------------------------------------------------------------------------
  // Deletion behaviour
  // --------------------------------------------------------------------------

  describe("deletion behaviour", () => {
    it("a location with conversation history cannot be deleted -- matching bookings.location_id", async () => {
      const doomedHost = await createTestUser();
      const doomedBooker = await createTestUser();
      await grantRole(doomedHost, "host");
      const doomedLocationId = await createPublishedLocation(doomedHost, "Messaging Undeletable Listing");
      await createConversation(doomedBooker.id, doomedLocationId);

      // Deleted through the owning host's own scoped client, the one path the
      // API actually exposes -- and specifically a location with NO booking,
      // so the refusal can only be the conversations FK.
      const hostClient = createUserScopedClient(doomedHost.accessToken);
      const { error } = await hostClient.from("locations").delete().eq("id", doomedLocationId);
      expect(error?.code).toBe(FK_VIOLATION);

      const { data: stillThere } = await adminClient
        .from("locations")
        .select("id")
        .eq("id", doomedLocationId)
        .maybeSingle();
      expect(stillThere).not.toBeNull();

      await deleteTestUser(doomedBooker.id); // cascades the conversation away
      await adminClient.from("locations").delete().eq("id", doomedLocationId);
      await deleteTestUser(doomedHost.id);
    });

    it("a booking referenced as conversation context cannot be deleted", async () => {
      const { error: pointed } = await adminClient
        .from("conversations")
        .update({ booking_id: bookingId })
        .eq("id", conversationId);
      expect(pointed).toBeNull();

      const { error } = await adminClient.from("bookings").delete().eq("id", bookingId);
      expect(error?.code).toBe(FK_VIOLATION);

      await adminClient.from("conversations").update({ booking_id: null }).eq("id", conversationId);
    });

    // Phase 27-2 changed the last of these three deliberately: admin access
    // records no longer cascade, because an audit record must outlive the
    // conversation it describes. The FK was dropped in
    // 20260912200000_phase27_2_messaging_authorization.sql; the survival case
    // itself is asserted in tests/messaging-authorization.test.ts.
    it("deleting a conversation cascades its messages and read cursors, but NOT admin access records", async () => {
      const tempBooker = await createTestUser();
      const tempLocationId = await createPublishedLocation(host, "Messaging Cascade Listing");
      const tempConversationId = await createConversation(tempBooker.id, tempLocationId);
      const tempMessageId = await insertMessage(tempConversationId, tempBooker.id, "Goes away with its thread");
      await adminClient
        .from("conversation_reads")
        .insert({ conversation_id: tempConversationId, user_id: tempBooker.id });
      await adminClient.from("admin_message_access").insert({
        admin_user_id: admin.id,
        conversation_id: tempConversationId,
        action: "view_conversation",
        reason: "cascade behaviour test",
      });

      const { error } = await adminClient.from("conversations").delete().eq("id", tempConversationId);
      expect(error).toBeNull();

      const { data: messages } = await adminClient.from("messages").select("id").eq("id", tempMessageId);
      expect(messages).toHaveLength(0);
      const { data: reads } = await adminClient
        .from("conversation_reads")
        .select("id")
        .eq("conversation_id", tempConversationId);
      expect(reads).toHaveLength(0);
      const { data: access } = await adminClient
        .from("admin_message_access")
        .select("id")
        .eq("conversation_id", tempConversationId);
      expect(access).toHaveLength(1);

      await adminClient.from("admin_message_access").delete().eq("conversation_id", tempConversationId);
      await adminClient.from("locations").delete().eq("id", tempLocationId);
      await deleteTestUser(tempBooker.id);
    });

    it("deleting the booker's profile cascades the whole conversation away", async () => {
      const tempBooker = await createTestUser();
      const tempLocationId = await createPublishedLocation(host, "Messaging Profile Cascade Listing");
      const tempConversationId = await createConversation(tempBooker.id, tempLocationId);
      await insertMessage(tempConversationId, tempBooker.id, "Disappears with the account");

      await deleteTestUser(tempBooker.id);

      const { data } = await adminClient.from("conversations").select("id").eq("id", tempConversationId);
      expect(data).toHaveLength(0);

      await adminClient.from("locations").delete().eq("id", tempLocationId);
    });

    it("deleting the message a conversation points at clears last_message_id rather than the conversation", async () => {
      const tempBooker = await createTestUser();
      const tempLocationId = await createPublishedLocation(host, "Messaging Set-Null Listing");
      const tempConversationId = await createConversation(tempBooker.id, tempLocationId);
      const tempMessageId = await insertMessage(tempConversationId, tempBooker.id, "Cached as last_message");

      await adminClient
        .from("conversations")
        .update({ last_message_id: tempMessageId })
        .eq("id", tempConversationId);
      await adminClient
        .from("conversation_reads")
        .insert({ conversation_id: tempConversationId, user_id: tempBooker.id, last_read_message_id: tempMessageId });

      await adminClient.from("messages").delete().eq("id", tempMessageId);

      const { data: conversation } = await adminClient
        .from("conversations")
        .select("id, last_message_id")
        .eq("id", tempConversationId)
        .single();
      expect(conversation).not.toBeNull();
      expect(conversation!.last_message_id).toBeNull();

      const { data: read } = await adminClient
        .from("conversation_reads")
        .select("last_read_message_id")
        .eq("conversation_id", tempConversationId)
        .eq("user_id", tempBooker.id)
        .single();
      expect(read!.last_read_message_id).toBeNull();

      await deleteTestUser(tempBooker.id);
      await adminClient.from("locations").delete().eq("id", tempLocationId);
    });
  });

  // --------------------------------------------------------------------------
  // RLS -- asserted against real user-scoped clients, not through Express
  // --------------------------------------------------------------------------

  describe("row level security", () => {
    it("RLS is enabled on all four tables", async () => {
      const { data, error } = await adminClient.rpc("is_conversation_participant", {
        _conversation_id: conversationId,
      });
      // The helper is reachable, and returns false for the service role (no
      // auth.uid()) -- proving it fails closed rather than defaulting open.
      expect(error).toBeNull();
      expect(data).toBe(false);

      // Every table denies an anonymous caller outright.
      const anonView = createUserScopedClient("");
      for (const table of ["conversations", "messages", "conversation_reads", "admin_message_access"]) {
        const { data: rows } = await anonView.from(table).select("id");
        expect(rows ?? [], `${table} should expose nothing to anon`).toHaveLength(0);
      }
    });

    it("both participants can read their own conversation", async () => {
      for (const participant of [booker, host]) {
        const client = createUserScopedClient(participant.accessToken);
        const { data, error } = await client.from("conversations").select("id").eq("id", conversationId);
        expect(error).toBeNull();
        expect(data).toHaveLength(1);
      }
    });

    it("a third party cannot read someone else's conversation or its messages", async () => {
      const outsiderClient = createUserScopedClient(outsider.accessToken);

      const { data: conversations } = await outsiderClient.from("conversations").select("id").eq("id", conversationId);
      expect(conversations).toHaveLength(0);

      const { data: messages } = await outsiderClient
        .from("messages")
        .select("id")
        .eq("conversation_id", conversationId);
      expect(messages).toHaveLength(0);
    });

    it("an admin gets no conversation or message access from ordinary RLS", async () => {
      // Deliberate: admin access to private correspondence is a separate,
      // audited path (admin_message_access + a later Admin Messaging service),
      // never an invisible widening of the participant policy.
      const adminScopedClient = createUserScopedClient(admin.accessToken);

      const { data: conversations } = await adminScopedClient
        .from("conversations")
        .select("id")
        .eq("id", conversationId);
      expect(conversations).toHaveLength(0);

      const { data: messages } = await adminScopedClient
        .from("messages")
        .select("id")
        .eq("conversation_id", conversationId);
      expect(messages).toHaveLength(0);
    });

    it("a participant cannot insert a message via direct PostgREST", async () => {
      const bookerClient = createUserScopedClient(booker.accessToken);
      const { error } = await bookerClient.from("messages").insert({
        conversation_id: conversationId,
        sender_id: booker.id,
        body: "forged directly against the database",
        client_message_id: randomUUID(),
      });
      expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it("a participant cannot forge a message as the other party, or backdate one", async () => {
      const bookerClient = createUserScopedClient(booker.accessToken);
      const { error } = await bookerClient.from("messages").insert({
        conversation_id: conversationId,
        sender_id: host.id,
        body: "pretending to be the host",
        client_message_id: randomUUID(),
        created_at: "2020-01-01T00:00:00Z",
      });
      expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it("messages are immutable to authenticated callers -- no update, no delete", async () => {
      const messageId = await insertMessage(conversationId, booker.id, "Immutable once written");
      const bookerClient = createUserScopedClient(booker.accessToken);

      const { error: updateError } = await bookerClient
        .from("messages")
        .update({ body: "edited after the fact" })
        .eq("id", messageId);
      expect(updateError?.code).toBe(INSUFFICIENT_PRIVILEGE);

      const { error: deleteError } = await bookerClient.from("messages").delete().eq("id", messageId);
      expect(deleteError?.code).toBe(INSUFFICIENT_PRIVILEGE);

      const { data: unchanged } = await adminClient.from("messages").select("body").eq("id", messageId).single();
      expect(unchanged!.body).toBe("Immutable once written");
    });

    it("conversations are not directly writable by authenticated callers", async () => {
      const bookerClient = createUserScopedClient(booker.accessToken);

      const { error: insertError } = await bookerClient
        .from("conversations")
        .insert({ booker_id: booker.id, location_id: bookableLocationId });
      expect(insertError?.code).toBe(INSUFFICIENT_PRIVILEGE);

      const { error: updateError } = await bookerClient
        .from("conversations")
        .update({ booking_id: bookingId })
        .eq("id", conversationId);
      expect(updateError?.code).toBe(INSUFFICIENT_PRIVILEGE);

      const { error: deleteError } = await bookerClient.from("conversations").delete().eq("id", conversationId);
      expect(deleteError?.code).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it("a participant may READ their own read cursor but no longer write it directly", async () => {
      // INVERTED BY PHASE 27-7 (decision D-3). Phase 27-1 modelled this table
      // as ordinary self-service, which made it the only messaging table a
      // client could write -- and that was measured to let a client move its
      // own cursor backwards, and to delete the row entirely, both of which
      // defeat the monotonicity a read cursor exists to provide. Writes now go
      // exclusively through public.mark_conversation_read().
      const bookerClient = createUserScopedClient(booker.accessToken);

      const { error: insertError } = await bookerClient
        .from("conversation_reads")
        .insert({ conversation_id: conversationId, user_id: booker.id, last_read_at: new Date().toISOString() })
        .select("id")
        .single();
      expect(insertError?.code).toBe(INSUFFICIENT_PRIVILEGE);

      const { data: planted } = await adminClient
        .from("conversation_reads")
        .insert({ conversation_id: conversationId, user_id: booker.id, last_read_at: new Date().toISOString() })
        .select("id")
        .single();

      // SELECT is deliberately untouched -- a client still reads its own cursor.
      const { data: visible, error: selectError } = await bookerClient
        .from("conversation_reads")
        .select("id")
        .eq("id", planted!.id);
      expect(selectError).toBeNull();
      expect(visible).toHaveLength(1);

      const { error: updateError } = await bookerClient
        .from("conversation_reads")
        .update({ last_read_at: new Date().toISOString() })
        .eq("id", planted!.id);
      expect(updateError?.code).toBe(INSUFFICIENT_PRIVILEGE);

      await adminClient.from("conversation_reads").delete().eq("id", planted!.id);
    });

    it("a user cannot write or read another user's read cursor", async () => {
      const { data: hostRead } = await adminClient
        .from("conversation_reads")
        .insert({ conversation_id: conversationId, user_id: host.id })
        .select("id")
        .single();

      const bookerClient = createUserScopedClient(booker.accessToken);

      const { data: visible } = await bookerClient.from("conversation_reads").select("id").eq("id", hostRead!.id);
      expect(visible).toHaveLength(0);

      const { error: forgeError } = await bookerClient
        .from("conversation_reads")
        .insert({ conversation_id: conversationId, user_id: host.id });
      expect(forgeError?.code).toBe(INSUFFICIENT_PRIVILEGE);

      const { error: updateError } = await bookerClient
        .from("conversation_reads")
        .update({ last_read_at: new Date().toISOString() })
        .eq("id", hostRead!.id);
      // Since Phase 27-7 this is refused at the GRANT layer rather than
      // silently filtered to zero rows by RLS -- strictly stronger, and the
      // row is asserted untouched either way.
      expect(updateError?.code).toBe(INSUFFICIENT_PRIVILEGE);
      const { data: untouched } = await adminClient
        .from("conversation_reads")
        .select("last_read_at")
        .eq("id", hostRead!.id)
        .single();
      expect(untouched!.last_read_at).toBeNull();

      await adminClient.from("conversation_reads").delete().eq("id", hostRead!.id);
    });

    it("a user cannot create a read cursor for a conversation they are not in", async () => {
      const outsiderClient = createUserScopedClient(outsider.accessToken);
      const { error } = await outsiderClient
        .from("conversation_reads")
        .insert({ conversation_id: conversationId, user_id: outsider.id });
      expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE);
    });
  });

  // --------------------------------------------------------------------------
  // admin_message_access
  // --------------------------------------------------------------------------

  describe("admin_message_access", () => {
    it("requires a non-blank reason and only accepts the 'view_conversation' action", async () => {
      const blankReason = await adminClient.from("admin_message_access").insert({
        admin_user_id: admin.id,
        conversation_id: conversationId,
        action: "view_conversation",
        reason: "   ",
      });
      expect(blankReason.error?.code).toBe(CHECK_VIOLATION);

      const missingReason = await adminClient.from("admin_message_access").insert({
        admin_user_id: admin.id,
        conversation_id: conversationId,
        action: "view_conversation",
      });
      expect(missingReason.error?.code).toBe(NOT_NULL_VIOLATION);

      const unknownAction = await adminClient.from("admin_message_access").insert({
        admin_user_id: admin.id,
        conversation_id: conversationId,
        action: "export_conversation",
        reason: "not a supported action in V1",
      });
      expect(unknownAction.error?.code).toBe(CHECK_VIOLATION);
    });

    it("records a valid access entry written by the service role", async () => {
      const { data, error } = await adminClient
        .from("admin_message_access")
        .insert({
          admin_user_id: admin.id,
          conversation_id: conversationId,
          action: "view_conversation",
          reason: "Dispute #1234 -- booker claims the host cancelled off-platform",
        })
        .select("id, created_at")
        .single();
      expect(error).toBeNull();
      expect(data!.created_at).toBeTruthy();
    });

    it("a normal authenticated user sees nothing in admin_message_access", async () => {
      for (const user of [booker, host, outsider]) {
        const client = createUserScopedClient(user.accessToken);
        const { data, error } = await client.from("admin_message_access").select("id");
        expect(error).toBeNull();
        expect(data, `${user.email} must not see admin access records`).toHaveLength(0);
      }
    });

    it("an admin can read the log -- accountability across the admin team", async () => {
      const adminScopedClient = createUserScopedClient(admin.accessToken);
      const { data, error } = await adminScopedClient
        .from("admin_message_access")
        .select("id, admin_user_id, action, reason")
        .eq("conversation_id", conversationId);
      expect(error).toBeNull();
      expect((data ?? []).length).toBeGreaterThan(0);
    });

    it("the log is append-only -- not even an admin can write, edit or erase an entry", async () => {
      const adminScopedClient = createUserScopedClient(admin.accessToken);

      const { error: insertError } = await adminScopedClient.from("admin_message_access").insert({
        admin_user_id: admin.id,
        conversation_id: conversationId,
        action: "view_conversation",
        reason: "written from a client session",
      });
      expect(insertError?.code).toBe(INSUFFICIENT_PRIVILEGE);

      const { error: updateError } = await adminScopedClient
        .from("admin_message_access")
        .update({ reason: "rewritten" })
        .eq("conversation_id", conversationId);
      expect(updateError?.code).toBe(INSUFFICIENT_PRIVILEGE);

      const { error: deleteError } = await adminScopedClient
        .from("admin_message_access")
        .delete()
        .eq("conversation_id", conversationId);
      expect(deleteError?.code).toBe(INSUFFICIENT_PRIVILEGE);
    });
  });
});
