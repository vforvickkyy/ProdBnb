-- Phase 27-7: Read / Unread messaging state
--
-- Three things, all additive in effect:
--   1. public.mark_conversation_read()          -- the monotonic write path
--   2. get_conversations_for_viewer()           -- gains `unread_count`
--   3. conversation_reads                       -- authenticated loses INSERT/UPDATE
--
-- No new table, no new index, no new trigger, no Realtime object of any kind.
-- Phase 27-1 through 27-6 are otherwise untouched: no existing table, column,
-- index, trigger or Realtime policy changes, and the message DTO, the cursor
-- wire format and the broadcast behaviour are all exactly as 27-6 left them.
--
-- ============================================================================
-- WHAT THE INSPECTION MEASURED, AND WHY THIS FILE LOOKS THE WAY IT DOES
--
-- Phase 27-1 created `conversation_reads` and nothing has ever written to it.
-- The 27-7 inspection probed it against a real local stack rather than reading
-- it, and found four traps. Each one below is load-bearing, not decoration.
--
--   (a) A CLIENT COULD MOVE ITS OWN CURSOR BACKWARDS. `conversation_reads` was
--       the only messaging table with an `authenticated` INSERT/UPDATE grant,
--       and nothing enforced monotonicity. A cursor was moved from 2026-09-12
--       back to 2026-08-13 through an ordinary authenticated session. The
--       column comment on `last_read_at` already CLAIMED this was impossible
--       ("Advanced only forwards by the backend, so a stale second device can
--       never resurrect unread state"). Section 3 of this file makes the
--       comment true.
--
--   (b) A WALL-CLOCK CURSOR SILENTLY LOSES MESSAGES. With
--       `last_read_at = now()`, a message whose transaction STARTED before the
--       mark-read but COMMITTED after it is counted as read, although the
--       reader could not possibly have seen it -- it was invisible when they
--       marked read. Reproduced exactly. This is why this function takes a
--       MESSAGE ID and derives the timestamp from that message's own row, and
--       why `now()` appears nowhere in it.
--
--   (c) THE OBVIOUS MONOTONIC GUARD IS SILENTLY WRONG ON NULL.
--       `(excluded…) > (conversation_reads…)` evaluates to NULL -- not true --
--       when the existing cursor is NULL, so `DO UPDATE … WHERE` skips the row
--       and the user's FIRST mark-read is discarded, leaving the thread unread
--       forever. Measured: naive guard -> `INSERT 0 0`, cursor still null.
--       The COALESCE sentinels below are the fix, and they are the exact
--       mirror of Phase 27-5's maximum sentinels.
--
--   (d) A REJECTED UPSERT RETURNS NO ROW. When the guard correctly refuses an
--       older cursor, `ON CONFLICT DO UPDATE … RETURNING` yields zero rows.
--       A function that returned that directly would hand the API an empty
--       result for a perfectly legitimate no-op. Hence the final SELECT.
--
-- One further state is REACHABLE and must not be "fixed": `last_read_at` set
-- with `last_read_message_id` NULL. `conversation_reads.last_read_message_id`
-- is ON DELETE SET NULL, so deleting the message a cursor points at (what a
-- sender-profile cascade does) produces exactly that. Verified. It is why
-- there is deliberately NO CHECK constraint tying the two columns together
-- (approved decision D-4), and why every comparison in this file coalesces
-- both halves independently rather than testing "the cursor is null".
-- ============================================================================

-- ============================================================================
-- 1. mark_conversation_read() -- the monotonic write path
--
-- SECURITY DEFINER, for the same reason public.has_role() and
-- public.is_conversation_participant() are: section 3 removes the
-- `authenticated` write grant on `conversation_reads`, so an ordinary caller
-- can no longer write their own cursor directly and this function is the only
-- way in. It takes NO user id -- identity comes from auth.uid() read
-- internally -- so it cannot be used to move anybody else's cursor, exactly
-- the argument-free shape is_conversation_participant() established.
--
-- AUTHORIZATION IS ENFORCED HERE, INDEPENDENTLY OF EXPRESS. The Express layer
-- also checks participation (to produce a clean 404), but this function does
-- not depend on that: `is_conversation_participant()` is consulted first and
-- the function returns zero rows for a non-participant, a nonexistent
-- conversation and an unauthenticated caller alike. An admin who is not a
-- participant is refused exactly like any third party -- there is no admin
-- branch anywhere in this module, and an admin viewing a conversation can
-- never acquire or advance a participant's cursor (approved decision D-7).
--
-- The `_message_id` must exist AND belong to `_conversation_id`. Both failures
-- collapse into "zero rows", which the service layer turns into the same 404
-- as a nonexistent conversation -- so this never confirms that a guessed
-- message id exists, nor which conversation it belongs to.
--
-- Returns the RESULTING cursor state, whether this call advanced it or was a
-- monotonic no-op. See trap (d) above.
-- ============================================================================

-- RETURNS SETOF public.conversation_reads, deliberately, rather than a
-- RETURNS TABLE naming the three interesting columns. A RETURNS TABLE
-- declares OUT parameters, those become plpgsql variables, and they SHADOW the
-- identically-named columns of the table being written -- which makes
-- `on conflict (conversation_id, user_id)` fail outright with "column
-- reference conversation_id is ambiguous", because a conflict target cannot be
-- table-qualified. Returning the row type has no OUT parameters and therefore
-- no shadowing at all. The service layer projects the three fields the DTO
-- needs; the extra columns are the caller's own row, which they can already
-- read under conversation_reads_select_own.
create function public.mark_conversation_read(
  _conversation_id uuid,
  _message_id uuid
)
returns setof public.conversation_reads
language plpgsql
security definer
set search_path = public
as $$
declare
  _uid uuid := auth.uid();
begin
  -- Fails closed, and states it rather than relying on the participant helper
  -- to do the right thing with a null identity.
  if _uid is null then
    return;
  end if;

  -- The single canonical participant predicate -- the same one
  -- messages_select_participant and can_access_conversation_topic() use, so
  -- read-state authorization cannot drift from message authorization. False
  -- for a non-participant AND for a conversation that does not exist.
  if not public.is_conversation_participant(_conversation_id) then
    return;
  end if;

  -- The advance itself.
  --
  -- `last_read_at` comes from `m.created_at` -- the message's own
  -- server-assigned timestamp -- and from nowhere else. Never now(), never a
  -- client value. See trap (b).
  --
  -- The SELECT sources the row, so a message that does not exist or belongs to
  -- a different conversation produces no row to insert and the statement is a
  -- no-op, leaving any existing cursor untouched.
  insert into public.conversation_reads (conversation_id, user_id, last_read_at, last_read_message_id)
  select _conversation_id, _uid, m.created_at, m.id
    from public.messages m
   where m.id = _message_id
     and m.conversation_id = _conversation_id
  on conflict (conversation_id, user_id) do update
     set last_read_at         = excluded.last_read_at,
         last_read_message_id = excluded.last_read_message_id
   -- MONOTONICITY. A single unconditional row comparison over the full
   -- (created_at, id) ordering key -- the same total order the message index
   -- and the pagination cursor use, so an exact created_at tie is resolved by
   -- the uuid tiebreaker rather than being treated as "not newer".
   --
   -- The COALESCE sentinels are what make this correct when the existing
   -- cursor is null or half-null: see trap (c). '-infinity' and the minimum
   -- uuid are the mirror of Phase 27-5's 'infinity'/maximum-uuid pair.
   --
   -- Under concurrency, ON CONFLICT DO UPDATE takes a row lock and re-evaluates
   -- this predicate against the LATEST COMMITTED row version rather than the
   -- transaction's snapshot, so two racing calls cannot interleave into a
   -- backwards move. Verified against a real overlapping-transaction test: the
   -- older writer blocked, re-evaluated, and became a no-op. No SERIALIZABLE,
   -- no advisory lock and no retry loop is required.
   where (excluded.last_read_at, excluded.last_read_message_id)
       > (coalesce(conversation_reads.last_read_at,         '-infinity'::timestamptz),
          coalesce(conversation_reads.last_read_message_id, '00000000-0000-0000-0000-000000000000'::uuid));

  -- Deliberately NOT `RETURNING` from the statement above. A monotonic no-op
  -- returns zero rows there (trap (d)), and "you asked to mark an older
  -- message read" must still answer with the cursor that actually stands.
  return query
    select r.*
      from public.conversation_reads r
     where r.conversation_id = _conversation_id
       and r.user_id = _uid;
end;
$$;

comment on function public.mark_conversation_read(uuid, uuid) is
  'Advances the CURRENT caller''s read cursor in one conversation to the given '
  'message, monotonically -- an older or already-read message is a no-op and '
  'the standing cursor is returned unchanged. last_read_at is derived from the '
  'message''s own created_at, never now() and never a client-supplied value: a '
  'wall-clock cursor was measured to swallow a message that committed after '
  'the mark-read but was stamped before it. Takes no user id (identity is '
  'auth.uid()), enforces participation itself via '
  'is_conversation_participant(), and returns zero rows for a non-participant, '
  'a nonexistent conversation, a nonexistent message, or a message belonging '
  'to another conversation -- so it is no kind of enumeration oracle. No admin '
  'branch.';

-- PRIVILEGES. `revoke ... from public` alone is NOT sufficient here, which is
-- worth spelling out because Phase 27-3 and 27-4 both assumed it was.
--
-- Supabase ships `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON
-- FUNCTIONS TO anon, authenticated, service_role`, so a newly created function
-- arrives with a DIRECT `anon=X/postgres` entry in its ACL -- not an inherited
-- PUBLIC one. Revoking from PUBLIC does not touch a direct grant to a named
-- role, so `anon` keeps EXECUTE. Measured on a fresh `supabase db reset`: all
-- three messaging functions, including the two that already revoked from
-- PUBLIC, show `anon=X/postgres`.
--
-- Both revokes are therefore issued. This function is SECURITY DEFINER and it
-- WRITES, so an anon EXECUTE grant is the one worth being most careful about
-- -- it fails closed regardless (auth.uid() is null returns no rows), but a
-- write path should not rely solely on its own internal guard.
revoke all on function public.mark_conversation_read(uuid, uuid) from public;
revoke all on function public.mark_conversation_read(uuid, uuid) from anon;
grant execute on function public.mark_conversation_read(uuid, uuid) to authenticated, service_role;

-- ============================================================================
-- 2. get_conversations_for_viewer() -- now carrying unread_count
--
-- ############################################################################
-- #  DROP + CREATE, NOT `CREATE OR REPLACE`, AND THE GRANTS ARE RE-STATED.   #
-- ############################################################################
--
-- PostgreSQL cannot change a RETURNS TABLE function's return type in place:
--     ERROR:  cannot change return type of existing function
--     HINT:   Use DROP FUNCTION ... first.
-- so adding `unread_count` requires DROP + CREATE.
--
-- DROP DISCARDS THE ACL. Phase 27-3 deliberately revoked EXECUTE from PUBLIC
-- on this function (an Inbox read model has no anonymous use case), and that
-- revocation does NOT survive the drop -- a recreated function gets the
-- default `EXECUTE TO PUBLIC` back. The REVOKE/GRANT pair at the foot of this
-- section is therefore not boilerplate: omitting it silently hands `anon`
-- EXECUTE on the conversation read model. This is the single highest-risk step
-- in this migration and is asserted by a test.
--
-- EVERYTHING ELSE IS BYTE-FOR-BYTE PHASE 27-3. Same columns in the same order,
-- same joins, same participant predicate, same keyset predicate, same ordering,
-- same 101 clamp, same SECURITY DEFINER rationale, same absence of an admin
-- branch. The ONLY change is the appended `unread_count` column and the
-- LEFT JOIN that feeds it.
--
-- The `booker_id = auth.uid() OR l.host_id = auth.uid()` predicate is
-- preserved verbatim, including its measured generic-plan behaviour (a seq
-- scan over the caller's conversations). That is a PRE-EXISTING Phase 27-3
-- characteristic -- measured on the 27-3 body with no unread column at all --
-- and rewriting it is explicitly deferred (approved decision D-8). It is not
-- touched here, so this migration cannot be blamed for it either way.
-- ============================================================================

drop function public.get_conversations_for_viewer(timestamptz, uuid, integer, uuid);

create function public.get_conversations_for_viewer(
  _cursor_last_message_at timestamptz default null,
  _cursor_id uuid default null,
  _limit integer default 20,
  _conversation_id uuid default null
)
returns table (
  id uuid,
  booking_id uuid,
  last_message_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  viewer_role text,
  location_id uuid,
  location_title text,
  location_city text,
  location_status text,
  location_primary_media_key text,
  counterparty_id uuid,
  counterparty_first_name text,
  counterparty_last_name text,
  counterparty_avatar_url text,
  unread_count bigint
)
language sql
security definer
set search_path = public
stable
as $$
  select
    c.id,
    c.booking_id,
    c.last_message_at,
    c.created_at,
    c.updated_at,

    case when c.booker_id = auth.uid() then 'booker' else 'host' end as viewer_role,

    l.id as location_id,
    l.title as location_title,
    l.city as location_city,
    l.status as location_status,

    (
      select lm.storage_key
      from public.location_media lm
      where lm.location_id = l.id
      order by lm.position asc
      limit 1
    ) as location_primary_media_key,

    p.id as counterparty_id,
    p.first_name as counterparty_first_name,
    p.last_name as counterparty_last_name,
    p.avatar_url as counterparty_avatar_url,

    -- ------------------------------------------------------------------
    -- unread_count -- derived, never stored.
    --
    -- A denormalized counter would mean incrementing a column on the hot
    -- message-insert path for the non-sender and recomputing it on every
    -- mark-read: a second source of truth that can drift from `messages`,
    -- which is the authority. Phase 27-1 rejected a denormalized participant
    -- table for exactly this reason. Measured, the derived form costs ~0.4 ms
    -- per 20-row page, so there is nothing to buy.
    --
    -- CAPPED AT 100 (approved decision D-1). The inner `limit 101` is what
    -- makes the work BOUNDED: without it this is O(unread) per conversation
    -- and a single 5,000-message unread thread dominates the page. 101, not
    -- 100, so that "exactly 100 unread" and "more than 100 unread" are
    -- distinguishable inside the subquery; `least(…, 100)` then clamps the
    -- reported value, so the API contract is 0..100 where 100 means
    -- "100 or more".
    --
    -- THE PREDICATE. `sender_id <> auth.uid()` -- your own messages are never
    -- unread to you; sending is reading. The row comparison is the same total
    -- (created_at, id) order as the message index and the pagination cursor,
    -- written as a SINGLE unconditional comparison with COALESCE sentinels so
    -- PostgreSQL can use it as an index RANGE START CONDITION on the existing
    -- messages_conversation_id_created_at_id_idx under a GENERIC parameterized
    -- plan -- measured as `Index Cond`, not `Filter`. This is Phase 27-5's
    -- lesson applied in the opposite direction: '-infinity' and the minimum
    -- uuid mean "no cursor -> everything from the counterparty is unread", and
    -- they also absorb the half-null cursor state described in the header.
    --
    -- NO NEW INDEX IS ADDED; this is a pure range scan on the Phase 27-1 index.
    -- ------------------------------------------------------------------
    least(
      (
        select count(*)
        from (
          select 1
          from public.messages m
          where m.conversation_id = c.id
            and m.sender_id <> auth.uid()
            and (m.created_at, m.id) > (
                  coalesce(r.last_read_at,         '-infinity'::timestamptz),
                  coalesce(r.last_read_message_id, '00000000-0000-0000-0000-000000000000'::uuid)
                )
          limit 101
        ) capped
      ),
      100
    ) as unread_count

  from public.conversations c
  join public.locations l on l.id = c.location_id
  left join public.profiles p
    on p.id = case when c.booker_id = auth.uid() then l.host_id else c.booker_id end
  -- The caller's own cursor for this conversation. LEFT, because "no row yet"
  -- is the normal state of a conversation nobody has opened and must mean
  -- "everything unread", not "drop this conversation from the Inbox".
  -- Scoped to auth.uid(): this function is SECURITY DEFINER, so RLS does not
  -- scope it and the predicate has to.
  left join public.conversation_reads r
    on r.conversation_id = c.id
   and r.user_id = auth.uid()

  where
    auth.uid() is not null

    and (c.booker_id = auth.uid() or l.host_id = auth.uid())

    and (_conversation_id is null or c.id = _conversation_id)

    and (
      _conversation_id is not null
      or _cursor_last_message_at is null
      or c.last_message_at < _cursor_last_message_at
      or (c.last_message_at = _cursor_last_message_at and c.id < _cursor_id)
    )

  order by c.last_message_at desc, c.id desc

  limit greatest(least(coalesce(_limit, 20), 101), 1);
$$;

comment on function public.get_conversations_for_viewer(timestamptz, uuid, integer, uuid) is
  'The Inbox read model: the conversations the CURRENT caller participates in, '
  'with the narrow listing and counterparty summary an Inbox row needs, plus '
  'the caller''s unread_count (Phase 27-7). SECURITY DEFINER because ordinary '
  'RLS cannot supply it -- a host cannot read the booker''s profile at all, and '
  'neither party can read the listing once it is unpublished. Reads auth.uid() '
  'itself and accepts no user id, so it cannot be used to enumerate anyone '
  'else''s conversations. unread_count counts only the COUNTERPARTY''s messages '
  'newer than the caller''s (last_read_at, last_read_message_id) cursor, is '
  'capped at 100 (100 means "100 or more"), and is derived rather than stored. '
  'Exposes no phone, email, address, profile status, booking detail or message '
  'content, and has no admin branch.';

-- MANDATORY after the DROP above -- see the section header. A recreated
-- function gets fresh default privileges, and Phase 27-3's narrowing does not
-- survive the drop.
--
-- The `from anon` revoke is not redundant with the `from public` one: Supabase's
-- ALTER DEFAULT PRIVILEGES grants EXECUTE to anon DIRECTLY, and revoking from
-- PUBLIC leaves a direct grant to a named role untouched. Phase 27-3 revoked
-- only from PUBLIC, so `anon` has in fact held EXECUTE on this function in
-- every freshly-built database since 27-3 shipped (measured). It fails closed
-- for an unauthenticated caller either way -- auth.uid() is null yields zero
-- rows -- but an Inbox read model has no anonymous use case at all and the
-- grant should not exist.
revoke execute on function public.get_conversations_for_viewer(timestamptz, uuid, integer, uuid) from public;
revoke execute on function public.get_conversations_for_viewer(timestamptz, uuid, integer, uuid) from anon;
grant execute on function public.get_conversations_for_viewer(timestamptz, uuid, integer, uuid) to authenticated, service_role;

-- ============================================================================
-- 3. conversation_reads -- authenticated loses INSERT, UPDATE and DELETE
--
-- Approved decision D-3. Phase 27-1 modelled this table on
-- notification_preferences as "ordinary self-service", which left it the ONLY
-- messaging table an authenticated client could write. Everything else in the
-- module -- conversations, messages, admin_message_access -- is SELECT-only to
-- `authenticated`, with every write authorized against the caller's scoped
-- client and then executed with elevated privilege.
--
-- That grant is what made trap (a) reachable: a monotonicity guarantee
-- enforced only in Express or only in mark_conversation_read() would be
-- bypassed by a client talking to PostgREST directly. Revoking it is what
-- makes the guarantee actually hold, and it brings this table into line with
-- the rest of the module.
--
-- DELETE IS REVOKED TOO, AND IT HAS TO BE. Phase 27-1 stated "No DELETE grant:
-- a read cursor is reset by moving it, never by removing the row" -- but that
-- was never true of an actual database. Supabase ships
-- `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon,
-- authenticated, service_role`, so a newly created public table arrives with
-- FULL DML already granted and 27-1's `grant select, insert, update` was
-- additive on top of it rather than the whole story. (Phase 12 knew this and
-- revoked explicitly -- `bookings` is `rdDxtm` to this day -- but the Phase 27
-- migrations did not.) Measured on a fresh `supabase db reset`: an
-- authenticated participant deleting their own cursor row returned DELETE 1.
--
-- That is not a cosmetic gap. `conversation_reads_write_own` is FOR ALL, so
-- RLS permits the delete, and deleting the cursor resets the conversation to
-- "nothing read" -- the maximal backwards move, and a complete bypass of the
-- monotonicity this phase exists to guarantee. Revoking INSERT and UPDATE
-- while leaving DELETE would close the front door and leave the back one open.
--
-- SELECT IS DELIBERATELY UNTOUCHED. `conversation_reads_select_own` still lets
-- a user read their own cursor and nobody else's -- that is how a client draws
-- a "new messages" divider, and it discloses nothing.
--
-- THE POLICY IS DELIBERATELY KEPT. `conversation_reads_write_own` (27-1, as
-- tightened by 27-2) now matches no reachable write, because RLS is only
-- consulted once the table-level grant is held. Keeping it costs nothing and
-- means that if a future phase ever re-grants INSERT/UPDATE, the
-- participation check and the 27-2 clause requiring the cursor to point INTO
-- its own conversation are still standing rather than silently absent. There
-- was never intended to be a DELETE grant.
--
-- service_role is unaffected and retains full DML, which is what
-- mark_conversation_read() (SECURITY DEFINER, owned by postgres) and the
-- backend's admin client rely on.
-- ============================================================================

revoke insert, update, delete on public.conversation_reads from authenticated;

comment on column public.conversation_reads.last_read_at is
  'The created_at of the newest message this user has read in this '
  'conversation -- NOT the wall-clock time at which they read it. Derived '
  'server-side from the message row by public.mark_conversation_read(); a '
  'wall-clock value was measured to mark as read a message that committed '
  'after the mark-read but was stamped before it, which the reader could never '
  'have seen. Null means nothing in this thread has been read yet. Advanced '
  'only forwards: monotonicity is enforced by mark_conversation_read()''s '
  'compare-and-swap over (last_read_at, last_read_message_id), and '
  'authenticated holds no INSERT/UPDATE grant on this table (Phase 27-7), so a '
  'stale second device cannot resurrect unread state by reporting an older '
  'cursor through any path.';

comment on column public.conversation_reads.last_read_message_id is
  'The newest message this user has read, and the tiebreaker that makes the '
  'cursor a total order over (created_at, id) -- two messages can share a '
  'created_at exactly. Also the anchor a client draws its "new messages" '
  'divider at. ON DELETE SET NULL, so deleting this message leaves '
  'last_read_at standing rather than resetting the thread to fully unread; the '
  'resulting half-null cursor is a legitimate state that every comparison '
  'coalesces independently, which is why no CHECK ties these two columns '
  'together.';
