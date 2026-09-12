# Phase 27-6 — Realtime Messaging (Broadcast)

**Status:** ✅ Implemented and verified
**Date:** 2026-09-12
**Starting commit:** `4a96bc631d7c287d379a1f09e2319b9adf95932f` (`perf: align message cursor with composite index`)
**Approved architecture:** Option D — separate dedicated `AFTER INSERT` Broadcast trigger
**Inspection:** `docs/PHASE_27_6_INSPECTION_REPORT.md`

All results below are **observed**, not intended.

---

## 1. Implementation summary

Live message delivery over Supabase Realtime Broadcast, published from the database inside the
message INSERT's own transaction. PostgreSQL remains the source of truth; Realtime is delivery only.

**Database-only phase: no `src/` change, no API change, no DTO change, no new dependency, no new
environment variable, and no change to the `supabase_realtime` publication.**

```
INSERT into public.messages   (service-role, after API authorization)
   ├── on_message_created            → touch_conversation_on_message()   cache (27-4/27-5, UNCHANGED)
   └── on_message_created_broadcast  → broadcast_message_created()       realtime.send(), private
```

## 2. Migration

`supabase/migrations/20260912235900_phase27_6_realtime_broadcast.sql`

## 3. Database objects created

| Object | Kind | Verified posture |
|---|---|---|
| `public.can_access_conversation_topic(text)` | function | `prosecdef = true` (**DEFINER**), `provolatile = s` (**STABLE**), `proconfig = search_path=public` |
| `messaging_broadcast_participant_select` on `realtime.messages` | policy | `cmd = r` (**SELECT only**), role `authenticated` |
| `public.broadcast_message_created()` | trigger function | `prosecdef = false` (**INVOKER**), `proconfig = search_path=public` |
| `on_message_created_broadcast` | trigger | `AFTER INSERT ... FOR EACH ROW` on `public.messages` |

Nothing else was created, altered or dropped.

## 4. Channel / event / payload contract

| | |
|---|---|
| Channel | `conversation:<conversation_id>`, subscribed with **`private: true`** |
| Event | `message.created` |
| Payload | exactly the six-field message DTO |

```json
{ "id": "…", "conversation_id": "…", "sender_id": "…",
  "body": "…", "client_message_id": "…", "created_at": "…" }
```

Observed payload keys on the wire: `body,client_message_id,conversation_id,created_at,id,sender_id`
— and nothing else. No envelope (Realtime carries `event` and `topic` out of band), no type/action,
no profile, listing, booking, read-state, admin or server-metadata field. `created_at` matches the
API's value to the microsecond (asserted by `Date.parse` equality against the POST response).

## 5. Authorization model

```
subscribe conversation:<uuid> (private)
   └─ realtime.messages SELECT policy
        ├─ extension = 'broadcast'
        └─ can_access_conversation_topic(realtime.topic())     ← fail-closed parser
             └─ is_conversation_participant(<uuid>)            ← REUSED, reads auth.uid()
```

`is_conversation_participant()` is reused rather than re-implemented, so Realtime authorization and
API authorization cannot drift — it is the same predicate `messages_select_participant` uses, it
reads `auth.uid()` internally, and it accepts no caller-supplied identity. **No admin arm.**

**Fail-closed topic parsing.** An inline `split_part(...)::uuid` would *raise* on a malformed topic,
and PostgreSQL does not guarantee `AND` short-circuits, so a regex guard in the same expression is
not reliably protective — and a raise surfaces as a subscribe error rather than a clean deny. The
helper is `plpgsql` with an explicit exception handler, making "malformed" and "not a participant"
the same answer: `false`.

Observed for every malformed input — all `false`, **none raising**: `conversation:not-a-uuid`,
`conversation:`, `conversation`, `""`, `chat:<uuid>`, a bare uuid, `conversation:../../etc`,
`conversation:' or true --`, and `null`.

## 6. Transaction / atomicity behaviour

`realtime.send()` writes into `realtime.messages`, so it joins the message INSERT's transaction.

**Observed:** inside an open transaction the broadcast row is present (`inside=1`); after `rollback`
the count is **0**. *A message exists ⟺ its event was published*, and **a rolled-back message
produces no event.**

The converse does not hold by design: `realtime.send()` wraps its body in
`EXCEPTION WHEN OTHERS THEN RAISE WARNING`, so a Realtime malfunction can never fail a message
insert — **and the backend is never told**. Client reconciliation against the history endpoint is
therefore mandatory, and is documented in `docs/API.md`.

This is also why the publish is a trigger rather than an API-side second statement: the backend has
no multi-statement transaction facility, so an Express publish could commit a message and then fail
to announce it, with no way to undo either.

## 7. Security verification

| Check | Observed |
|---|---|
| `realtime.messages` policies | **1**, `cmd = r` (SELECT), role `authenticated` |
| **INSERT/UPDATE/DELETE policies on `realtime.messages`** | **0** |
| `authenticated` INSERT *grant* on `realtime.messages` | still present (1) — RLS is the only barrier, which is the point |
| Public wrapper exposing `realtime.send()` to `authenticated` | **none** (empty result) |
| Public functions referencing `realtime.send` | only `broadcast_message_created`, which returns `trigger` → not PostgREST-exposable, not directly callable |
| New grant on the `realtime` schema | none |
| `is_conversation_participant()` | unchanged (`prosecdef = true`) |
| 5 public messaging RLS policies | unchanged |
| Public messaging grants | unchanged |

### Forged-event verification (the critical invariant)

Asserted empirically: with `set local role authenticated` and the booker's JWT claims, a direct
`INSERT INTO realtime.messages` is **refused**, matching `/row-level security|permission denied/`.
The test also asserts the table grant *still exists*, so the test would fail loudly if someone
"fixed" this by revoking the grant instead of relying on the absent policy.

At the wire level: a third-party authenticated user and a non-participant **admin** are both refused
the private channel by the Realtime service (`Unauthorized`), before any payload is sent.

## 8. Test results — actual

| Suite | Result |
|---|---|
| Phase 27-1 schema | **42 / 42** |
| Phase 27-2 authorization | **39 / 39** |
| Phase 27-3 conversations | **48 / 48** |
| Phase 27-4/27-5 messages | **52 / 52** |
| **Phase 27-6 realtime (new)** | **21 / 21** |
| **Messaging total** | **202 / 202** (was 181, +21) |
| **Full suite** | **596 / 596, 29 files** (was 575 / 28 — exactly +21) |

The realtime file was run **three times consecutively** — 21/21 each time — because websocket tests
are the most likely thing in this repo to be flaky.

### What the 21 tests cover

**Broadcast row (SQL layer)** — exactly one row per committed message with
`message.created|true|broadcast`; payload keys exactly the six DTO fields and values matching the
API response; **rollback produces no row**; an idempotent replay produces **one** message and
**one** broadcast; 5 concurrent messages produce 5 messages and 5 broadcasts with 5 distinct payload
ids.

**Topic helper** — true for booker and host; false for third party, non-participant admin, anon, and
a nonexistent conversation; false (never raising) for nine malformed topic shapes.

**Forged events** — zero non-SELECT policies, exactly one SELECT policy; the `authenticated` INSERT
is refused despite the grant; no public wrapper exposes `realtime.send()`.

**Live delivery (real supabase-js clients)** — a participant receives `message.created` with the
exact six-field payload and correct values; the **sender receives their own** event; a third party
is refused; a non-participant **admin** is refused; a message in conversation B never appears on
conversation A's channel; an **archived listing still delivers**.

**Regression invariants** — 5 public policies, 3 message indexes, empty publication, exactly the two
expected triggers, `touch_conversation_on_message()` byte-for-byte unchanged (still has the monotonic
guard, contains no `realtime.send`, still INVOKER), and the new functions' security posture.

## 9. Verification

| Step | Result |
|---|---|
| `supabase db reset --local` | clean — all **20** migrations from empty, 27-6 applied after 27-5 |
| Messaging after reset | **202 / 202** |
| Full suite after reset | **596 / 596** |
| `npm run typecheck` | exit **0** |
| `npm run build` | exit **0** |
| `git diff --check` | clean |

### Post-reset database state (inspected directly, not inferred)

```
public messaging policies      5   (unchanged)
realtime.messages policies     1   (SELECT only; non-SELECT = 0)
messages indexes               3   (unchanged)
triggers on messages           on_message_created, on_message_created_broadcast
supabase_realtime publication  tables=[]            (still empty)
can_access_conversation_topic  secdef=true  vol=s  search_path=public
broadcast_message_created      secdef=false        search_path=public
is_conversation_participant    secdef=true  vol=s  search_path=public   (unchanged)
touch_conversation_on_message  secdef=false        (unchanged)
public realtime.send wrapper   (none)
authenticated grants           conversations/messages SELECT; conversation_reads INSERT,SELECT,UPDATE;
                               admin_message_access SELECT      (all unchanged)
```

## 10. Local Realtime observations

Worth recording, because they are non-obvious and cost time to establish:

1. **Broadcast-from-database uses its own replication slot**, `supabase_realtime_messages_replication_slot_`
   (observed active), **not** the `supabase_realtime` publication. This is why no publication change
   is needed and why `messages` must never be added to it.
2. **`realtime.messages` is daily-partitioned** (`messages_2026_09_11` … `_15`, pre-created ~3 days
   ahead). Supabase reclaims by dropping partitions — Broadcast is delivery, never storage.
3. **Realtime delivery to private channels works fully on the local stack**, so this phase is
   testable locally end-to-end with no staging dependency.
4. **Two test-harness pitfalls** (both cost a failing run before being identified — the
   implementation was correct throughout):
   - `client.realtime.setAuth(token)` is **async and must be awaited**; the join has to carry the
     token.
   - The `subscribe()` callback resolves `SUBSCRIBED` marginally *before* the server-side broadcast
     binding is live. A message published in the very next statement can fall into that gap and be
     missed. The tests settle ~400 ms after `SUBSCRIBED`. **Client implementations (Phase 28) should
     reconcile after subscribing rather than assume the channel is hot the instant it joins** — which
     the documented client contract already requires for other reasons.
5. `pg_get_functiondef()` never prints `SECURITY INVOKER` (it is the default), so INVOKER is proved
   by `prosecdef = false`, not by string matching.
6. `pg_get_functiondef()` raises on aggregates, so any sweep over `public` functions must filter
   `prokind = 'f'`.

## 11. Staging status and manual prerequisite

> ### ⚠️ Manual prerequisite before staging rollout
> **Confirm Realtime is enabled on the ProdBnb staging Supabase project (`yspyemtiepgcoovjrgin`).**

This could not be verified from here: the Supabase MCP connector on this machine is authorised for a
different organisation and is refused on that project. Realtime is on by default for Supabase
projects, so this is expected to be a confirmation rather than a change.

**No other staging configuration is expected from this phase** — no environment variable, no
publication change, no dashboard setting beyond that confirmation. Nothing was deployed and no
staging or dashboard change was made.

## 12. Files changed

| File | Status |
|---|---|
| `supabase/migrations/20260912235900_phase27_6_realtime_broadcast.sql` | created |
| `tests/messaging-realtime.test.ts` | created (21 tests) |
| `docs/DATABASE.md` | modified |
| `docs/API.md` | modified |
| `docs/PHASE_27_6_REPORT.md` | created |

(`docs/PHASE_27_6_INSPECTION_REPORT.md` was created by the preceding inspection phase and is carried
in the working tree unchanged.)

## 13. Explicitly untouched

`src/` (every file — no route, controller, service, schema, DTO or cursor change); all five earlier
messaging migrations; `touch_conversation_on_message()` and `on_message_created`; the five public
messaging RLS policies; all public messaging grants; the three `messages` indexes; the
`supabase_realtime` publication; `package.json` and every dependency; `src/config/env.ts`; iOS,
Android, Web and the Admin panel; account deletion / retention behaviour; `last_message_at` deletion
behaviour.

## 14. Deferred items

Read/unread and `conversation.read` (27-7); message notifications and APNs (27-8); Admin Messaging
API and UI; typing, presence, attachments, reactions, voice; E2E encryption; durable outbound
offline queue; per-user channels and live Inbox ordering; forward `after_cursor`; frontend/iOS
Realtime subscriptions (Phase 28); host-initiated conversations.

Carried forward unchanged: **account-deletion / retention** (still needs product/legal sign-off), the
**`last_message_at` deletion gap** (carried with it), the pre-existing `locations.service.ts:433`
error message, and the per-instance rate limiter.

## 15. Risks / open issues

| # | Item | Severity | Note |
|---|---|---|---|
| 1 | An INSERT policy on `realtime.messages` would hand every client a forged-event capability | **Critical** | Guarded by a test; documented prominently in the migration and `DATABASE.md` |
| 2 | A `public` wrapper around `realtime.send()` would do the same | **Critical** | Guarded by a test |
| 3 | Broadcast failures are silent by design | Medium | Mandates client reconciliation. Operators can watch Postgres logs for `WarnSendingBroadcastMessage` |
| 4 | Realtime delivery is unordered / at-most-once | Medium | Clients sort by `(created_at, id)` and dedupe by `id` |
| 5 | Staging Realtime status unverified | Medium | §11 |
| 6 | Subscribe-time authorization can outlive a revocation | Low | Not reachable today — participation is permanent |
| 7 | If `messages` ever gained an `authenticated` INSERT grant, the broadcast would silently fail | Low | `broadcast_message_created()` is INVOKER; the inner insert would hit the absent INSERT policy and the error would be swallowed. Documented in the migration |

## 16. Rollback plan

```sql
drop trigger  if exists on_message_created_broadcast on public.messages;
drop function if exists public.broadcast_message_created();
drop policy   if exists "messaging_broadcast_participant_select" on realtime.messages;
drop function if exists public.can_access_conversation_topic(text);
```

Dropping the policy alone returns the system to the pre-27-6 deny-all baseline (no client can
subscribe to any private channel). No data migration, nothing to backfill, no destructive DDL, and
nothing from 27-1…27-5 is involved.

## 17. Notes for Phase 27-7 (read/unread)

1. `conversation_reads` is **completely untouched** by 27-6, and reading messages still never creates
   or advances a read cursor.
2. If 27-7 adds a `conversation.read` event, add it as **another** trigger/function rather than
   extending `broadcast_message_created()` — the same separation-of-concerns argument that produced
   Option D.
3. Reuse `can_access_conversation_topic()` for any new `conversation:<uuid>` event; do not add a
   second topic parser.
4. The `realtime.messages` SELECT policy already covers *every* broadcast event on a conversation
   topic, so a new event type needs **no** policy change.

## 18. Notes for Phase 27-8 (notifications)

1. Everything needed is already present: `messages.sender_id`, `conversation_id`, and the recipient
   derivable as "the participant who is not the sender".
2. Realtime and APNs are **complementary, not alternatives**: Realtime covers "app open, conversation
   visible"; APNs covers everything else. 27-8's suppression rule should account for the fact that a
   subscribed client already got the message.
3. 27-8 still needs the three CHECK widenings (`notifications.type`, `notifications.entity_type`,
   `notification_preferences.category`) and the `deliverPush()` `prodbnb_booking_id` fix recorded in
   the Phase 27 master inspection.

## 19. Notes for Phase 28 (clients)

1. **Subscribe with `private: true`.** A non-private channel bypasses authorization entirely.
2. **`setAuth` must be awaited** before subscribing (supabase-js), and the equivalent applies on iOS
   (`RealtimeClientV2.setAuth`). iOS already links supabase-swift 2.55.1 with `RealtimeV2`
   (`isPrivate`, `broadcastStream(event:)`, `setAuth`) — **no new SPM dependency**.
3. **Reconcile immediately after subscribing**, and after every reconnect — there is a brief window
   between join acknowledgement and the binding going live, and reconnects can miss events entirely.
   Page backwards with the existing `cursor` until a page overlaps a held `id`.
4. **Dedupe by server `id`; sort by `(created_at, id)`.** `client_message_id` reconciles only *your
   own* optimistic bubble.
5. The payload is byte-for-byte the REST message DTO, so one model and one parser serve both.
6. iOS note carried from 27-4: `created_at` is Postgres's rendering (`+00:00`, six fractional
   digits), not JavaScript's `…Z`. `Networking/BackendTimestamp.swift` already exists for this;
   confirm it before wiring the message list.
7. Known iOS gaps from the Phase 27 inspection that Phase 28 still owns: `MockMessageRepository.mockUserID`
   leaking into the real ViewModels, no dedupe in `ConversationViewModel.sendMessage`, `InboxView`
   unable to open a conversation it has not loaded, and `ProdBnbNotification.routingPayload` dropping
   the conversation id.
