# Phase 27-6 — Realtime Messaging: Inspection Report

**Inspection date:** 2026-09-12
**Starting commit:** `4a96bc631d7c287d379a1f09e2319b9adf95932f` (`perf: align message cursor with composite index`)
**Status:** Inspection only — nothing implemented, no migration, no code change.

Everything below was verified against the running local Supabase stack and the repository, not
inferred. Where a claim rests on a probe, the probe and its result are stated.

---

## 1. Current repository / Realtime state

**There is no Realtime anywhere in ProdBnb today.** Phase 27-6 would be the product's first and
only Realtime consumer. Verified by repo-wide search:

| Surface | Realtime / Broadcast / `.channel(` / `postgres_changes` hits |
|---|---|
| `ProdBnb Backend/src` + `tests` | **0** |
| iOS (`*.swift`) | **0** |
| Admin panel (`ProdBnb Admin/src`) | **0** |
| Backend `supabase/` + `docs/` | only `[realtime] enabled = true` in `config.toml` and prose in phase reports |

No Realtime migration, no publication membership, no `realtime.send()` call, no channel
subscription, no Realtime RLS policy, no Realtime env var (`src/config/env.ts` has none).

### Live Realtime infrastructure (local stack)

| Fact | Observed |
|---|---|
| Realtime service | `public.ecr.aws/supabase/realtime:v2.112.1`, **healthy** |
| `supabase/config.toml` | `[realtime] enabled = true` |
| `supabase_realtime` publication | exists, `puballtables=false`, **zero tables** → Postgres Changes currently delivers nothing |
| `realtime.messages` | RLS **enabled**, **zero policies** → deny-all |
| `realtime.messages` grants | `anon`, `authenticated`, `service_role` each hold **INSERT, SELECT, UPDATE** |
| `realtime.send(payload, event, topic, private)` | exists, `SECURITY INVOKER` |
| `realtime.broadcast_changes(...)`, `realtime.topic()` | exist |
| `realtime` schema USAGE + `send()` EXECUTE | granted to `anon` **and** `authenticated` |
| PostgREST exposed schemas | `public, graphql_public` only |
| `realtime.messages` storage | **daily-partitioned** (`messages_2026_09_11` … `_15`, ~3 days pre-created) |

Two consequences that shape the whole design:

**(a) RLS on `realtime.messages` is the only barrier.** Because `authenticated` holds a table-level
`INSERT` grant, the sole thing preventing a client from *publishing* a forged `message.created`
event is the absence of an INSERT policy. Phase 27-6 must add a **SELECT-only** policy and must
never add an INSERT one. (A client cannot reach `realtime.send()` directly today because PostgREST
exposes only `public`/`graphql_public` — which is also why **no `public` wrapper around
`realtime.send()` may be created**.)

**(b) Broadcast is delivery, not storage.** `realtime.messages` is partitioned daily and Supabase
reclaims it by dropping partitions. Nothing durable may ever live only there — which is exactly the
intended model.

---

## 2. Existing messaging architecture (Phases 27-1 … 27-5)

```
public.conversations   id, booker_id, location_id, booking_id,
                       last_message_at NOT NULL default now(), last_message_id → messages ON DELETE SET NULL,
                       created_at, updated_at   UNIQUE (booker_id, location_id)
public.messages        id, conversation_id → conversations ON DELETE CASCADE,
                       sender_id → profiles ON DELETE CASCADE, body (CHECK 1–4000 trimmed),
                       client_message_id, created_at default now()
                       UNIQUE (conversation_id, sender_id, client_message_id)
                       INDEX (conversation_id, created_at DESC, id DESC)
public.conversation_reads      (Phase 27-7 territory — untouched)
public.admin_message_access    (Admin Messaging — untouched, still unwritten)
```

**Triggers on `messages`: exactly one.**

```sql
on_message_created  AFTER INSERT FOR EACH ROW EXECUTE FUNCTION touch_conversation_on_message()

-- plpgsql, SECURITY INVOKER, VOLATILE, returns null
update public.conversations
   set last_message_id = new.id, last_message_at = new.created_at
 where id = new.conversation_id
   and last_message_at <= new.created_at;   -- monotonic guard
```

**Functions**

| Function | Security | Volatility | Note |
|---|---|---|---|
| `is_conversation_participant(_conversation_id uuid)` | **DEFINER** | stable | reads `auth.uid()` internally, takes **no** user id, fails closed |
| `get_conversation_messages(...)` | INVOKER | stable | RLS is the boundary; Phase 27-5 row-comparison cursor |
| `get_conversations_for_viewer(...)` | DEFINER | stable | Inbox read model; never reads `public.messages` |
| `touch_conversation_on_message()` | INVOKER | volatile | the trigger above |

**RLS: 5 messaging policies.** `conversations_select_participant`, `messages_select_participant`,
`conversation_reads_select_own`, `conversation_reads_write_own`, `admin_message_access_select_admin_only`.

**Grants (`authenticated`):** `conversations: SELECT`, `messages: SELECT`,
`conversation_reads: INSERT,SELECT,UPDATE`, `admin_message_access: SELECT`. **`messages` has no
INSERT/UPDATE/DELETE grant at all** — every write goes through the backend's service-role client
after API-level authorization.

### Where an event can safely be introduced

The only correct insertion point is **inside the `messages` INSERT transaction**, because that is
the only place where "the message committed" and "the event fired" can be made the same fact. The
backend has no multi-statement transaction facility (only `@supabase/supabase-js`; one PostgREST
request = one implicit transaction), so this must be a trigger.

---

## 3. Transaction / atomicity findings

**Probed, not assumed.**

| Property | Evidence |
|---|---|
| `realtime.send()` inserts into `realtime.messages` with `extension='broadcast'`, `private=true` | probe: `rows=1 topic=conversation:probe event=message.created private=t extension=broadcast` |
| **`realtime.send()` is fully transactional** | same probe rolled back → `rows=0`. **A rolled-back message produces no event.** |
| A broadcast failure cannot fail the message insert | `realtime.send()`'s body wraps everything in `BEGIN … EXCEPTION WHEN OTHERS THEN RAISE WARNING 'WarnSendingBroadcastMessage: %'` — verified in source |
| A trigger exception *does* roll back the message | Phase 27-5 inspection probe P1 (`RAISE EXCEPTION` in the trigger → `messages persisted = 0`) |
| The message write path is already atomic with the conversation cache | Phase 27-4/27-5, proven under real two-session lock contention |

So Postgres remains authoritative by construction: the event exists **iff** the message committed,
and a Realtime outage degrades to "no live event" rather than to data loss or a phantom message.

The flip side, which drives §6: because `realtime.send()` swallows its own errors, **the backend
gets no signal that a broadcast failed**. Client-side reconciliation is mandatory, not optional.

### Approach comparison (detail in §14)

Extending `touch_conversation_on_message()` and adding a *separate* trigger are both atomic and
both correct. A backend/API publish-after-insert is **not** atomic — a crash between commit and
publish loses the event silently — and adds a dual-write path the architecture has deliberately
avoided since Phase 27-4. Postgres Changes is atomic but has the authorization and payload problems
in §14.

---

## 4. Authorization findings

**Business rule:** only conversation participants may receive that conversation's events.

**The existing primitives are sufficient.** `is_conversation_participant(_conversation_id uuid)` is
already `SECURITY DEFINER`, `stable`, `search_path`-pinned, reads `auth.uid()` internally, takes no
caller-supplied user id, and fails closed — exactly the contract a Realtime policy needs. It is the
same predicate `messages_select_participant` uses, so Realtime authorization and API authorization
cannot drift.

**Current state is fail-closed, and proven so.** A real client subscribing to a private channel
today is rejected:

```
private-channel subscribe status: CHANNEL_ERROR
  err: Unauthorized: You do not have permissions to read from this Channel topic: conversation:…
```

**Recommended shape**

| Decision | Recommendation |
|---|---|
| Channel name | `conversation:<conversation_uuid>` |
| Conversation UUID in the name? | **Yes** — it is a v4 UUID the participant already holds, and the policy authorizes regardless (§12) |
| Private channels? | **Yes, mandatory.** `private: true` is what makes Realtime consult `realtime.messages` RLS at all. A non-private channel is unauthenticated — anyone guessing the topic receives everything |
| Where authorization lives | **Realtime RLS on `realtime.messages`**, delegating to the same DB helper the API uses. Both layers, one predicate |
| Reuse `is_conversation_participant()`? | **Yes** — but it cannot be called directly from the policy (§ below) |
| New helper needed? | **Yes, one**: a topic-parsing wrapper |
| Service-role exposure | `service_role` has `BYPASSRLS`, so the trigger's `realtime.send()` succeeds. No client holds service_role. **Do not create a `public` wrapper around `realtime.send()`** — that would hand `authenticated` a publish path |
| Admin | **Nothing.** No admin branch. Admin Messaging stays the separate, audited `admin_message_access` path |

**⚠️ Implementation trap — safe topic parsing.** The policy must turn `realtime.topic()` (text) into
a UUID. A naive `split_part(realtime.topic(), ':', 2)::uuid` **throws** on a malformed topic, and
PostgreSQL does not guarantee `AND` short-circuits, so a regex guard in the same expression is not
reliably protective. The cast error surfaces as a subscribe failure rather than a clean deny.

Recommendation: one small `SECURITY DEFINER`, `search_path`-pinned helper — e.g.
`public.can_access_conversation_topic(_topic text) returns boolean` — written in `plpgsql` with an
explicit exception handler that returns `false` on any parse failure, and which delegates to
`is_conversation_participant()`. Fail-closed by construction, and it keeps the policy expression
trivial.

---

## 5. Event payload recommendation

**Use the exact six-field message DTO, unchanged, with no envelope.**

```json
{
  "id": "uuid",
  "conversation_id": "uuid",
  "sender_id": "uuid",
  "body": "…",
  "client_message_id": "uuid",
  "created_at": "2026-09-12T09:14:02.481233+00:00"
}
```

Reasoning:

- **`id` is the dedupe key** and `client_message_id` is what lets a sender reconcile its optimistic
  bubble. Both must be present; both already are.
- Identical to what `GET /v1/conversations/:id/messages` returns, so a client has **one** message
  shape and one parser, and a reconnect merge is a straight union by `id`.
- **No envelope is needed.** Realtime already carries `event` and `topic` out of band, so an
  in-payload `type`/`action` would duplicate the channel contract.
- **No separate server timestamp.** `created_at` *is* the server timestamp and is the ordering key.
- Exposes nothing new: no profile fields, no listing, no booking, no read state, no authorization
  internals, no admin data, no database-only columns. The message body is already visible to both
  participants through the API.

**Event name:** `message.created` — one event type in 27-6. `conversation.read` belongs to 27-7.

> Note the payload is delivered to a channel whose *only* permitted subscribers are the two
> participants, so this exposes nothing the API does not already expose to the same people.

---

## 6. Client subscription / reconciliation recommendation

**Model: Realtime is delivery; PostgreSQL/API is truth.** A client must be able to reach correct
state using the API alone.

```
Open conversation
  1. GET /v1/conversations/:id/messages?limit=50        → newest page (authoritative)
  2. subscribe to `conversation:<id>` with private: true
  3. AFTER subscribing, re-fetch step 1 once and merge   ← closes the gap between 1 and 2

Send
  4. POST …/messages  (client_message_id generated once, reused on every retry)
  5. render optimistically, keyed by client_message_id
  6. reconcile on whichever arrives first — the 201 response or the broadcast — by server `id`

Receive
  7. on message.created: if `id` already held → ignore; else insert and re-sort

Reconnect
  8. on every (re)subscribe, repeat the reconcile fetch; page backwards with `cursor`
     until a page overlaps an id already held
```

Step 3 matters: a message committed between the initial fetch and the subscription would otherwise
be missed forever.

**Step 8 needs no new API.** The Phase 27 master inspection anticipated a forward `after_cursor`
for gap-fill, but the existing backwards `cursor` is sufficient: fetch the newest page, and if its
oldest row is still newer than the newest locally-held message, page backwards again. A forward
cursor is an optimisation, not a requirement — **recommend deferring it** so 27-6 needs no API
change at all.

**Deduplication: by server `id`, always and everywhere.** One rule covers the POST-response/broadcast
race, reconnect overlap, a retried POST, and the echo of a message sent from the user's other
device. `client_message_id` has exactly one job — reconciling the local optimistic bubble — and is
useless for deduplicating the counterparty's messages, which carry *their* client id.

---

## 7. Ordering / concurrency findings

Phase 27-4/27-5 established a deterministic total order: `(created_at, id)`, with `created_at`
server-assigned (`default now()`, no client input possible — `messages` has no `authenticated`
INSERT grant) and `id` breaking ties.

**Realtime introduces no new ordering guarantee and must not be trusted as ordered.** Events are
published at commit time, and two messages committing in quick succession can be delivered in
either order. This is not a defect to fix — it is why the authoritative order lives in the API.

Recommendation:

- **Clients must sort by `(created_at, id)`** after every insert, exactly as the history endpoint
  orders. Never rely on arrival order.
- **Treat the Realtime layer as unordered, at-most-once hints.** Duplicates are possible and are
  absorbed by id-dedupe; misses are possible and are absorbed by the reconcile fetch.
- Tied timestamps are already handled — the tie-break is `id DESC`, and Phase 27-4 has a
  three-pair tied-timestamp pagination walk proving determinism.
- Concurrent sends are already safe: the unique index serialises idempotent retries, and the
  monotonic cache guard was proven order-independent under real lock contention (Phase 27-5).

---

## 8. SDK / configuration findings

| Item | Finding |
|---|---|
| Backend `@supabase/supabase-js` | spec `^2.45.4`, **resolved 2.114.0** — includes `RealtimeClient`. **No new package needed** |
| Admin panel | `@supabase/supabase-js ^2.45.4` — same, unused for Realtime |
| iOS | `supabase-swift 2.55.1` linked as the umbrella `Supabase` product; `Sources/RealtimeV2` provides `isPrivate`, `broadcastStream(event:)`, `setAuth`. **No new SPM dependency** (Phase 28 concern) |
| Client construction | `src/lib/supabase.ts` builds three clients with `auth: { persistSession: false, autoRefreshToken: false }` and **no `realtime` config block** — defaults apply |
| Does the backend need Realtime? | **No.** Under the recommended design the backend never touches the Realtime API: the database publishes, and clients subscribe directly with their own Supabase session |
| Can clients subscribe directly? | **Yes**, with their own Supabase JWT — which is also what makes RLS-based authorization work |
| New env vars | **None.** Clients use the existing `SUPABASE_URL` / anon key |

---

## 9. Local testing findings — the transport works locally

**Proven end-to-end.** A Node client using the repo's own `@supabase/supabase-js` subscribed to the
local stack and received a Postgres-originated broadcast:

```
subscribe status: SUBSCRIBED
db send issued                       ← select realtime.send(payload,'message.created',topic,false)
RESULT: EVENT RECEIVED
payload: {"id":"abc","body":"hello from postgres"}
```

This is exactly the Phase 27-6 delivery path. **Phase 27-6 is locally testable in Vitest** — no
staging dependency for the core behaviour.

| Testable how | What |
|---|---|
| **Pure SQL** (fastest, most of the matrix) | a message insert writes a `realtime.messages` row with the right topic/event/payload; a rolled-back insert writes none; an idempotent replay (`23505`) writes none; concurrent inserts write one row each; the policy predicate returns true/false for participant / non-participant / admin / anon |
| **Real client subscription** (supabase-js in Vitest) | authorized participant actually receives; non-participant subscribe is rejected; payload shape on the wire |
| **Requires the Realtime service** | anything asserting actual delivery (the container is part of `supabase start`, so this is available locally) |
| **Requires staging / manual** | only behaviour under the hosted Realtime configuration — see §10 |

Private-channel *authorization* cannot be tested until 27-6 creates the policy (today every private
subscribe is denied, as proven). That is expected: the policy is the thing under test, and it
becomes locally testable the moment it exists.

**Practical note for the implementer:** a subscription test must guard against hanging — subscribe
with an explicit timeout and fail/skip cleanly, as the probes in this inspection did. Vitest's
`testTimeout` is 15s and `fileParallelism` is off, so a realtime test file will serialise with the
rest.

---

## 10. Staging findings

Repository-accessible evidence only — **the Supabase MCP connector on this machine is authorised
for a different organisation and is refused on the ProdBnb staging project (`yspyemtiepgcoovjrgin`),
so staging could not be read directly.** Everything below must be confirmed in the dashboard before
rollout.

| Question | Repo-accessible answer |
|---|---|
| Is Realtime enabled on staging? | **Unverified.** Realtime is on by default for Supabase projects, and `config.toml` has it enabled locally. Must be confirmed in the dashboard |
| Required Realtime configuration | Broadcast-from-database needs **no** project setting beyond Realtime being on; it is driven entirely by the migration |
| Private Broadcast supported? | Yes — a function of the Realtime version, and the migration supplies the policy |
| Publication change needed? | **No.** Broadcast does not use `supabase_realtime`; that publication is for Postgres Changes and must stay empty |
| Staging env vars sufficient? | **Yes.** No new variable. Per the 26-MB deployment report the staging project has 16 vars, none Realtime-related, and none is needed |
| Apple/APNs setup relevant? | **No** — that is Phase 27-8 |

**Change classification**

| Category | Phase 27-6 content |
|---|---|
| Repository changes | one migration, one test file, doc updates. **No `src/` change** |
| SQL migration changes | topic-authorization helper, `realtime.messages` SELECT policy, broadcast trigger function + trigger |
| Supabase dashboard / manual | **confirm Realtime is enabled** on staging (expected: already on). Nothing else |
| Frontend configuration | none in 27-6 (iOS subscription is Phase 28) |
| Backend configuration | none — no env var, no client change |

---

## 11. Failure modes

| Scenario | Expected behaviour |
|---|---|
| DB insert succeeds, Realtime delivery fails | Message persisted and returned by the API. No event, or an event nobody receives. Client recovers on its next reconcile fetch. **`realtime.send()` swallows its own errors, so this can never fail the insert — and the backend is never told** |
| DB insert rolls back | **No event.** Proven: the `realtime.send()` row disappeared with the rollback |
| Broadcast trigger raises | The whole INSERT aborts — message not persisted, no event, client gets a 5xx and may retry with the same `client_message_id`. Consistent, if blunt. `realtime.send()` makes this very unlikely since it catches internally |
| Client subscription fails | History still loads over HTTPS; the conversation is usable without live updates |
| Client disconnects | supabase-js auto-reconnects; on re-subscribe the client re-runs the reconcile fetch |
| Client reconnects | Gap filled by paging backwards until a page overlaps a held `id` |
| Duplicate event | Ignored — dedupe by server `id` |
| Event arrives **before** the POST response | Rendered immediately; the 201 then matches by `id` and the optimistic bubble is reconciled via `client_message_id` |
| Event arrives **after** the POST response | Already held; ignored |
| Simultaneous messages | Both persist (unique index handles retries); both events fire; client sorts by `(created_at, id)` |
| Unauthorized client subscribes | Rejected by `realtime.messages` RLS before any payload is sent. Today's baseline is deny-all, proven |
| Conversation becomes inaccessible | Participation is permanent in the current model; a non-participant never had access |
| Listing unpublished/archived | **No effect** — Phase 27-2/27-3 key access on participation, not publication. Both read and write continue, so the channel must too |
| Account deletion / retention | Deleting a booker cascades the conversation away; subscribers to a dead topic simply receive nothing. **The open retention decision is unchanged and unaffected by 27-6** |
| Stale subscription (client holds a channel for a conversation it can no longer see) | Authorization is evaluated at subscribe time, so a long-lived socket could outlive a revocation. Not reachable today (participation is permanent) — flagged for whenever revocation becomes possible |

---

## 12. Security analysis

| Concern | Assessment |
|---|---|
| Can message bodies leak through Realtime? | Only to subscribers of `conversation:<id>`, and only participants can subscribe. The body is already visible to those two people via the API |
| Can non-participants subscribe? | No — `realtime.messages` RLS. Today deny-all, proven with a real client |
| Do conversation IDs reveal anything? | No. v4 UUIDs, unguessable, and the policy authorizes regardless of whether an id is known. The id is already in every API response to participants |
| Are private channels required? | **Yes, non-negotiably.** A non-private channel bypasses `realtime.messages` RLS entirely |
| Is authorization evaluated with `auth.uid()`? | Yes — via `is_conversation_participant()`, which reads it internally and accepts no caller-supplied identity |
| **Could a client publish forged events?** | **This is the sharpest risk.** `authenticated` holds a table-level `INSERT` grant on `realtime.messages`; only the absence of an INSERT policy stops it. Phase 27-6 must add **SELECT only** and must never create a `public` wrapper around `realtime.send()` (which `authenticated` already has EXECUTE on, reachable only because PostgREST does not expose the `realtime` schema) |
| Could service-role expose all conversations? | `service_role` bypasses RLS, which is why the trigger's send works — but no client holds that key, and the backend is not in the delivery path |
| Must Admin stay separate? | **Yes.** No admin arm in the policy. Admin access remains the audited `admin_message_access` path |
| Is any existing policy weakened? | **No.** 27-6 adds one policy in the `realtime` schema; the five `public` messaging policies and all grants are untouched |

---

## 13. Performance / scalability

Grounded in ProdBnb's actual model: **two-party** conversations in a booking marketplace.

| Dimension | Assessment |
|---|---|
| Channel topology | **One channel per conversation.** Fanout is 2. A shared per-user channel would require server-side filtering and would leak topic structure; per-conversation keeps authorization trivially aligned with the policy |
| Subscription count | One per open conversation per device — realistically 1. The Inbox does **not** need to subscribe to every thread (it refetches; live Inbox ordering is a later concern) |
| Trigger overhead | Measured in Phase 27-5: 5,000 message inserts including 5,000 trigger executions in **94.5 ms** (~19 µs/message). Adding a `realtime.send()` adds one small insert into a partitioned table per message — same order of magnitude |
| Broadcast overhead | One `realtime.messages` row per message; Supabase drops partitions on a daily cycle |
| Payload size | Bounded by the body CHECK at 4,000 characters plus five UUIDs/timestamps — a few KB worst case |
| High-volume conversations | Message *history* cost is flat after Phase 27-5 (index-aligned cursor). Realtime cost is per-event, not per-history |
| Concurrent sends | Already proven safe; the conversation row is the only serialisation point |
| Is the conversation row a contention point? | Yes in principle — every message updates it — but with two participants this is not a realistic bottleneck. Unchanged by 27-6 |
| New index needed? | **No.** Broadcast reads nothing; `realtime.messages` carries its own partition indexes |

No premature optimisation warranted.

---

## 14. Architecture comparison

| | **A. Trigger → `realtime.send()` (extend existing trigger)** | **B. Postgres Changes on `messages`** | **C. Backend publishes after insert** | **D. Separate dedicated broadcast trigger** |
|---|---|---|---|---|
| Atomicity | ✅ same transaction | ✅ WAL, post-commit | ❌ crash between commit and publish loses the event | ✅ same transaction |
| Authorization | ✅ once at subscribe, via `realtime.messages` RLS | ⚠️ RLS re-evaluated **per subscriber per change** | ✅ | ✅ |
| Rollback → no event | ✅ proven | ✅ | ❌ can publish for a rolled-back write if ordered wrongly | ✅ proven |
| Duplicate risk | low (dedupe by `id`) | low | ⚠️ retry logic can double-publish | low |
| Ordering | unordered hints; API authoritative | unordered hints | unordered hints | unordered hints |
| Payload control | ✅ explicit | ❌ **the raw row** — every future column auto-exposed | ✅ explicit | ✅ explicit |
| Complexity | low | medium (publication + REPLICA IDENTITY + global surface) | medium (new HTTP path, retries) | low |
| Operational risk | low | ⚠️ enabling a project-wide mechanism ProdBnb has never used | ⚠️ dual-write | low |
| Scalability | O(1) per message | O(subscribers × changes) policy evaluations | O(1) | O(1) |
| Fits existing code | ✅ trigger precedent exists | ✗ | ✗ contradicts the no-dual-write stance since 27-4 | ✅ same precedent |
| Future iOS/Android/Web | ✅ identical for all | ✅ | ✅ | ✅ |
| Suits ProdBnb V1 | ✅ | ✗ | ✗ | ✅ **best** |

### Recommendation: **Option D — a separate, dedicated `AFTER INSERT` broadcast trigger**

A and D are both correct and atomic; D is preferred, narrowly but deliberately:

1. **Separation of concerns.** `touch_conversation_on_message()` maintains a *data invariant*; a
   broadcast is a *delivery side effect*. Phase 27-5 just demonstrated how subtle that function is
   (its monotonic guard, its interaction with EvalPlanQual). Leaving it byte-identical preserves the
   27-4 and 27-5 verification rather than re-opening it.
2. **The guard must not leak into the broadcast.** The cache update is conditional
   (`last_message_at <= new.created_at`) and legitimately does nothing for an out-of-order insert.
   The broadcast must fire **unconditionally**. Two functions make that impossible to get wrong;
   one function invites exactly that bug.
3. **Trigger ordering is deterministic and favourable.** PostgreSQL fires `AFTER INSERT` triggers in
   **name order**, so `on_message_created` sorts before e.g.
   `on_message_created_broadcast` — cache first, publish second. Both are in the same transaction,
   so this affects nothing a client can observe, but it is the tidier order.
4. Phase 27-6 can be reverted by dropping one trigger and one policy, touching nothing from 27-4/27-5.

B is rejected on authorization cost and payload coupling; C on atomicity.

---

## 15. Recommended Phase 27-6 scope

### Must implement now

1. `public.can_access_conversation_topic(_topic text) returns boolean` — `SECURITY DEFINER`,
   `search_path = public`, `stable`, plpgsql with an exception handler returning `false` on any
   parse failure; delegates to `is_conversation_participant()`.
2. **SELECT-only** RLS policy on `realtime.messages` for `authenticated`, gated on
   `extension = 'broadcast'` and the helper. **No INSERT/UPDATE/DELETE policy.**
3. `public.broadcast_message_created()` trigger function + `AFTER INSERT FOR EACH ROW` trigger on
   `messages`, publishing the six-field DTO as `message.created` to `conversation:<id>` with
   `private => true`.
4. Tests (§17) and documentation (§18).

**Notably: no `src/` change, no API change, no DTO change, no new env var, no new dependency, and no
publication change.** Phase 27-6 is a database-plus-tests phase.

### Should explicitly defer

Read/unread and `conversation.read` events (27-7); APNs, message notifications and preferences
(27-8); Admin Messaging access and UI; forward `after_cursor` (not required — §6); live Inbox
ordering / per-user channels; typing, presence, attachments, reactions, voice; E2E encryption;
durable outbound offline queue; iOS/Android/Web subscription code (Phase 28).

---

## 16. Proposed migration / file plan

**Create**

| File | Contents |
|---|---|
| `supabase/migrations/<ts>_phase27_6_realtime_broadcast.sql` | the helper, the `realtime.messages` SELECT policy, the broadcast trigger function + trigger, and its `grant execute` |
| `tests/messaging-realtime.test.ts` | §17 matrix |
| `docs/PHASE_27_6_REPORT.md` | mandatory persistent report |

**Modify:** `docs/DATABASE.md`, `docs/API.md` (a short "live delivery" note — the REST contract is
unchanged).

**Leave untouched:** every `src/` file, all five earlier messaging migrations,
`touch_conversation_on_message()`, the `supabase_realtime` publication, all `public` RLS policies
and grants.

**Rollback:** `drop trigger` + `drop function` + `drop policy`. Because the policy is the *only*
thing granting subscribe access, dropping it returns the system to today's deny-all baseline. No
data migration, nothing to backfill, no destructive DDL.

---

## 17. Proposed test matrix

**Automatable locally** (the transport is proven to work locally — §9):

*SQL-level, fast*
- a message insert writes exactly one `realtime.messages` row with topic `conversation:<id>`,
  event `message.created`, `private = true`, `extension = 'broadcast'`
- the payload contains exactly the six DTO fields and **no** others
- a **rolled-back** insert writes **no** row
- an idempotent replay (`23505`) writes **no** second row
- N concurrent inserts write N rows, one per message
- the policy predicate: `true` for booker, `true` for host, `false` for a third party, `false` for a
  non-participant **admin**, `false` for anon, `false` for a malformed/garbage topic, `false` for a
  nonexistent conversation
- the helper returns `false` rather than raising on `conversation:not-a-uuid`, `nonsense`, `''`
- `touch_conversation_on_message()` and the 5 `public` policies are unchanged

*Real client subscription (supabase-js, with explicit timeouts)*
- an authorized **participant** receives `message.created` on the right channel with the right payload
- the **sender** also receives their own event
- a **non-participant** subscribe is rejected
- an **admin** who is not a participant is rejected
- a message in conversation A does not appear on conversation B's channel
- an **archived listing** still delivers (participation, not publication)

*Regression*
- all 181 existing messaging tests unchanged
- `messages` still has exactly 3 indexes; 5 `public` messaging policies; grants unchanged;
  `supabase_realtime` publication still empty

**Requires staging / manual verification**
- Realtime is enabled on the staging project
- a real device/client subscribes against staging and receives an event end-to-end
- behaviour under the hosted Realtime rate limits and connection caps

---

## 18. Documentation impact

| File | Change |
|---|---|
| `docs/DATABASE.md` | new Phase 27-6 section: the broadcast trigger, why it is separate from the cache trigger, the `realtime.messages` SELECT-only policy and why no INSERT policy may ever be added, the topic-parsing trap, and the transactional guarantee |
| `docs/API.md` | short note that message delivery is also broadcast live on `conversation:<id>`, that the payload is the identical six-field DTO, and that the REST contract is unchanged; plus the client reconciliation sequence from §6 |
| `docs/PHASE_27_6_REPORT.md` | new, mandatory |
| Environment/setup docs | **no change** — no new env var or dependency |

---

## 19. Deferred items (carried forward)

- **Account deletion / retention** — still open, needs product/legal sign-off. Unaffected by 27-6.
- **`last_message_at` deletion gap** — carried with that decision (Phase 27-5 D2).
- Phase 27-7 read/unread; Phase 27-8 notifications/APNs; Admin Messaging.
- Forward `after_cursor`; live Inbox ordering; host-initiated conversations.
- Pre-existing `locations.service.ts:433` error message naming only bookings.
- Per-instance (non-distributed) rate limiter.
- Phase 27-1 / 27-2 persistent reports (deliberately not backfilled).

---

## 20. Risks and open questions

| # | Item | Severity | Note |
|---|---|---|---|
| 1 | **An INSERT policy on `realtime.messages` would hand every client a forged-event capability** | **Critical** | `authenticated` already holds the table grant. SELECT-only, and no `public` wrapper around `realtime.send()`. Worth an explicit test |
| 2 | Topic parsing can raise instead of denying | High | Use a plpgsql helper with an exception handler; do not rely on `AND` short-circuiting |
| 3 | Staging Realtime status unverified | Medium | MCP is authorised for a different org; confirm in the dashboard before rollout |
| 4 | Broadcast failures are silent by design | Medium | `realtime.send()` swallows errors. Mandates the client reconcile step; consider watching Postgres logs for `WarnSendingBroadcastMessage` |
| 5 | Realtime delivery is unordered and at-most-once | Medium | Client sorts by `(created_at, id)` and dedupes by `id` |
| 6 | Subscribe-time authorization can outlive a revocation | Low | Not reachable today — participation is permanent |
| 7 | `realtime.messages` partition retention | Low | Daily partitions, dropped by Supabase. Never treat Broadcast as storage |
| 8 | Should the Inbox subscribe live? | Open (product) | Recommend not in 27-6 — it needs per-user channels and interacts with 27-7 unread |

---

## 21. Final recommendation

**Proceed with Phase 27-6, implementing Option D** — a separate, dedicated `AFTER INSERT` broadcast
trigger calling `realtime.send()` on a **private** `conversation:<uuid>` channel, authorized by a
**SELECT-only** RLS policy on `realtime.messages` that delegates to the existing
`is_conversation_participant()` through a fail-closed topic-parsing helper. Payload is the existing
six-field message DTO; event is `message.created`.

The evidence supports this concretely rather than by analogy: `realtime.send()` is transactional
(rollback produced no event), the end-to-end path already works against the local stack (a Node
client received a Postgres-originated broadcast), the current posture is provably fail-closed (a
private subscribe was rejected), and the authorization predicate the policy needs already exists and
is already the one the API uses.

Scope is small and reversible: **one migration, one test file, two doc updates, and no source-code
change at all.** Rollback is dropping one trigger and one policy, which returns the system to
today's deny-all baseline.

The one thing to get right, and the reason this report exists, is that **`authenticated` already
holds an INSERT grant on `realtime.messages`** — so the policy must be SELECT-only, and no `public`
wrapper around `realtime.send()` may ever be created.
