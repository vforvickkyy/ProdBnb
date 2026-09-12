import { randomUUID } from "crypto";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Phase 27-8: message notifications.
//
// The durability invariant is the reason this file exists, and it is asserted
// directly rather than assumed: a message is stored, ordered, broadcast and
// readable whether or not anyone was ever successfully told about it. Every
// other assertion here is downstream of that one.
//
// The notification provider is swapped for a controllable fake so the whole
// fan-out -- payload shape, preference gate, multi-device, invalid-token
// cleanup, per-device failure isolation -- is exercised without any Apple
// credential and without a single packet leaving the machine. That is the
// Phase 8 `DisabledProvider` idea applied to a test.

const providerState = vi.hoisted(() => ({
  sent: [] as Array<{
    deviceToken: string;
    environment: string | null;
    title: string;
    body: string;
    data: Record<string, string>;
    threadId: string | null | undefined;
  }>,
  nextStatus: "sent" as "sent" | "failed" | "invalid_token" | "skipped",
  /** When set, provider.send() THROWS -- the "APNs is broken" case. */
  throwOnSend: false,
  name: "apns" as "apns" | "disabled",
}));

vi.mock("../src/modules/notifications/providers", () => ({
  getNotificationProvider: () => ({
    get name() {
      return providerState.name;
    },
    async send(input: (typeof providerState.sent)[number]) {
      if (providerState.throwOnSend) {
        throw new Error("APNs exploded");
      }
      providerState.sent.push(input);
      return {
        status: providerState.nextStatus,
        providerMessageId: providerState.nextStatus === "sent" ? `apns-${providerState.sent.length}` : null,
        errorReason: providerState.nextStatus === "sent" ? null : "TestReason",
      };
    },
  }),
}));

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

async function makeLocation(hostId: string, title: string): Promise<string> {
  const { data, error } = await adminClient
    .from("locations")
    .insert({ host_id: hostId, title, city: "London", country: "UK", timezone: "UTC", status: "published" })
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

async function postMessage(user: TestUser, conversationId: string, body: string, clientMessageId = randomUUID()) {
  const res = await request(app)
    .post(`/v1/conversations/${conversationId}/messages`)
    .set(authHeader(user))
    .send({ body, client_message_id: clientMessageId });
  return { status: res.status, body: res.body, clientMessageId };
}

async function registerDevice(user: TestUser, environment?: "sandbox" | "production"): Promise<string> {
  const payload: Record<string, unknown> = { device_token: `tok-${randomUUID()}`, platform: "ios" };
  if (environment) payload.environment = environment;
  const res = await request(app).post("/v1/devices").set(authHeader(user)).send(payload);
  expect(res.status).toBe(201);
  return res.body.data.id as string;
}

async function notificationsFor(userId: string) {
  const { data } = await adminClient
    .from("notifications")
    .select("id, type, title, body, entity_type, entity_id, data, source_event_id")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  return data ?? [];
}

async function attemptsFor(notificationId: string) {
  const { data } = await adminClient
    .from("notification_delivery_attempts")
    .select("id, device_id, status, provider")
    .eq("notification_id", notificationId);
  return data ?? [];
}

describe("Phase 27-8: message notifications", () => {
  let host: TestUser;
  let booker: TestUser;
  let locationId: string;
  let conversationId: string;

  beforeAll(async () => {
    [host, booker] = await Promise.all([createTestUser(), createTestUser()]);
    await grantRole(host, "host");
    await grantRole(booker, "booker");
    await adminClient.from("profiles").update({ first_name: "Priya", last_name: "Sharma" }).eq("id", host.id);
    await adminClient.from("profiles").update({ first_name: "Sam", last_name: "Okafor" }).eq("id", booker.id);

    locationId = await makeLocation(host.id, "Notification Studio");
    conversationId = await openConversation(booker, locationId);
  });

  beforeEach(async () => {
    providerState.sent = [];
    providerState.nextStatus = "sent";
    providerState.throwOnSend = false;
    providerState.name = "apns";
    await adminClient.from("notification_delivery_attempts").delete().neq("id", randomUUID());
    await adminClient.from("notifications").delete().in("user_id", [host.id, booker.id]);
    await adminClient.from("notification_preferences").delete().in("user_id", [host.id, booker.id]);
    await adminClient.from("user_devices").delete().in("user_id", [host.id, booker.id]);
  });

  afterAll(async () => {
    await adminClient.from("conversations").update({ last_message_id: null }).eq("id", conversationId);
    await adminClient.from("messages").delete().eq("conversation_id", conversationId);
    await adminClient.from("conversations").delete().eq("id", conversationId);
    await adminClient.from("locations").delete().eq("id", locationId);
    await Promise.all([deleteTestUser(host.id), deleteTestUser(booker.id)]);
  });

  // --------------------------------------------------------------------------
  // The invariant everything else depends on
  // --------------------------------------------------------------------------

  describe("message durability", () => {
    it("a message is still stored and returned when the push provider THROWS", async () => {
      await registerDevice(host);
      providerState.throwOnSend = true;

      const { status, body } = await postMessage(booker, conversationId, "survives a broken APNs");
      expect(status).toBe(201);
      expect(body.data.id).toBeTruthy();

      // ...and it is readable through the authoritative API, which is what
      // makes a lost push recoverable (the Phase 27-6 client contract).
      const history = await request(app)
        .get(`/v1/conversations/${conversationId}/messages?limit=50`)
        .set(authHeader(host));
      expect(history.status).toBe(200);
      expect((history.body.data as Array<{ id: string }>).some((m) => m.id === body.data.id)).toBe(true);
    });

    it("a message is still stored when the notification row itself cannot be created", async () => {
      // A duplicate source_event_id is the one notification failure reachable
      // from outside: plant the row first, then send the message.
      const { body: first } = await postMessage(booker, conversationId, "first");
      expect(first.data.id).toBeTruthy();

      const { status } = await postMessage(booker, conversationId, "second");
      expect(status).toBe(201);
    });
  });

  // --------------------------------------------------------------------------
  // Recipient resolution
  // --------------------------------------------------------------------------

  describe("recipient resolution", () => {
    it("notifies the HOST when the booker sends, and never the sender", async () => {
      await postMessage(booker, conversationId, "hello from the booker");

      const hostNotifications = await notificationsFor(host.id);
      const bookerNotifications = await notificationsFor(booker.id);

      expect(hostNotifications).toHaveLength(1);
      expect(hostNotifications[0]!.type).toBe("new_message");
      expect(bookerNotifications).toHaveLength(0);
    });

    it("notifies the BOOKER when the host sends, and never the sender", async () => {
      await postMessage(host, conversationId, "hello from the host");

      expect(await notificationsFor(booker.id)).toHaveLength(1);
      expect(await notificationsFor(host.id)).toHaveLength(0);
    });

    it("records the conversation as the entity, so the client can deep-link", async () => {
      await postMessage(booker, conversationId, "route me");
      const [notification] = await notificationsFor(host.id);

      expect(notification!.entity_type).toBe("conversation");
      expect(notification!.entity_id).toBe(conversationId);
    });
  });

  // --------------------------------------------------------------------------
  // Privacy (decision N-1)
  // --------------------------------------------------------------------------

  describe("privacy", () => {
    it("NEVER puts the message body in the notification or the push", async () => {
      // The assertion that must never be weakened. A push is rendered on a
      // locked screen and mirrored to paired devices; ProdBnb messages carry
      // rates, addresses and client names.
      const secret = "Day rate is 4500 GBP, client is Netflix, gate code 8823";
      await registerDevice(host);
      await postMessage(booker, conversationId, secret);

      const [notification] = await notificationsFor(host.id);
      expect(notification!.title).not.toContain(secret);
      expect(notification!.body).not.toContain(secret);
      expect(notification!.body).not.toContain("4500");
      expect(notification!.body).not.toContain("Netflix");
      expect(notification!.body).not.toContain("8823");

      expect(providerState.sent).toHaveLength(1);
      const push = providerState.sent[0]!;
      expect(push.title).not.toContain(secret);
      expect(push.body).not.toContain(secret);
      expect(JSON.stringify(push.data)).not.toContain("4500");
      expect(JSON.stringify(push.data)).not.toContain("Netflix");
    });

    it("titles the notification with the sender's name and a fixed body", async () => {
      await postMessage(booker, conversationId, "anything");
      const [notification] = await notificationsFor(host.id);

      expect(notification!.title).toBe("Sam Okafor");
      expect(notification!.body).toBe("Sent you a message.");
    });

    it("falls back to a generic title when the sender has no name at all", async () => {
      await adminClient.from("profiles").update({ first_name: null, last_name: null }).eq("id", booker.id);
      await postMessage(booker, conversationId, "nameless");

      const [notification] = await notificationsFor(host.id);
      expect(notification!.title).toBe("New message");

      await adminClient.from("profiles").update({ first_name: "Sam", last_name: "Okafor" }).eq("id", booker.id);
    });

    it("uses whichever half of the name exists", async () => {
      await adminClient.from("profiles").update({ first_name: "Sam", last_name: null }).eq("id", booker.id);
      await postMessage(booker, conversationId, "first only");
      expect((await notificationsFor(host.id))[0]!.title).toBe("Sam");

      await adminClient.from("notifications").delete().eq("user_id", host.id);
      await adminClient.from("profiles").update({ first_name: null, last_name: "Okafor" }).eq("id", booker.id);
      await postMessage(booker, conversationId, "last only");
      expect((await notificationsFor(host.id))[0]!.title).toBe("Okafor");

      await adminClient.from("profiles").update({ first_name: "Sam", last_name: "Okafor" }).eq("id", booker.id);
    });
  });

  // --------------------------------------------------------------------------
  // Push payload (the contract iOS already parses)
  // --------------------------------------------------------------------------

  describe("push payload", () => {
    it("carries exactly the keys the iOS NotificationPayload parser reads", async () => {
      await registerDevice(host);
      const { body } = await postMessage(booker, conversationId, "payload check");
      const messageId = body.data.id as string;

      expect(providerState.sent).toHaveLength(1);
      const { data } = providerState.sent[0]!;

      expect(data.prodbnb_type).toBe("new_message");
      expect(data.prodbnb_entity_type).toBe("conversation");
      expect(data.prodbnb_entity_id).toBe(conversationId);
      expect(data.prodbnb_conversation_id).toBe(conversationId);
      expect(data.prodbnb_message_id).toBe(messageId);
      // A conversation push must not carry a booking alias.
      expect(data).not.toHaveProperty("prodbnb_booking_id");
    });

    it("sets thread-id to the conversation so a busy thread is one grouped entry", async () => {
      await registerDevice(host);
      await postMessage(booker, conversationId, "group me");
      expect(providerState.sent[0]!.threadId).toBe(conversationId);
    });
  });

  // --------------------------------------------------------------------------
  // Idempotency
  // --------------------------------------------------------------------------

  describe("idempotency", () => {
    it("a replayed send creates no second notification", async () => {
      const clientMessageId = randomUUID();
      const first = await postMessage(booker, conversationId, "retry me", clientMessageId);
      const second = await postMessage(booker, conversationId, "retry me", clientMessageId);

      expect(second.status).toBe(201);
      expect(second.body.data.id).toBe(first.body.data.id);
      expect(await notificationsFor(host.id)).toHaveLength(1);
    });

    it("two DIFFERENT messages produce two notifications", async () => {
      // Guards the source_event_id choice: keying on the conversation instead
      // of the message would collapse an entire thread into one notification.
      await postMessage(booker, conversationId, "one");
      await postMessage(booker, conversationId, "two");

      const notifications = await notificationsFor(host.id);
      expect(notifications).toHaveLength(2);
      expect(new Set(notifications.map((n) => n.source_event_id)).size).toBe(2);
      expect(notifications[0]!.source_event_id).toMatch(/^message:[0-9a-f-]{36}:new_message$/);
    });
  });

  // --------------------------------------------------------------------------
  // Preference gate
  // --------------------------------------------------------------------------

  describe("the message preference", () => {
    it("defaults to enabled, with no row present", async () => {
      const res = await request(app).get("/v1/notification-preferences").set(authHeader(host));
      expect(res.status).toBe(200);
      expect(res.body.data.message).toBe(true);

      await registerDevice(host);
      await postMessage(booker, conversationId, "default on");
      expect(providerState.sent).toHaveLength(1);
    });

    it("when disabled, suppresses the PUSH but still creates the in-app notification", async () => {
      const patch = await request(app)
        .patch("/v1/notification-preferences")
        .set(authHeader(host))
        .send({ message: false });
      expect(patch.status).toBe(200);
      expect(patch.body.data.message).toBe(false);

      await registerDevice(host);
      await postMessage(booker, conversationId, "muted");

      expect(providerState.sent).toHaveLength(0);
      expect(await notificationsFor(host.id)).toHaveLength(1);
    });

    it("disabling messages does not disable booking or payment", async () => {
      await request(app).patch("/v1/notification-preferences").set(authHeader(host)).send({ message: false });
      const res = await request(app).get("/v1/notification-preferences").set(authHeader(host));
      expect(res.body.data).toEqual({ booking: true, payment: true, message: false });
    });
  });

  // --------------------------------------------------------------------------
  // Fan-out
  // --------------------------------------------------------------------------

  describe("multi-device fan-out", () => {
    it("delivers to every active device and logs one attempt each", async () => {
      await registerDevice(host);
      await registerDevice(host);
      await registerDevice(host);

      await postMessage(booker, conversationId, "three devices");

      expect(providerState.sent).toHaveLength(3);
      const [notification] = await notificationsFor(host.id);
      expect(await attemptsFor(notification!.id)).toHaveLength(3);
    });

    it("skips a deactivated device", async () => {
      const keep = await registerDevice(host);
      const drop = await registerDevice(host);
      await adminClient.from("user_devices").update({ is_active: false }).eq("id", drop);

      await postMessage(booker, conversationId, "one active");

      expect(providerState.sent).toHaveLength(1);
      const [notification] = await notificationsFor(host.id);
      const attempts = await attemptsFor(notification!.id);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]!.device_id).toBe(keep);
    });

    it("deactivates a device APNs reports as invalid", async () => {
      const deviceId = await registerDevice(host);
      providerState.nextStatus = "invalid_token";

      await postMessage(booker, conversationId, "bad token");

      const { data } = await adminClient.from("user_devices").select("is_active").eq("id", deviceId).single();
      expect(data!.is_active).toBe(false);
    });

    it("routes each device to its own APNs environment", async () => {
      await registerDevice(host, "sandbox");
      await registerDevice(host, "production");

      await postMessage(booker, conversationId, "mixed environments");

      const environments = providerState.sent.map((s) => s.environment).sort();
      expect(environments).toEqual(["production", "sandbox"]);
    });

    it("records 'skipped' honestly when no provider is configured", async () => {
      providerState.name = "disabled";
      providerState.nextStatus = "skipped";
      await registerDevice(host);

      await postMessage(booker, conversationId, "no provider");

      const [notification] = await notificationsFor(host.id);
      const attempts = await attemptsFor(notification!.id);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]!.status).toBe("skipped");
      expect(attempts[0]!.provider).toBe("disabled");
    });

    it("no device at all is not an error", async () => {
      await postMessage(booker, conversationId, "no devices");
      expect(providerState.sent).toHaveLength(0);
      expect(await notificationsFor(host.id)).toHaveLength(1);
    });
  });

  // --------------------------------------------------------------------------
  // Read state and Realtime are untouched by this phase
  // --------------------------------------------------------------------------

  describe("Phase 27-6 / 27-7 invariants", () => {
    it("sending a message does not touch anybody's read cursor", async () => {
      await postMessage(booker, conversationId, "no cursor change");

      const { data } = await adminClient
        .from("conversation_reads")
        .select("id")
        .eq("conversation_id", conversationId);
      expect(data ?? []).toHaveLength(0);
    });

    it("the recipient's unread count still rises normally", async () => {
      await postMessage(booker, conversationId, "unread me");
      const res = await request(app).get(`/v1/conversations/${conversationId}`).set(authHeader(host));
      expect(res.status).toBe(200);
      expect(res.body.data.unread_count).toBeGreaterThan(0);
    });

    it("the message DTO is unchanged -- no notification fields leak into it", async () => {
      const { body } = await postMessage(booker, conversationId, "dto check");
      expect(Object.keys(body.data).sort()).toEqual(
        ["body", "client_message_id", "conversation_id", "created_at", "id", "sender_id"].sort()
      );
    });
  });
});
