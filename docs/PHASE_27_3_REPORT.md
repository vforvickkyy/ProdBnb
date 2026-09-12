# Phase 27-3 — Conversation APIs

**Status:** ✅ Implemented and verified
**Date:** 2026-09-12
**Starting commit:** `4dd5219e5980336516397a3c232924ded9e741db` (`feat: add messaging authorization foundation`)
**Scope:** Conversation APIs only. No message send/history, no read/unread, no Realtime, no notifications, no iOS.

---

## 1. What this phase delivered

Three authenticated endpoints over the Phase 27-1/27-2 messaging foundation, plus one additive
`SECURITY DEFINER` function that makes an Inbox row renderable at all.

Neither the Phase 27-1 nor the Phase 27-2 migration was modified. Verified by checksum:

| Migration | SHA1 | State |
|---|---|---|
| `20260912190000_phase27_1_messaging_data_model.sql` | `ce9a82c36632eaae1c9dc2698995dbc31b1bc248` | unchanged |
| `20260912200000_phase27_2_messaging_authorization.sql` | `9d4df2510dc7ba7c44efc1132c3f36dfd8ed62e3` | unchanged |

---

## 2. Files changed

**Created (7)**

| File | Lines | Purpose |
|---|---|---|
| `supabase/migrations/20260912210000_phase27_3_conversation_views.sql` | 189 | `get_conversations_for_viewer()` + grants |
| `src/modules/messaging/conversations.service.ts` | 346 | DTO mapping, cursor codec, list/get/get-or-create |
| `src/modules/messaging/messaging.controller.ts` | 34 | Three handlers |
| `src/modules/messaging/messaging.routes.ts` | 38 | Route + middleware wiring |
| `src/modules/messaging/messaging.schema.ts` | 48 | Zod: list query, id param, strict create body |
| `tests/messaging-conversations.test.ts` | 759 | 48 tests |
| `docs/PHASE_27_3_REPORT.md` | — | This file |

**Modified (3)**

| File | Change |
|---|---|
| `src/app.ts` | +2 lines: one import, one `app.use("/v1", messagingRouter)` — mounted **before** the `/v1/admin` mount so the admin router's blanket `requireRole('admin')` cannot intercept it. Admin middleware itself untouched. |
| `docs/API.md` | +137/−5: Messaging section, the documented cursor-pagination exception, and a correction to two now-false sentences in "What's intentionally not here yet" that claimed messaging did not exist. |
| `docs/DATABASE.md` | +54: `get_conversations_for_viewer()` section. |

---

## 3. API surface

### `GET /v1/conversations`

`requireAuth`. Keyset-paginated list of the caller's conversations.

- Query: `?limit=20&cursor=<opaque>`. `limit` 1–100, default 20.
- Ordering: `last_message_at DESC, id DESC`.
- Response: `{ data: [<conversation>], meta: { limit, has_more, next_cursor } }`.
- **No `total`**, no `page`, no `pageSize`.
- Empty Inbox → `200` with `{"data": [], "meta": {"limit": 20, "has_more": false, "next_cursor": null}}`.
- There is **no** `booker_id` / `host_id` / `user_id` parameter. Unknown query params are ignored
  (matching every other list endpoint in this API); the safety property is that *no parameter
  exists that could widen the result*, not that unknown ones are rejected.
- A user who is both a booker and a host sees both sides in one list.

### `GET /v1/conversations/:id`

`requireAuth`. Returns the identical DTO.

- `404 NOT_FOUND` when the conversation does not exist **or** the caller is not a participant —
  deliberately indistinguishable, so this is not an id-enumeration oracle. Verified by a test that
  asserts the two error bodies are equal.
- An admin who is not a participant gets the same `404`.
- Malformed UUID → `400 VALIDATION_ERROR`.

### `POST /v1/conversations`

`requireAuth` + `requireRole("booker")`. Get-or-create.

```json
{ "location_id": "uuid", "booking_id": "uuid | null" }
```

Body is `.strict()`. Returns **`201`** whether the conversation was created or already existed,
matching `POST /v1/devices` (this API's existing idempotent-create precedent).

| Situation | Result |
|---|---|
| Not authenticated | `401 UNAUTHENTICATED` |
| Caller lacks `booker` role | `403 FORBIDDEN` |
| Location missing / draft / archived / suspended / not visible | `404 NOT_FOUND` |
| Caller is the listing's host (self-conversation) | `400 VALIDATION_ERROR` |
| `booking_id` not the caller's, or for another location | `400 VALIDATION_ERROR` |
| Unknown body field (`booker_id`, `host_id`, `participants`, `sender_id`, …) | `400 VALIDATION_ERROR` |
| Already exists, or a concurrent create raced | `201` with the existing conversation |

---

## 4. Database changes

**Migration:** `20260912210000_phase27_3_conversation_views.sql`

Contains exactly three statements — one `create function`, one `revoke execute … from public`
(scoped to the new function), one `grant execute`. **Zero destructive DDL.** No table, column,
policy, grant or trigger from 27-1/27-2 is touched.

**Function:**

```sql
public.get_conversations_for_viewer(_cursor_last_message_at timestamptz,
                                    _cursor_id uuid,
                                    _limit integer,
                                    _conversation_id uuid)   -- NULL = list mode
```

### Why `SECURITY DEFINER` was unavoidable

This is the single most important thing for a future phase to understand. The Phase 27-3
inspection probed the local stack with **real participant sessions** and found three facts that
together make an ordinary PostgREST query unable to render an Inbox row:

1. **A host can never learn the booker's name.** `profiles` RLS is own-row-or-admin (Phase 1), so
   a host selecting the booker's profile gets **zero rows** — and `get_host_public_profile(booker)`
   returns `[]`, because a booker has no published location. There was no existing path at all.
2. **The booker's view of the host's name is conditional.** `get_host_public_profile()` only
   answers while that host still has ≥1 published listing; archiving one silently removes the
   host's name from a thread the booker may still read.
3. **The listing disappears once unpublished.** `locations` SELECT RLS restricts a non-published
   row to its owner/admins, and `location_media` follows the parent. Verified: a booker in an
   active conversation about an archived listing still reads the conversation and its messages,
   but an embedded `locations` resolves to `null` — the row loses its title and thumbnail.

Phase 27-2 deliberately keyed conversation access on **participation, not publication**, so a
thread survives its listing being archived. This function is what makes the surviving thread
renderable. Same technique and same narrow-slice discipline as `get_host_public_profile()`.

### Security model (verified live against the database)

| Property | Verified value |
|---|---|
| `prosecdef` | `t` (SECURITY DEFINER) |
| `provolatile` | `s` (STABLE) |
| `proconfig` | `{search_path=public}` |
| EXECUTE for `PUBLIC` | **`f`** — the default grant is explicitly revoked |
| EXECUTE holders | `authenticated`, `service_role` only (**not `anon`**) |
| Participant predicate | `c.booker_id = auth.uid() OR l.host_id = auth.uid()` |
| Fail-closed guard | `auth.uid() is not null` stated explicitly |
| Caller-supplied user id | **none** — the signature has no user parameter |
| Admin branch | **none** — no `has_role`, no admin arm anywhere in the body |
| Limit clamp | `greatest(least(coalesce(_limit, 20), 101), 1)` |

It returns exactly the set `conversations_select_participant` already permits. It is **not** an
authorization bypass; it is a read model that crosses the `profiles`/`locations` RLS boundaries
which would otherwise leave an authorized row unrenderable.

The `101` ceiling is deliberate: the user-facing maximum of 100 lives in `messaging.schema.ts`,
while the service requests `limit + 1` rows to detect `has_more` without a second query. The SQL
clamp is the defensive backstop for a direct RPC caller, not the product limit.

### Queries and indexes

The list query is `where (booker or host) order by last_message_at desc, id desc limit N`, served
by `conversations_booker_id_last_message_at_idx` (Phase 27-1) on the booker side. The host side
joins through `conversations_location_id_idx`. The primary-media subquery uses the same selection
rule as `search_locations()`: lowest `position`, no `media_type` filter, returned as the **storage
key** — `publicUrlFor()` converts it in the service layer, because SQL never builds URLs in this
codebase.

---

## 5. Authorization decisions

| Actor | List | Detail | Create |
|---|---|---|---|
| **Booker** (`conversations.booker_id`) | own threads, `viewer_role: "booker"` | ✅ | ✅ the only actor who can |
| **Host** (`locations.host_id`) | threads on their listings, `viewer_role: "host"` | ✅ | ❌ `403` (lacks `booker` role) |
| **Booker *and* host** | both sides in one Inbox | ✅ | ✅ |
| **Third party** | `[]` | `404` | n/a |
| **Admin, not a participant** | **`[]`** | **`404`** | n/a |
| **Anonymous** | `401` | `401` | `401` |

**Admin isolation.** There is no admin branch in the routes, the service, or the SQL. Admin access
to private correspondence remains the separate, audited `admin_message_access` path from Phase
27-2, which is still unimplemented (a later sub-phase). Asserted three ways: empty list, `404` on
detail, and zero rows when calling the RPC directly with an admin session.

**Host initiation is deferred, not forgotten.** A conversation's identity is
`(booker_id, location_id)` and the booker is always the authenticated caller. There is no safe
input from which a host could name a booker — a host cannot read a booker's profile at all (see
§4). The only design that would work is host initiation *from a booking* (deriving `booker_id`
from `bookings.booker_id` and validating `bookings.location_id`), which is a new contract, not a
tweak.

**Unpublished-listing asymmetry — deliberate:**

- *Continuing* an existing conversation always works, with listing and counterparty summary intact.
- *Starting* a new one requires `status = 'published'` (the same rule `createBooking()` applies),
  and returns `404` rather than `403` so a private draft's existence is never confirmed.

**Self-conversation** is rejected at the **API layer** with `400`, not by a database constraint —
27-1/27-2 are untouched. Note the schema still accepts one, and `createBooking()` does **not**
reject self-booking, so this is a messaging-specific business rule rather than a platform-wide one.

**Booking validation.** `booking_id` is optional. When supplied it is read through the *caller's
own RLS-scoped client*, so another user's booking is simply invisible and yields the same `400` as
a nonexistent one — this never confirms another user's booking id. It must also belong to the same
`location_id`.

**`booking_id` is never re-pointed.** If the conversation already exists, a different `booking_id`
is ignored rather than overwriting the context the thread was created with. Deliberately not an
upsert. Whether opening from a different booking *should* move that pointer is an open product
question (§9) — not something to settle by accident.

---

## 6. Concurrency / idempotency

Insert-then-catch-`23505`-then-select. The Phase 27-1 `unique (booker_id, location_id)` constraint
is the authority; the application only decides whether the loser of a race gets a clean answer or
a 500.

```
authorize (caller's RLS client: location visible + published, booking ownership, not self)
   └─ adminClient.insert
        ├─ success → return the new conversation
        └─ 23505   → select by (booker_id, location_id) via the CALLER'S client
                      ├─ found     → return it (201)
                      └─ not found → rethrow (collision wasn't the identity constraint)
```

`conversations` deliberately has no `authenticated` INSERT grant (Phase 27-2), so the write goes
through `adminClient`. **Every authorization decision happens first, against the caller's own
scoped client** — service-role changes *where* the write executes, never *who* may write. Same
reasoning as `createBooking()` and `registerDevice()`.

**Measured:** 5 concurrent identical `POST`s → all 5 returned `201`, all 5 returned the **same**
conversation id, and a direct service-role count confirmed **exactly 1 row** for that
`(booker_id, location_id)` pair.

---

## 7. Pagination

Keyset, ordered `last_message_at DESC, id DESC`.

**Why the composite cursor is necessary, not decorative:** `conversations.last_message_at` is
`not null default now()`, and `now()` is the **transaction** timestamp — conversations created in
one statement or transaction share it byte-for-byte. A timestamp-only cursor would skip or repeat
rows across a tie; an id-only cursor is meaningless against a random v4 UUID.

Predicate:

```sql
last_message_at < cursor.last_message_at
OR (last_message_at = cursor.last_message_at AND id < cursor.id)
```

**Cursor format:** opaque `base64url` of `"<ISO last_message_at>|<uuid>"`. Opaque because a
hand-constructible cursor invites clients to build one. It carries nothing sensitive — both halves
are already on the row the client just received. Decoding validates both halves; any malformed or
tampered value raises `ValidationError` → `400`, never a 500.

**`has_more`** comes from requesting `limit + 1` rows. No `total` is returned: under a keyset
predicate a COUNT only describes the post-cursor remainder, which is a misleading number.

**Deviation from house convention, documented in `docs/API.md`:** every other list endpoint in
this API is offset-paginated (`page`/`pageSize`/`meta.total`). Messaging is the one exception,
because a conversation list *reorders while you page* — a new message moves a thread to the head,
so offset paging hands clients duplicates and skips rows. Phase 27-4's message history will use
cursors too, making the messaging module internally consistent.

---

## 8. The conversation DTO

One shape, used identically by list and detail (asserted: a list row `toEqual`s the detail
response, so they cannot drift).

```json
{
  "id": "uuid",
  "location": {
    "id": "uuid",
    "title": "East London Film Studio",
    "city": "London",
    "status": "published",
    "primary_media_url": "https://…/locations/…/original"
  },
  "counterparty": { "id": "uuid", "first_name": "Priya", "last_name": "Sharma", "avatar_url": null },
  "viewer_role": "booker",
  "booking_id": null,
  "last_message_at": "2026-09-12T09:14:02Z",
  "created_at": "2026-09-12T08:00:00Z",
  "updated_at": "2026-09-12T09:14:02Z"
}
```

`viewer_role` (`booker` | `host`) is computed **server-side** — a client cannot re-derive it,
because a booker cannot read `locations.host_id` once a listing is unpublished. `counterparty` is
the listing's host when `viewer_role` is `booker`, and the conversation's booker when it is `host`.
`location.status` reports the listing's real state (including `archived`/`suspended`) rather than
hiding it.

**Deliberately absent** — each asserted absent by an exact key-set test: `messages`, `message`,
`unread_count`, `last_read_at`, `last_read_message_id`, `last_message_id`, `booker_id`, `host_id`,
`phone`, `email`, profile `status`, `address_*`, `latitude`, `longitude`, `moderation_reason`,
`description`, and the raw R2 `storage_key`.

---

## 9. Test results (actual, from command output)

| Suite | Result |
|---|---|
| Phase 27-1 schema (`tests/messaging-schema.test.ts`) | **42 / 42** |
| Phase 27-2 authorization (`tests/messaging-authorization.test.ts`) | **39 / 39** |
| Phase 27-3 conversations (`tests/messaging-conversations.test.ts`) | **48 / 48** |
| **Messaging total** | **129 / 129** |
| **Full suite** | **523 passed / 27 files** (baseline before 27-3: 475 / 26 — exactly +48, zero regressions) |
| `supabase db reset --local` | clean; all **17** migrations applied from empty |
| Full suite after clean reset | **523 / 523** |
| Messaging tests after clean reset | **129 / 129** |
| `npm run typecheck` | exit **0** |
| `npm run build` | exit **0** |
| `git diff --check` | clean (no whitespace errors) |

No linter is configured in this repository (no ESLint/Prettier/Biome config, no `lint` script), so
linting is not part of the verification workflow.

**Phase 27-3 test coverage** — list authorization (booker / host / dual-role / third party / admin
/ unauthenticated), ordering, tie determinism, a complete multi-page walk with no duplicates or
missing rows, `has_more`/`next_cursor`, empty list, default/min/max limit, limit rejection, five
malformed-cursor shapes, identity-parameter neutrality; detail for both sides, `404` for third
party / admin / nonexistent, `400` for malformed UUID, exact DTO key sets on all three nested
objects, list≡detail; the unpublish regression; create happy path, idempotency, 5-way concurrency,
`403` for non-booker, `404` for nonexistent/draft/archived, self-conversation `400`, all three
booking-context rejections, eight unknown-field rejections, forged-`booker_id` neutrality, and no
booking re-pointing.

---

## 10. Security review

Verified properties:

- **Participant-only access** at every layer. The API, the RLS policies (27-2, unchanged), and the
  RPC all express the same rule: `booker_id = auth.uid() OR locations.host_id = auth.uid()`.
- **No admin bypass anywhere.** Asserted at the API (`[]` and `404`) and at the RPC (zero rows).
- **No client-supplied identity is ever trusted.** `booker_id` comes from the bearer token;
  `host_id` is derived from `locations.host_id` and never stored or accepted; the create body is
  `.strict()` so eight identity-shaped fields are each rejected with `400`. A test also proves that
  after a forged request is rejected, the honest request that follows belongs to the caller.
- **No query parameter can widen a result set.** Tested with `booker_id`, `host_id`, `user_id`,
  a PostgREST-style `eq.` filter, and `page`/`pageSize` — a third party still gets `[]` and a
  participant's own view is byte-identical with and without them.
- **`404`, never `403`, for inaccessible conversations** — no enumeration oracle.
- **RPC hardening:** no user-id parameter (a call passing `_user_id` errors), fails closed for
  `anon` (no EXECUTE grant *and* `auth.uid() is null` guard), cannot return another user's
  conversation even by id.
- **Phase 27-2 invariants still hold**: a participant's direct PostgREST insert into
  `conversations` still returns `42501`, re-asserted in the 27-3 suite.
- **Post-reset verification:** all 5 messaging RLS policies present, `authenticated` grants
  unchanged (`conversations: SELECT`, `messages: SELECT`, `conversation_reads: INSERT,SELECT,UPDATE`,
  `admin_message_access: SELECT`), and `admin_message_access` still has no FK to `conversations`
  (the 27-2 audit-retention correction survives).
- **No secrets, debug code, `console.*`, `TODO`, `.only()` or `.skip()`** in any Phase 27-3 file.

---

## 11. Deferred decisions and known issues

| # | Item | Status |
|---|---|---|
| 1 | **Account deletion / messaging retention** | **Open, needs product/legal sign-off.** Verified behaviour: deleting a **booker** destroys the whole thread *including the host's own messages*; deleting a **host** *fails outright* once any conversation exists on their listings (`locations.host_id` cascades into a location delete that `conversations.location_id` blocks); deleting any **sender** removes their half of a surviving dialogue. Unchanged since 27-2. Nothing in 27-3 depends on the answer. |
| 2 | **Host-initiated conversations** | Deferred. Structurally impossible in the current model; the only safe design is initiation from a booking (§5). |
| 3 | **Read / unread state** | Deferred. `conversation_reads` exists (27-1) but no endpoint reads or writes it, and the DTO deliberately excludes it — adding it now would change the RPC's shape again. |
| 4 | **Realtime / Broadcast** | Not started. `supabase_realtime` publication is empty, `realtime.messages` has zero policies, no triggers, no `realtime.send()`. Phase 27-6. |
| 5 | **Notifications for messages** | Not started. Creating a conversation produces **no** notification. Requires widening three CHECK constraints (`notifications.type`, `notifications.entity_type`, `notification_preferences.category`) and fixing `deliverPush()`'s hardcoded `prodbnb_booking_id`. Phase 27-7. |
| 6 | **Attachments, reactions, typing, presence, E2E** | Out of scope for V1 entirely. |
| 7 | **`booking_id` re-pointing policy** | Open. Currently never re-pointed. Revisit if the product wants opening from a newer booking to move the context. |
| 8 | **Pre-existing defect, deliberately not fixed** | `src/modules/locations/locations.service.ts:433` maps the `23503` FK violation to *"Cannot delete a location with existing bookings."* Since Phase 27-1, a conversation also blocks that delete, so a host deleting a booking-free listing that has a conversation gets a message naming the wrong cause. One-line message fix; belongs to whichever phase touches that file. |
| 9 | **`POST` returns `201` on an existing conversation** | Implemented per the `POST /v1/devices` precedent. The alternative (`200` existing / `201` new) is marginally more informative if ever wanted. |
| 10 | **List query schema is not `.strict()`** | Matches every other list endpoint; unknown query params are ignored. The safety property is asserted directly rather than assumed. |

---

## 12. Notes for Phase 27-4 and later

1. **`conversations.last_message_at` is currently only ever its creation default**, because nothing
   writes messages yet. The ordering and cursor are correct today and stay correct once 27-4 starts
   updating it — but any 27-4 work that writes a message **must** also advance
   `last_message_at`/`last_message_id`, or the Inbox will not reorder. The Phase 27 inspection
   recommends doing this in an `AFTER INSERT` trigger on `messages`, inside the insert's own
   transaction, since this backend has no multi-statement transaction facility.
2. **Reuse `getConversation()` / the RPC for participation checks** rather than re-deriving them.
   `public.is_conversation_participant(_conversation_id)` (27-2) is the canonical predicate for RLS;
   `get_conversations_for_viewer()` is the canonical read model. Do not add a third.
3. **Do not widen the RPC's column list casually.** It is narrow on purpose. If 27-6 needs an
   unread count, that is a deliberate security decision and a DTO version bump, not an additive
   convenience.
4. **The messaging module owns messages too.** Add `messages.service.ts` beside
   `conversations.service.ts`; keep one `messaging.routes.ts` / `messaging.controller.ts` /
   `messaging.schema.ts`.
5. **Message history should use the same cursor idiom** — `(created_at, id)` composite,
   `limit + 1` for `has_more`, opaque base64url. The codec in `conversations.service.ts` is a
   template, not a shared utility yet; extract it if 27-4 duplicates it.
6. **`messages` has no `authenticated` INSERT/UPDATE/DELETE grant** (27-2, deliberate). Message
   sending must authorize against the caller's scoped client and then write via `adminClient`,
   exactly as `getOrCreateConversation()` does.
7. **The `admin_message_access` table is still unwritten.** When the Admin Messaging service is
   built, it writes there with a mandatory non-blank reason, and it must **not** be added as a
   branch to the participant policies or the RPC.
