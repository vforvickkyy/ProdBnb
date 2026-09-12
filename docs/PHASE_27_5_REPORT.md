# Phase 27-5 — Messaging Cursor Index Alignment

**Status:** ✅ Implemented and verified
**Date:** 2026-09-12
**Starting commit:** `b56032cb1d0ec0447d5f625982780f4e13e1dc5b` (`feat: add messaging message APIs`)
**Scope:** One `create or replace function`. Nothing else.

---

## 1. Why this phase exists

The Phase 27-5 inspection was chartered as a broad "transaction / denormalization" review, and its
conclusion was that **the transaction model and denormalization are already correct** — the write
path is genuinely atomic, the conversation-cache guard is order-independent under real lock
contention, idempotency is race-free, and no denormalized field is justified (the Inbox query does
not even read `messages`). Outcome **C — no change** was the expected result.

One measured finding changed that to **B — minimal**.

### The measured problem

Phase 27-4 shipped message history as keyset pagination over the Phase 27-1 index
`messages_conversation_id_created_at_id_idx (conversation_id, created_at desc, id desc)`, with the
predicate written in the conventional expanded form:

```sql
_cursor_created_at is null
or m.created_at < _cursor_created_at
or (m.created_at = _cursor_created_at and m.id < _cursor_id)
```

That is logically correct — and was proven correct by 51 tests. What it is **not** is
keyset-*efficient*. PostgreSQL cannot turn an OR-chain into an index range start condition, so it
landed in `Filter`: the scan began at the newest message and discarded every row down to the
cursor.

Measured on a 5,000-message conversation at a 4,000-row-deep cursor, generic plan:

```
Index Cond: (conversation_id = $1)
Filter:     ((created_at < $2) OR ((created_at = $2) AND (id < $3)))
Rows Removed by Filter: 4001
Buffers: shared hit=86          -- first page, for comparison: 3
```

This is **O(offset)** — precisely the behaviour keyset pagination exists to eliminate. It is
harmless at today's volumes (0.5 ms) and grows linearly with conversation length. The design's
stated benefit was simply not being delivered.

### The trap that shaped the fix

The natural rewrite keeps the null guard and swaps only the OR-chain:

```sql
_cursor_created_at is null or (m.created_at, m.id) < (_cursor_created_at, _cursor_id)
```

With **literal** values this plans perfectly — the planner folds `'…'::timestamptz is null` to
false, drops the branch, and produces an `Index Cond`. **It is a trap.** PostgREST invokes the
function with real **parameters**, so the plan that matters is the generic one, where `$2` is
unknown at plan time and the branch cannot be folded. Measured under
`plan_cache_mode = force_generic_plan`:

```
Filter: (($2 IS NULL) OR (ROW(created_at, id) < ROW($2, $3)))
Rows Removed by Filter: 4001
Buffers: shared hit=85          -- i.e. no better than before
```

Had this not been tested under the correct plan mode, the "fix" would have shipped and changed
nothing.

---

## 2. Implementation

**Migration:** `supabase/migrations/20260912230000_phase27_5_message_cursor_index_alignment.sql`

A single `create or replace function public.get_conversation_messages(...)` plus its
`comment on function`. **No** table, column, index, trigger, policy or grant statement.

**Predicate strategy** — remove the branch entirely by folding the null case into the comparison
using per-type maximum sentinels:

```sql
and (m.created_at, m.id) < (
      coalesce(_cursor_created_at, 'infinity'::timestamptz),
      coalesce(_cursor_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)
    )
```

**Why `COALESCE` is required, not cosmetic:** a single unconditional row comparison is the only
form the planner can push into the index in *both* the cursor and the no-cursor case.
`'infinity'::timestamptz` is greater than every real timestamp and
`'ffffffff-ffff-ffff-ffff-ffffffffffff'` is the maximum `uuid`, so a null cursor compares as "older
than everything" and correctly yields the first page. The sentinels are reached only when the
corresponding parameter is null, which the service layer does only for the first page.

**Explicitly unchanged:** signature, return type, `SECURITY INVOKER`, `STABLE`,
`set search_path = public`, `order by created_at desc, id desc`, the
`greatest(least(coalesce(_limit,50),101),1)` clamp, and the authorization behaviour (RLS remains
the boundary). Privileges are deliberately **not** re-stated in the migration —
`create or replace function` preserves them, and re-issuing them would imply this migration changes
them.

**Nothing else in the codebase was touched**: no service, controller, route, DTO, schema, cursor
codec, wire format, idempotency, rate limiter, trigger, or `conversations` column.

---

## 3. Semantic equivalence — how it was verified

The new function's output was compared directly against the **old predicate** (recreated as a
`pg_temp` function) on a 5,000-message fixture containing a deliberate four-way timestamp tie:

| Case | Result |
|---|---|
| 1. First page (null cursor) | **IDENTICAL** |
| 2. Middle page (4,000 deep) | **IDENTICAL** |
| 3. Cursor sitting **on** a four-way timestamp tie | **IDENTICAL** |
| 4. Cursor past the end | **IDENTICAL** (both empty) |
| 5. Empty conversation | **IDENTICAL** (both empty) |
| 6. Cursor from a **different** conversation | **IDENTICAL** |
| 7. Page-size clamp honoured | ✅ |

Row comparison `(a, b) < (c, d)` is defined as `a < c or (a = c and b < d)` — exactly the predicate
it replaces — and `created_at`/`id` are both `NOT NULL`, so no three-valued-logic difference can
arise. The 181 messaging tests, which cover ordering, tie determinism, full multi-page walks,
`has_more`/`next_cursor`, empty pages and cross-conversation isolation, all pass unchanged.

---

## 4. Query plan — actual observed results

All under `plan_cache_mode = force_generic_plan`, 5,000-message conversation, 4,000-row-deep cursor.

| | Predicate in plan | Rows discarded | Buffers |
|---|---|---|---|
| **Before** (27-4 OR-chain) | `Filter` | **4001** | **86** |
| Rejected: `$2 IS NULL OR ROW<ROW` | `Filter` | **4001** | 85 |
| **After** (row comparison + COALESCE) | **`Index Cond`** including `ROW(created_at, id)` | **0** | **6** |
| **After**, first page (null cursor) | **`Index Cond`** | 0 | 3 |

Index used: the **existing** `messages_conversation_id_created_at_id_idx`. **No index was added** —
`messages` still has exactly its three Phase 27-1 indexes.

> **Measurement caveat worth preserving.** `EXPLAIN` of a *call* to this function shows only
> `Function Scan` — the body's `LIMIT` blocks SQL-function inlining — and that node's buffer count
> folds in first-call planning and catalog reads (observed anywhere from 3 to 179 for identical
> work, depending on cache warmth). It is **not** a usable measure of page access. The inner plan
> must be observed via the equivalent prepared statement, which is what the regression test does.

---

## 5. Tests

| Suite | Result |
|---|---|
| Phase 27-1 schema | **42 / 42** |
| Phase 27-2 authorization | **39 / 39** |
| Phase 27-3 conversations | **48 / 48** |
| Phase 27-4 messages + **1 new 27-5 regression test** | **52 / 52** |
| **Messaging total** | **181 / 181** (was 180) |
| **Full suite** | **575 / 575, 28 files** (was 574 — exactly +1) |

**The one new test** — `"the cursor predicate plans as an Index Cond, not a Filter"` — asserts the
*structural* property rather than timings or buffer counts, for the reason in §4. Two parts:

1. Under `force_generic_plan` against the real table and index, the predicate appears inside
   `Index Cond` containing `ROW(created_at, id)`, and there is **no** `Filter` on `created_at` and
   **no** `Rows Removed by Filter`.
2. The shipped function's own definition still uses `coalesce(_cursor_created_at…)` and does **not**
   contain the `_cursor_created_at is null or …` form — with SQL comments stripped first, because
   the body deliberately *describes* the rejected form and matching raw text would assert on prose.

It reaches raw SQL by shelling out to the local stack's container (`EXPLAIN` is not reachable
through PostgREST/supabase-js) and **skips rather than fails** when that is unavailable, because it
asserts a plan property, not correctness.

Both halves are demonstrably capable of failing: the OR-chain form was observed producing `Filter`
with 4001 rows discarded, and the source assertion was observed failing before comments were
stripped.

---

## 6. Verification

| Step | Result |
|---|---|
| Focused 27-4/27-5 message tests | 52 / 52 (run twice) |
| All messaging tests | **181 / 181** |
| Full suite | **575 / 575, 28 files** |
| `supabase db reset --local` | clean — all **19** migrations applied from empty, 27-5 after 27-4 |
| Messaging tests after reset | **181 / 181** |
| Full suite after reset | **575 / 575** |
| `npm run typecheck` | exit **0** |
| `npm run build` | exit **0** |
| `git diff --check` | clean |

---

## 7. Security — unchanged, and verified so

`create or replace function` preserves privileges; confirmed empirically after the migration:

| Property | Value |
|---|---|
| `prosecdef` | `f` — **SECURITY INVOKER** (unchanged) |
| `provolatile` | `s` — STABLE (unchanged) |
| `proconfig` | `{search_path=public}` (unchanged) |
| EXECUTE for `PUBLIC` | **`f`** (still revoked) |
| EXECUTE for `anon` | **`f`** |
| EXECUTE for `authenticated` / `service_role` | `t` / `t` (unchanged) |
| Signature | identical — no user-id parameter introduced |

RLS remains the authorization boundary: **5 messaging policies** before and after; `authenticated`
grants unchanged (`conversations: SELECT`, `messages: SELECT`,
`conversation_reads: INSERT,SELECT,UPDATE`, `admin_message_access: SELECT`). No new privilege, no
admin bypass. Participant/non-participant/admin behaviour is covered unchanged by the existing 181
messaging tests.

---

## 8. Denormalization decision — explicitly, nothing was added

The inspection reviewed every candidate and **none was adopted**:

| Candidate | Decision |
|---|---|
| `last_message_preview` | **Not added.** Derive through `last_message_id` when a client needs it (D3). Copying body text into `conversations` would create a second copy to keep in sync and to scrub on deletion/moderation |
| `last_message_sender_id` | **Not added** — same join; the client already knows both participants |
| `message_count` | **Not added** — no API or client surface uses it; pure write amplification on the hottest row |
| `unread_count` | **Not added** — deferred to Phase 27-7, and dynamic computation is preferred; denormalizing it would make every message write update a per-recipient counter and create a second source of truth against `conversation_reads` |
| Any new index | **Not added** — `messages` still has exactly its three Phase 27-1 indexes |

The structural reason this is comfortable: `get_conversations_for_viewer()` **never reads
`public.messages`**, so Inbox cost is already independent of message volume. The usual motivation
for denormalizing message state into conversations does not apply.

`get_conversations_for_viewer()` has the same OR-chain cursor shape and was **deliberately left
alone**: its `WHERE` is an OR *across two tables* (`c.booker_id = auth.uid() OR l.host_id =
auth.uid()`), which prevents a clean index path regardless, and a user has tens of conversations,
not thousands. Changing it would add risk for no measurable gain.

---

## 9. Deferred items

| Item | Status |
|---|---|
| **Account deletion / retention** | **Open, needs product/legal sign-off.** Deleting a booker destroys the host's side of the thread; deleting a **host fails outright** once any conversation exists on their listings; deleting any sender removes their half of a surviving dialogue. Observable today: the local test database holds 41 leftover profiles, 18 of them hosts owning 135 locations, whose deletion silently failed |
| **`last_message_at` deletion gap** | **Carried with the retention decision (D2), deliberately not patched.** When the message `last_message_id` points at is deleted, the FK sets it to `NULL` but `last_message_at` stays at the deleted message's timestamp — newer than any survivor. `last_message_id` can never dangle. The only path that deletes a message in V1 is the `sender_id → profiles` cascade, i.e. account deletion |
| Phase 27-6 Realtime / Broadcast / publication | Not started |
| Phase 27-7 read/unread, `conversation_reads` writes | Not started |
| Phase 27-8 message notifications / APNs | Not started |
| Admin Messaging API + `admin_message_access` writes | Not started |
| Edit/delete/unsend, moderation, attachments, reactions, typing, presence, E2E | Out of V1 |
| Host-initiated conversations | Deferred — structurally impossible in the current identity model |
| Pre-existing `locations.service.ts:433` error message naming only bookings | Untouched |
| Per-instance (non-distributed) rate limiter | Untouched |
| Phase 27-1 / 27-2 persistent reports | **Not backfilled (D4).** The record is the two migrations, `docs/DATABASE.md`, and commit `4dd5219` |

---

## 10. Notes for Phase 27-6

1. **The message trigger is unchanged.** `on_message_created` → `touch_conversation_on_message()`
   still fires `AFTER INSERT FOR EACH ROW` inside the message insert's own transaction. Phase 27-6
   should extend **that** function (or add a second `AFTER INSERT` trigger) to call
   `realtime.send()`, so the broadcast commits with the message or not at all. **Do not** add an
   Express-side publish path.
2. **Realtime is still entirely absent**: `supabase_realtime` publication has zero tables,
   `realtime.messages` has zero policies, and no `realtime.send()` call exists anywhere. Verified
   after this migration.
3. **The message write path remains the source of truth.** Phase 27-5 changed only how history is
   *read*; sending, idempotency and conversation-cache maintenance are byte-identical to 27-4.
4. **The cursor codec and wire format are unchanged.** `src/modules/messaging/cursor.ts` was not
   touched; cursors minted before this migration still decode. Reuse it for any new paginated
   messaging endpoint.
5. **If a later phase edits `get_conversation_messages()`, keep the row-comparison form.** Reverting
   to an OR-chain — including the innocuous-looking `_cursor_created_at is null or (…)` — silently
   restores O(offset) scanning. The regression test in `tests/messaging-messages.test.ts` guards
   this, and §4's caveat explains why it asserts on the plan rather than on timings.
6. **`get_conversation_messages()` is `SECURITY INVOKER` on purpose.** Needing a `DEFINER` later is
   a security decision requiring sign-off, not an additive convenience.
