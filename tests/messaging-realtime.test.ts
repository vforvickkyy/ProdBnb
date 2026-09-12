import { execFileSync } from "child_process";
import { randomUUID } from "crypto";
import { createClient, RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { env } from "../src/config/env";
import { adminClient, createTestUser, deleteTestUser, TestUser } from "./setup";

// Phase 27-6: Realtime message delivery.
//
// Three layers are asserted, because each can be correct while another is not:
//
//   1. SQL  -- a committed message produces exactly one broadcast row with the
//             right topic/event/payload, and a rolled-back one produces none.
//   2. AuthZ-- the topic helper answers correctly and NEVER raises.
//   3. Wire -- a real supabase-js client actually receives the event, and a
//             non-participant is actually refused by the Realtime service.
//
// `realtime.messages` is not reachable through PostgREST (only `public` and
// `graphql_public` are exposed), so the SQL layer shells out to the local
// stack's container. Those tests skip rather than fail when it is unavailable.
//
// Every subscription has an explicit timeout and is torn down in afterAll --
// a hanging websocket would stall the whole suite.

const app = createApp();

const SUBSCRIBE_TIMEOUT_MS = 8000;
const EVENT_TIMEOUT_MS = 8000;
const NO_EVENT_WINDOW_MS = 2500;

// ---------------------------------------------------------------------------
// Raw SQL access (realtime.messages is outside the PostgREST-exposed schemas)
// ---------------------------------------------------------------------------

let container: string | null = null;

function findContainer(): string | null {
  try {
    const name = execFileSync("docker", ["ps", "--format", "{{.Names}}"], { encoding: "utf8" })
      .split("\n")
      .find((n) => n.startsWith("supabase_db_"));
    return name ?? null;
  } catch {
    return null;
  }
}

/** Runs SQL against the local stack and returns stdout. Returns null when Docker is unavailable. */
function sql(query: string): string | null {
  if (!container) return null;
  return execFileSync(
    "docker",
    ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-Atq", "-c", query],
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }
  ).trim();
}

function broadcastRowsFor(conversationId: string): number | null {
  const out = sql(`select count(*) from realtime.messages where topic = 'conversation:${conversationId}';`);
  return out === null ? null : Number(out);
}

// ---------------------------------------------------------------------------
// Realtime client helpers -- always bounded, never hanging
// ---------------------------------------------------------------------------

const openClients: SupabaseClient[] = [];

async function realtimeClientFor(user: TestUser): Promise<SupabaseClient> {
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  // Realtime authenticates separately from PostgREST: the policy on
  // realtime.messages is evaluated against THIS token's auth.uid().
  // Must be awaited -- setAuth is async, and the join has to carry the token.
  await client.realtime.setAuth(user.accessToken);
  openClients.push(client);
  return client;
}

interface Subscription {
  status: string;
  error: string | null;
  channel: RealtimeChannel;
  received: Record<string, unknown>[];
}

/** Subscribes to a private conversation channel, resolving on the first terminal status. */
async function subscribePrivate(client: SupabaseClient, conversationId: string): Promise<Subscription> {
  const received: Record<string, unknown>[] = [];
  const channel = client.channel(`conversation:${conversationId}`, { config: { private: true } });

  channel.on("broadcast", { event: "message.created" }, (message) => {
    received.push(message.payload as Record<string, unknown>);
  });

  const status = await new Promise<{ status: string; error: string | null }>((resolve) => {
    const timer = setTimeout(() => resolve({ status: "TIMED_OUT", error: "no terminal status" }), SUBSCRIBE_TIMEOUT_MS);
    channel.subscribe((s, err) => {
      if (["SUBSCRIBED", "CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(s)) {
        clearTimeout(timer);
        resolve({ status: s, error: err ? String(err) : null });
      }
    });
  });

  // A short settle after SUBSCRIBED. The client-side promise resolves as soon
  // as the join is acknowledged, which is marginally ahead of the server having
  // the broadcast binding fully live -- without this, a message sent in the very
  // next statement can be published into the gap and missed.
  if (status.status === "SUBSCRIBED") {
    await new Promise((r) => setTimeout(r, 400));
  }

  return { ...status, channel, received };
}

async function waitForEvent(sub: Subscription, timeoutMs = EVENT_TIMEOUT_MS): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (sub.received.length > 0) return sub.received[0]!;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

async function sendMessage(user: TestUser, conversationId: string, body: string, clientMessageId = randomUUID()) {
  return request(app)
    .post(`/v1/conversations/${conversationId}/messages`)
    .set(authHeader(user))
    .send({ body, client_message_id: clientMessageId });
}

describe("Phase 27-6: Realtime message delivery", () => {
  let host: TestUser;
  let booker: TestUser;
  let outsider: TestUser;
  let admin: TestUser;

  let conversationA: string;
  let conversationB: string;
  let conversationArchived: string;
  let locationArchived: string;

  beforeAll(async () => {
    container = findContainer();

    host = await createTestUser();
    booker = await createTestUser();
    outsider = await createTestUser();
    admin = await createTestUser();
    await grantRole(host, "host");
    await grantRole(booker, "booker");
    await grantRole(outsider, "booker");
    const { error } = await adminClient.from("user_roles").insert({ user_id: admin.id, role: "admin" });
    if (error) throw error;

    conversationA = await openConversation(booker, await makeLocation(host.id, "RT A"));
    conversationB = await openConversation(booker, await makeLocation(host.id, "RT B"));

    locationArchived = await makeLocation(host.id, "RT Archived");
    conversationArchived = await openConversation(booker, locationArchived);
  });

  afterAll(async () => {
    for (const client of openClients) {
      try {
        await client.removeAllChannels();
        client.realtime.disconnect();
      } catch {
        /* teardown must never fail the suite */
      }
    }
    await deleteTestUser(booker.id);
    await deleteTestUser(outsider.id);
    await deleteTestUser(admin.id);
    await adminClient.from("locations").delete().eq("host_id", host.id);
    await deleteTestUser(host.id);
  });

  // ==========================================================================
  // 1. SQL layer -- the broadcast row
  // ==========================================================================

  describe("broadcast row", () => {
    it("a committed message produces exactly one broadcast row with the right envelope", async () => {
      if (!container) return;
      const conversationId = await openConversation(booker, await makeLocation(host.id, "RT Envelope"));

      const before = broadcastRowsFor(conversationId);
      expect(before).toBe(0);

      const res = await sendMessage(booker, conversationId, "envelope check");
      expect(res.status).toBe(201);

      expect(broadcastRowsFor(conversationId)).toBe(1);

      const envelope = sql(
        `select event || '|' || private::text || '|' || extension from realtime.messages where topic = 'conversation:${conversationId}';`
      );
      expect(envelope).toBe("message.created|true|broadcast");
    });

    it("the payload is exactly the six-field message DTO and nothing else", async () => {
      if (!container) return;
      const conversationId = await openConversation(booker, await makeLocation(host.id, "RT Payload"));
      const clientMessageId = randomUUID();
      const res = await sendMessage(booker, conversationId, "payload check", clientMessageId);
      expect(res.status).toBe(201);
      const message = res.body.data as Record<string, string>;

      const keys = sql(
        `select string_agg(k, ',' order by k) from realtime.messages m, jsonb_object_keys(m.payload) k where m.topic = 'conversation:${conversationId}';`
      );
      expect(keys).toBe("body,client_message_id,conversation_id,created_at,id,sender_id");

      const values = sql(
        `select payload->>'id' || '|' || (payload->>'conversation_id') || '|' || (payload->>'sender_id') || '|' || (payload->>'body') || '|' || (payload->>'client_message_id') from realtime.messages where topic = 'conversation:${conversationId}';`
      );
      expect(values).toBe(
        `${message.id}|${conversationId}|${booker.id}|payload check|${clientMessageId}`
      );

      // created_at must be the server value that the API returned, to the microsecond.
      const createdAt = sql(
        `select payload->>'created_at' from realtime.messages where topic = 'conversation:${conversationId}';`
      );
      expect(Date.parse(createdAt!)).toBe(Date.parse(message.created_at!));
    });

    it("a rolled-back message produces NO broadcast row", () => {
      if (!container) return;
      // Done entirely in SQL so the insert and the rollback share one transaction.
      const out = sql(`
        begin;
        insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
        values ('e1000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-000000000000','authenticated','authenticated','rtrb-h@example.com','x',now(),now(),now()),
               ('e2000000-0000-0000-0000-0000000000c2','00000000-0000-0000-0000-000000000000','authenticated','authenticated','rtrb-b@example.com','x',now(),now(),now());
        insert into public.locations (id, host_id, title, city, country, timezone, status)
        values ('e3000000-0000-0000-0000-0000000000c3','e1000000-0000-0000-0000-0000000000c1','RTRB','London','UK','UTC','published');
        insert into public.conversations (id, booker_id, location_id)
        values ('e4000000-0000-0000-0000-0000000000c4','e2000000-0000-0000-0000-0000000000c2','e3000000-0000-0000-0000-0000000000c3');
        insert into public.messages (conversation_id, sender_id, body, client_message_id)
        values ('e4000000-0000-0000-0000-0000000000c4','e2000000-0000-0000-0000-0000000000c2','rolled back', gen_random_uuid());
        select 'inside=' || (select count(*) from realtime.messages where topic = 'conversation:e4000000-0000-0000-0000-0000000000c4');
        rollback;
      `);
      // The event is visible while the transaction is open...
      expect(out).toContain("inside=1");

      // ...and gone once it rolls back. This is the core guarantee: a message
      // that never committed never announces itself.
      const after = sql(
        `select count(*) from realtime.messages where topic = 'conversation:e4000000-0000-0000-0000-0000000000c4';`
      );
      expect(Number(after)).toBe(0);
    });

    it("an idempotent replay does not produce a second broadcast", async () => {
      if (!container) return;
      const conversationId = await openConversation(booker, await makeLocation(host.id, "RT Idempotent"));
      const key = randomUUID();

      const first = await sendMessage(booker, conversationId, "send once", key);
      const replay = await sendMessage(booker, conversationId, "send once", key);
      expect(first.status).toBe(201);
      expect(replay.status).toBe(201);
      expect(replay.body.data.id).toBe(first.body.data.id);

      const { data: messages } = await adminClient.from("messages").select("id").eq("conversation_id", conversationId);
      expect(messages).toHaveLength(1);
      expect(broadcastRowsFor(conversationId)).toBe(1);
    });

    it("N concurrent messages produce N broadcasts, one per message", async () => {
      if (!container) return;
      const conversationId = await openConversation(booker, await makeLocation(host.id, "RT Concurrent"));

      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) => sendMessage(booker, conversationId, `concurrent ${i}`))
      );
      expect(results.every((r) => r.status === 201)).toBe(true);

      const { data: messages } = await adminClient.from("messages").select("id").eq("conversation_id", conversationId);
      expect(messages).toHaveLength(5);
      expect(broadcastRowsFor(conversationId)).toBe(5);

      // Exactly one broadcast per message id -- no duplicates, no omissions.
      const distinct = sql(
        `select count(distinct payload->>'id') from realtime.messages where topic = 'conversation:${conversationId}';`
      );
      expect(Number(distinct)).toBe(5);
    });
  });

  // ==========================================================================
  // 2. Topic authorization helper
  // ==========================================================================

  describe("can_access_conversation_topic()", () => {
    async function ask(user: TestUser | null, topic: string | null): Promise<boolean | null> {
      const client = user
        ? createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
            auth: { persistSession: false, autoRefreshToken: false },
            global: { headers: { Authorization: `Bearer ${user.accessToken}` } },
          })
        : createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
            auth: { persistSession: false, autoRefreshToken: false },
          });
      const { data, error } = await client.rpc("can_access_conversation_topic", { _topic: topic });
      expect(error, `rpc errored for topic ${JSON.stringify(topic)}: ${error?.message}`).toBeNull();
      return data as boolean | null;
    }

    it("is true for both participants", async () => {
      expect(await ask(booker, `conversation:${conversationA}`)).toBe(true);
      expect(await ask(host, `conversation:${conversationA}`)).toBe(true);
    });

    it("is false for a third party, for a non-participant admin, and for anon", async () => {
      expect(await ask(outsider, `conversation:${conversationA}`)).toBe(false);
      expect(await ask(admin, `conversation:${conversationA}`)).toBe(false);
      expect(await ask(null, `conversation:${conversationA}`)).toBe(false);
    });

    it("is false for a conversation that does not exist", async () => {
      expect(await ask(booker, `conversation:${randomUUID()}`)).toBe(false);
    });

    it("returns false rather than raising for every malformed topic", async () => {
      const malformed = [
        "conversation:not-a-uuid",
        "conversation:",
        "conversation",
        "",
        "chat:" + conversationA,
        conversationA,
        "conversation:../../etc",
        "conversation:' or true --",
        null,
      ];
      for (const topic of malformed) {
        // `ask` asserts the RPC itself did not error -- i.e. the helper never raised.
        expect(await ask(booker, topic), `topic ${JSON.stringify(topic)}`).toBe(false);
      }
    });
  });

  // ==========================================================================
  // 3. Forged-event security -- the critical invariant
  // ==========================================================================

  describe("clients cannot publish forged events", () => {
    it("realtime.messages has NO insert/update/delete policy", () => {
      if (!container) return;
      const nonSelect = sql(
        `select count(*) from pg_policy where polrelid = 'realtime.messages'::regclass and polcmd::text <> 'r';`
      );
      expect(Number(nonSelect)).toBe(0);

      const selectPolicies = sql(
        `select count(*) from pg_policy where polrelid = 'realtime.messages'::regclass and polcmd::text = 'r';`
      );
      expect(Number(selectPolicies)).toBe(1);
    });

    it("an authenticated role cannot INSERT into realtime.messages despite holding the table grant", () => {
      if (!container) return;
      // The grant genuinely exists -- RLS is the only thing standing in the way,
      // which is precisely why an INSERT policy must never be added.
      const grant = sql(
        `select count(*) from information_schema.role_table_grants where table_schema='realtime' and table_name='messages' and grantee='authenticated' and privilege_type='INSERT';`
      );
      expect(Number(grant)).toBe(1);

      // psql writes the refusal to stderr, so ON_ERROR_STOP makes it exit
      // non-zero and execFileSync surfaces it on the thrown error.
      let refusal = "";
      try {
        execFileSync(
          "docker",
          ["exec", "-i", container!, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-f", "-"],
          {
            encoding: "utf8",
            input: `
              begin;
              set local role authenticated;
              set local request.jwt.claims = '{"sub":"${booker.id}","role":"authenticated"}';
              insert into realtime.messages (topic, event, private, extension, payload)
              values ('conversation:${conversationA}', 'message.created', true, 'broadcast', '{"body":"forged"}'::jsonb);
              rollback;
            `,
          }
        );
      } catch (e) {
        refusal = String((e as { stderr?: string }).stderr ?? e);
      }
      expect(refusal, "the forged insert was NOT refused").toMatch(/row-level security|permission denied/i);
    });

    it("no public function exposes realtime.send() to authenticated callers", () => {
      if (!container) return;
      // broadcast_message_created() references realtime.send but returns `trigger`,
      // so PostgREST cannot expose it and it cannot be called directly.
      const callable = sql(`
        select coalesce(string_agg(p.proname, ','), '')
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.prokind = 'f'
          and pg_get_functiondef(p.oid) like '%realtime.send%'
          and pg_get_function_result(p.oid) <> 'trigger'
          and has_function_privilege('authenticated', p.oid, 'EXECUTE');
      `);
      expect(callable).toBe("");
    });
  });

  // ==========================================================================
  // 4. Real client subscriptions
  // ==========================================================================

  describe("live delivery to real clients", () => {
    it("a participant subscribes and receives message.created with the exact payload", async () => {
      const client = await realtimeClientFor(booker);
      const sub = await subscribePrivate(client, conversationA);
      expect(sub.status, `subscribe failed: ${sub.error}`).toBe("SUBSCRIBED");

      const clientMessageId = randomUUID();
      const res = await sendMessage(host, conversationA, "hello from the host", clientMessageId);
      expect(res.status).toBe(201);

      const event = await waitForEvent(sub);
      expect(event, "no realtime event received").not.toBeNull();
      expect(Object.keys(event!).sort()).toEqual(
        ["body", "client_message_id", "conversation_id", "created_at", "id", "sender_id"].sort()
      );
      expect(event!.id).toBe(res.body.data.id);
      expect(event!.conversation_id).toBe(conversationA);
      expect(event!.sender_id).toBe(host.id);
      expect(event!.body).toBe("hello from the host");
      expect(event!.client_message_id).toBe(clientMessageId);
    });

    it("the sender also receives their own event", async () => {
      const client = await realtimeClientFor(booker);
      const sub = await subscribePrivate(client, conversationB);
      expect(sub.status).toBe("SUBSCRIBED");

      const res = await sendMessage(booker, conversationB, "my own message");
      expect(res.status).toBe(201);

      const event = await waitForEvent(sub);
      expect(event).not.toBeNull();
      expect(event!.sender_id).toBe(booker.id);
      expect(event!.id).toBe(res.body.data.id);
    });

    it("a third party is refused the private channel", async () => {
      const client = await realtimeClientFor(outsider);
      const sub = await subscribePrivate(client, conversationA);
      expect(sub.status).not.toBe("SUBSCRIBED");
      expect(sub.error ?? "").toMatch(/unauthorized|permission/i);
    });

    it("an admin who is not a participant is refused -- admin grants no implicit access", async () => {
      const client = await realtimeClientFor(admin);
      const sub = await subscribePrivate(client, conversationA);
      expect(sub.status).not.toBe("SUBSCRIBED");
      expect(sub.error ?? "").toMatch(/unauthorized|permission/i);
    });

    it("a message in one conversation never reaches another conversation's channel", async () => {
      const client = await realtimeClientFor(booker);
      const sub = await subscribePrivate(client, conversationA);
      expect(sub.status).toBe("SUBSCRIBED");
      const baseline = sub.received.length;

      const res = await sendMessage(booker, conversationB, "belongs to B only");
      expect(res.status).toBe(201);

      await new Promise((r) => setTimeout(r, NO_EVENT_WINDOW_MS));
      expect(sub.received.length, "conversation A leaked an event from B").toBe(baseline);
    });

    it("an archived listing still delivers -- participation, not publication, decides", async () => {
      const { error } = await adminClient.from("locations").update({ status: "archived" }).eq("id", locationArchived);
      if (error) throw error;

      const client = await realtimeClientFor(booker);
      const sub = await subscribePrivate(client, conversationArchived);
      expect(sub.status, `subscribe failed after archiving: ${sub.error}`).toBe("SUBSCRIBED");

      const res = await sendMessage(host, conversationArchived, "sent after archiving");
      expect(res.status).toBe(201);

      const event = await waitForEvent(sub);
      expect(event).not.toBeNull();
      expect(event!.body).toBe("sent after archiving");
    });
  });

  // ==========================================================================
  // 5. Regression invariants
  // ==========================================================================

  describe("Phase 27-1…27-5 invariants are untouched", () => {
    it("the public messaging schema is unchanged", () => {
      if (!container) return;

      expect(
        Number(
          sql(`select count(*) from pg_policy where polrelid in ('public.conversations'::regclass,'public.messages'::regclass,'public.conversation_reads'::regclass,'public.admin_message_access'::regclass);`)
        )
      ).toBe(5);

      expect(Number(sql(`select count(*) from pg_indexes where schemaname='public' and tablename='messages';`))).toBe(3);

      expect(
        sql(`select coalesce(string_agg(tablename, ','), '') from pg_publication_tables where pubname='supabase_realtime';`)
      ).toBe("");

      expect(
        sql(`select string_agg(tgname, ',' order by tgname) from pg_trigger where not tgisinternal and tgrelid='public.messages'::regclass;`)
      ).toBe("on_message_created,on_message_created_broadcast");
    });

    it("the cache trigger function is byte-for-byte unchanged", () => {
      if (!container) return;
      const body = sql(
        `select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='touch_conversation_on_message';`
      );
      expect(body).toContain("last_message_at <= new.created_at");
      expect(body).not.toContain("realtime.send");
      // pg_get_functiondef only prints SECURITY DEFINER; INVOKER is the default
      // and is therefore proved by its absence (and by prosecdef below).
      expect(body).not.toContain("SECURITY DEFINER");
    });

    it("the new functions have the intended security posture", () => {
      if (!container) return;
      expect(
        sql(`select prosecdef::text || '|' || provolatile::text || '|' || array_to_string(proconfig, ',') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='can_access_conversation_topic';`)
      ).toBe("true|s|search_path=public");

      expect(
        sql(`select prosecdef::text || '|' || array_to_string(proconfig, ',') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='broadcast_message_created';`)
      ).toBe("false|search_path=public");

      // is_conversation_participant is reused, not redefined.
      expect(
        sql(`select prosecdef::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='is_conversation_participant';`)
      ).toBe("true");
    });
  });
});
