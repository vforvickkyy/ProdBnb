# Phase 27-4 — Message APIs

**Status:** ✅ Implemented and verified
**Date:** 2026-09-12
**Starting commit:** `d7e583643f148cfec71c1426a5953dd229f0e208` (`feat: add messaging conversation APIs`)
**Scope:** Message retrieval and sending. No Realtime, no read/unread, no notifications, no admin messaging, no iOS.

---

## 1. Approved decisions (D-1 … D-8)

All eight were approved before implementation and all were implemented as approved.

| # | Decision | As built |
|---|---|---|
| D-1 | `client_message_id` is **required** | `sendMessageSchema` requires a uuid; missing or malformed → `400` |
| D-2 | Duplicate/replay `POST` returns **`201`** | Matches `POST /v1/conversations` and `POST /v1/devices` |
| D-3 | **Trim** the body before storing | `z.string().trim().min(1).max(4000)` — bounds measured on the trimmed value |
| D-4 | **`SECURITY INVOKER`** RPC for retrieval | `get_conversation_messages()`; RLS remains the authorization boundary |
| D-5 | Default message page size **50** | Conversation list stays at 20 |
| D-6 | **Extract the shared cursor codec**, update the shipped 27-3 service | `src/modules/messaging/cursor.ts`; 48/48 conversation tests green immediately after extraction |
| D-7 | Add **`messageSendLimiter`** | 60/min keyed by authenticated user, `POST` only |
| D-8 | **Newest-first** `created_at DESC, id DESC` | Exact match for the existing Phase 27-1 index |

---

## 2. Files changed

**Created (5)**

| File | Lines | Purpose |
|---|---|---|
| `supabase/migrations/20260912220000_phase27_4_messages.sql` | 167 | conversation-touch trigger + `get_conversation_messages()` |
| `src/modules/messaging/cursor.ts` | 74 | shared `(timestamp, uuid)` keyset cursor codec (D-6) |
| `src/modules/messaging/messages.service.ts` | 197 | DTO, participation gate, list, idempotent send |
| `tests/messaging-messages.test.ts` | 784 | 51 tests |
| `docs/PHASE_27_4_REPORT.md` | — | this file |

**Modified (7)**

| File | Change |
|---|---|
| `src/modules/messaging/conversations.service.ts` | −63/+few: inline codec removed, now imports `./cursor`. Behaviour-preserving (D-6) |
| `src/modules/messaging/messaging.schema.ts` | +52: `listMessagesQuerySchema`, `sendMessageSchema` |
| `src/modules/messaging/messaging.controller.ts` | +34: `getMessages`, `postMessage` |
| `src/modules/messaging/messaging.routes.ts` | +40: two routes, limiter wiring |
| `src/middleware/rateLimit.ts` | +35: `messageSendLimiter` (D-7) |
| `docs/API.md` | +144: messages section, pagination note, corrected "not here yet" |
| `docs/DATABASE.md` | +81: trigger, monotonic guard, RPC |

**Not touched:** `src/app.ts` (the messaging router was already mounted in 27-3), all four earlier
messaging migrations, every other module, iOS.

---

## 3. Implementation

### `GET /v1/conversations/:id/messages`

`requireAuth` → `validate({params, query})` → `listMessages()`.

1. `assertParticipant()` — calls `public.is_conversation_participant()` through the **caller's**
   scoped client (the function reads `auth.uid()` internally). `false` → `404`.
2. Decode the cursor if present (malformed → `400`).
3. `get_conversation_messages()` with `_limit = limit + 1`.
4. Slice to `limit`, derive `has_more`, encode `next_cursor` from the last row.

### `POST /v1/conversations/:id/messages`

`requireAuth` → `messageSendLimiter` → `validate({params, body})` → `sendMessage()`.

1. `assertParticipant()` → `404` if not.
2. Insert via `adminClient` with `sender_id = req.user!.id`, `conversation_id` = path, trimmed
   `body`, `client_message_id`. `id` and `created_at` are database defaults.
3. On `23505`, re-read by `(conversation_id, sender_id, client_message_id)` through the caller's
   scoped client and return the existing row **unchanged**.
4. `201` either way.

The insert fires `on_message_created`, which advances the conversation cache in the *same*
transaction.

### Validation

| Field | Rule |
|---|---|
| path `id` | `z.string().uuid()` |
| `limit` | int 1–100, default **50** |
| `cursor` | string 1–200, opaque, decoded/validated in the service |
| `body` | `.trim().min(1).max(4000)` |
| `client_message_id` | required uuid |

`sendMessageSchema` is `.strict()`; the GET query schema deliberately is **not**, matching every
other list schema — the safety property is that no parameter *exists* that could widen the result,
not that unknown ones are rejected.

### Cursor codec (D-6)

Extracted verbatim from `conversations.service.ts` into `cursor.ts`. **Wire format unchanged** —
opaque base64url of `"<ISO timestamp>|<uuid>"` — so cursors minted before the extraction still
decode. Splits on the *last* separator, validates both halves independently, throws
`ValidationError` on anything malformed. The only change at the call sites is that the returned
field is named `timestamp` instead of `last_message_at`, which is internal and never on the wire.

Proven behaviour-preserving by running the 48 Phase 27-3 conversation tests — including the five
malformed-cursor cases and the tied-timestamp multi-page walk — immediately after extraction and
before anything else was written.

### Rate limiter (D-7)

`messageSendLimiter`: 60 per 60s, keyed by `req.user.id` (falling back to a normalized IP key),
`skip` in test, `standardHeaders`. Applied to `POST` only — never to reads. Placed after
`requireAuth` (it needs `req.user`) and before `validate` (so a flood is rejected without parsing
bodies).

⚠️ Documented in the code and in `docs/API.md`: the store is in-memory and therefore **per
serverless instance**. Under Vercel scale-out the effective limit is (limit × live instances).
This is a soft anti-abuse baseline, **not** a globally distributed rate limiter.

---

## 4. Database

Migration `20260912220000_phase27_4_messages.sql` — three statements: two `create function`, one
`create trigger`, plus one function-scoped `revoke` and one `grant`. **Zero destructive DDL.**

### `touch_conversation_on_message()` + `on_message_created`

```sql
update public.conversations
   set last_message_id = new.id, last_message_at = new.created_at
 where id = new.conversation_id
   and last_message_at <= new.created_at;   -- monotonic guard
```

`AFTER INSERT ... FOR EACH ROW` on `messages`. `SECURITY INVOKER` (default), matching
`set_updated_at()` and `enforce_refund_balance()` — verified to have the identical
`secdef=false public_exec=true` profile as both.

**Why a trigger:** this backend has no multi-statement transaction facility (only
`@supabase/supabase-js`, one implicit transaction per PostgREST request), so the cache update must
happen inside the INSERT's transaction. A second Express statement would leave a window where a
committed message is invisible in the Inbox list.

**Why the guard:** two concurrent inserts can commit in either order; without it, an older message
committing second would drag the conversation backwards in the Inbox. `<=` rather than `<` so the
first message still lands when it shares the conversation's creation timestamp.

`updated_at` is left entirely to the existing `set_conversations_updated_at` BEFORE UPDATE trigger.

### `get_conversation_messages(_conversation_id, _cursor_created_at, _cursor_id, _limit)`

Verified live: `prosecdef = f` (**INVOKER**), `provolatile = s` (STABLE),
`proconfig = {search_path=public}`, `PUBLIC` execute = **f**, `authenticated` = t,
`service_role` = t, `anon` = **f**.

**This phase adds no new privilege.** Phase 27-3 needed `SECURITY DEFINER` because ordinary RLS
could not produce an Inbox row (a host cannot read the booker's profile; neither party can read an
unpublished listing). Message history has no such problem — every returned field is on the
`messages` row and `messages_select_participant` already grants the right rows. The function
exists only to keep the keyset predicate in typed SQL rather than in a hand-quoted PostgREST
`.or()` filter string. Same shape as `search_locations()`.

**No index was added.** `ORDER BY created_at DESC, id DESC` is an exact match for the Phase 27-1
`messages_conversation_id_created_at_id_idx`. Verified post-migration that `messages` still has
exactly its three original indexes.

**Nothing else changed:** 5 messaging RLS policies before and after; `authenticated` grants
unchanged (`conversations: SELECT`, `messages: SELECT`, `conversation_reads: INSERT,SELECT,UPDATE`,
`admin_message_access: SELECT`).

### Trigger behaviour, verified against the real database

| Check | Result |
|---|---|
| `last_message_id` / `last_message_at` match the inserted message | ✅ |
| `updated_at` **advances across separate transactions** | ✅ (it appears not to within one transaction only because `now()` is the transaction timestamp — an artifact of same-transaction probing, not a defect) |
| An **older** message inserted afterwards does not move the cache | ✅ |
| **5 concurrent** inserts → cache points at the newest, never goes backwards | ✅ |

---

## 5. API contracts

### Message object (six fields, both endpoints)

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

**No sender profile, deliberately.** The sender is always one of the two participants, and the
conversation DTO already carries `counterparty` + `viewer_role`, so a client resolves identity as
`sender_id === counterparty.id ? them : me`. This is why 27-4 needs **no profile access at all** —
which matters, because a host structurally cannot read the booker's profile.

Also absent: read/unread, booking context, attachments, `updated_at` (messages are immutable and
the column does not exist).

### `GET` response

```json
{ "data": [ /* newest first */ ],
  "meta": { "limit": 50, "has_more": true, "next_cursor": "…" } }
```

No `total` — under a keyset predicate a COUNT only describes the post-cursor remainder.
Empty conversation → `200` with `[]`, `has_more: false`, `next_cursor: null`.

### `POST` response

`201` with `{ "data": { …message… } }`.

### Errors

| Situation | Result |
|---|---|
| Unauthenticated | `401 UNAUTHENTICATED` |
| Suspended account | `403 FORBIDDEN` (existing `requireAuth`) |
| Non-participant / nonexistent conversation / admin | `404 NOT_FOUND` |
| Malformed UUID, bad limit, bad cursor, bad body, unknown field | `400 VALIDATION_ERROR` |
| Rate limited | `429` |

**No new error codes were introduced.**

---

## 6. Security model

- **Participant-only.** Both endpoints gate on `is_conversation_participant()` — the same
  predicate `messages_select_participant` uses — called through the caller's own scoped client.
- **Admin isolation.** No admin branch in the routes, the service, or the SQL. An admin who is not
  a participant gets `404` from both endpoints and zero rows from the RPC.
- **IDOR / enumeration.** "Not a participant" and "does not exist" produce byte-identical `404`
  bodies (asserted by comparing them).
- **Sender authority.** `sender_id` is always `req.user!.id`; `.strict()` rejects any attempt to
  supply it; and `messages` has no `authenticated` INSERT grant, so a client going around Express
  entirely still cannot forge one (re-asserted: direct PostgREST INSERT/UPDATE/DELETE all `42501`).
- **Ordering integrity.** `created_at` is a database default, not accepted from the client, so
  message position cannot be manipulated. Replays return the original `created_at`.
- **Cursor safety.** Opaque, validated on both halves, `400` on tamper, and a *position* rather
  than a capability — it can only filter within the conversation named in the path.
- **Query manipulation.** No parameter can widen a result set; asserted with `sender_id`,
  `conversation_id`, `user_id`, `page`, `pageSize` all spiked into one request.
- **Content handling.** Bodies are stored literally and never interpreted; the API builds no
  markup. A script/SQL payload round-trips byte-for-byte and the table survives.
- **RPC.** `SECURITY INVOKER`, no `PUBLIC`/`anon` execute, RLS filters its rows.

---

## 7. Idempotency behaviour

Backed solely by the Phase 27-1 `UNIQUE (conversation_id, sender_id, client_message_id)`. No
idempotency table.

| Scenario | Behaviour |
|---|---|
| Same key twice | Same `id`, same `created_at`, same `body`; both `201` |
| Same key, different body | Returns the **original** message — first write wins; a retry is not an edit |
| Same key, different conversation | Separate message |
| Same key, other participant | Separate message (`sender_id` is in the key) |
| 5 concurrent identical sends | All `201`, one distinct `id`, **exactly one row** confirmed by a service-role count |

`sender_id` is in the key deliberately: without it one participant could choose a key colliding
with the other's and be handed the counterparty's message.

---

## 8. Tests

| Suite | Result |
|---|---|
| Phase 27-1 schema | **42 / 42** |
| Phase 27-2 authorization | **39 / 39** |
| Phase 27-3 conversations | **48 / 48** |
| **Phase 27-4 messages (new)** | **51 / 51** |
| **Messaging total** | **180 / 180** |
| **Full suite** | **574 passed / 28 files** (baseline before 27-4: 523 / 27 — exactly +51, zero regressions) |

Coverage matches the approved matrix: GET authorization (booker/host/both-senders/third-party
`404`/admin `404`/anonymous `401`/nonexistent/malformed/empty), exact six-key DTO, newest-first
ordering with the pairwise invariant, tie determinism, full multi-page walk with no duplicates or
gaps, `has_more`/`next_cursor`, default 50, limits 1/100/invalid, five malformed cursors,
cross-conversation cursor, query manipulation, **no read-state mutation**; POST by both
participants, DTO shape, authorization, body validation (1/4000/4001/empty/whitespace×6/missing/
wrong-type/trimming/interior newlines/hostile content), identity rejection (six shapes),
`client_message_id` requirement, forged-sender neutrality, path authority, direct-PostgREST
refusals, RPC invoker behaviour and admin isolation; all five idempotency scenarios including
5-way concurrency with a database count; conversation metadata (cache advance, `updated_at`
advance, Inbox head, monotonic guard); and the archived-listing read **and** write regression.

### One test defect found and fixed during implementation

`"orders newest-first"` originally asserted a specific message *body* at the last position. Because
the fixture contains three **tied** timestamp pairs, which member of a pair sorts last is decided
by the random v4 UUID tiebreak and legitimately varies per run — it passed in isolation by luck of
the draw and failed when run with other files. Rewritten to assert the ordering *invariant*
pairwise plus the boundary *timestamps*, then run three consecutive times to prove independence
from the UUID draw. **The implementation was correct throughout; the assertion was wrong.**

A second, smaller correction in the same test: Postgres renders `timestamptz` as
`2026-09-03T10:00:00+00:00`, not JavaScript's `2026-09-03T10:00:00.000Z`. Same instant, different
characters — the assertion now compares parsed instants.

---

## 9. Verification

| Step | Result |
|---|---|
| Focused Phase 27-4 tests | 51 / 51 (run 3× consecutively) |
| All messaging tests | 180 / 180 |
| Full suite | 574 / 574, 28 files |
| `supabase db reset --local` | clean — all **18** migrations applied from empty |
| Messaging tests after reset | 180 / 180 |
| Full suite after reset | 574 / 574 |
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0 |
| `git diff --check` | clean |

No linter is configured in this repository (no ESLint/Prettier/Biome config, no `lint` script).

---

## 10. Deferred — unchanged or newly confirmed

| Item | Phase |
|---|---|
| Forward `after_cursor` for reconnect gap-fill | 27-6 |
| Realtime / Broadcast / `realtime.send()` / publication changes | 27-6 |
| Read/unread state; any `conversation_reads` write | 27-7 |
| Message notifications, APNs, the three CHECK widenings, the `deliverPush` `prodbnb_booking_id` fix | 27-8 |
| Admin Messaging API + `admin_message_access` writes | later |
| Edit / delete / unsend / moderation | not in V1 |
| Attachments, voice, reactions, typing, presence, E2E | not in V1 |
| Host-initiated conversations | deferred (structurally impossible today) |
| Sender profile enrichment | not needed — resolved client-side from the conversation DTO |
| Booking-state gating of messaging | not invented; messaging works in every booking state |

---

## 11. Known issues carried forward

1. **Account deletion / messaging retention — open, needs product/legal sign-off.** Deleting a
   booker destroys the whole thread including the host's messages; deleting a **host fails
   outright** once any conversation exists on their listings; deleting any sender removes their
   half of a surviving dialogue. Unchanged since 27-2, and nothing in 27-4 depends on it.
2. **Pre-existing defect, deliberately untouched.** `src/modules/locations/locations.service.ts:433`
   maps the `23503` FK violation to *"Cannot delete a location with existing bookings."* — a
   conversation can now also cause it, so the message names the wrong cause. One-line fix; belongs
   to whichever phase touches that file.
3. **Host-initiated conversations remain impossible** by design of the identity model.
4. **The rate limiter is per-instance, not distributed.** Under Vercel scale-out the effective
   limit is (limit × live instances). Documented in code and in `docs/API.md`. An authoritative
   shared count needs an external store (Vercel KV / Upstash); deliberately not introduced at
   pre-launch scale.

---

## 12. Notes for Phase 27-5 and later

1. **The Realtime hook point already exists.** `on_message_created` fires inside the message
   insert's transaction. Phase 27-6 should extend `touch_conversation_on_message()` (or add a
   second `AFTER INSERT` trigger) to call `realtime.send()` there — the broadcast then commits
   with the message or not at all. **Do not** add a second, Express-side publish path.
2. **The broadcast payload should be the wire DTO verbatim** — the same six fields. `id` is the
   dedupe key for the client; `client_message_id` is what lets a sender reconcile its optimistic
   bubble. Both are already in the DTO.
3. **Reconnect gap-fill needs a forward cursor.** 27-4 ships backwards paging only (`cursor` =
   older). Adding `after_cursor` is additive: one optional query param plus one more predicate
   branch in `get_conversation_messages()`. The shared codec already handles the encoding.
4. **`conversations.last_message_at` now moves.** It was a creation-time constant through 27-3;
   Inbox ordering is live from 27-4 onward. Anything that asserts on it must account for that.
5. **Reuse `cursor.ts`.** It is the shared codec for the module. A third paginated messaging
   endpoint should import it rather than duplicating the format.
6. **Reuse `is_conversation_participant()`** for any new participation gate — do not add a fourth
   check. `getConversation()` remains the option when the conversation object is also needed.
7. **`get_conversation_messages()` is `SECURITY INVOKER` on purpose.** If a later phase needs a
   field RLS forbids, that is a deliberate security decision requiring a `DEFINER` function and
   sign-off — not an additive convenience.
8. **Timestamp format for iOS (Phase 28).** The API returns Postgres's rendering —
   `2026-09-12T09:14:02.481233+00:00` — with a `+00:00` offset and **six** fractional digits, not
   JavaScript's `…Z`. Foundation's plain `.iso8601` decoding strategy does not accept fractional
   seconds; the repo already has `ProdBnb/Networking/BackendTimestamp.swift`, which is presumably
   why. Worth confirming before wiring the message list.
9. **Rate limiting is disabled under `NODE_ENV=test`**, so tests never hit `messageSendLimiter`.
   Any future test that needs to exercise it must override that.
