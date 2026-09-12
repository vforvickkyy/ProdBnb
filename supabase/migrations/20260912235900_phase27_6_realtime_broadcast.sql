-- Phase 27-6: Realtime message delivery (Broadcast)
--
-- Adds live delivery on top of the existing messaging stack. PostgreSQL remains
-- the source of truth; Realtime is delivery only. Nothing from Phase 27-1
-- through 27-5 is modified: no table, column, index, grant, existing policy or
-- existing trigger changes, and there is no API, DTO or source-code change in
-- this phase at all.
--
-- Four objects, in this order:
--   1. public.can_access_conversation_topic(text)  -- fail-closed topic parser
--   2. a SELECT-ONLY policy on realtime.messages   -- who may subscribe
--   3. public.broadcast_message_created()          -- the publisher
--   4. on_message_created_broadcast                -- AFTER INSERT on messages
--
-- ============================================================================
-- ARCHITECTURE (approved: Option D)
--
--   INSERT into public.messages  (service-role, after API authorization)
--        |
--        +-- on_message_created            -> touch_conversation_on_message()
--        |                                    maintains the last-message cache
--        |                                    (Phase 27-4/27-5, UNCHANGED)
--        |
--        +-- on_message_created_broadcast  -> broadcast_message_created()
--                                             realtime.send(...) on
--                                             conversation:<uuid>, private
--
-- A SEPARATE trigger rather than extending the existing one, deliberately:
--
--   * Different kinds of thing. touch_conversation_on_message() maintains a
--     DATA INVARIANT; a broadcast is a DELIVERY SIDE EFFECT. Phase 27-5 showed
--     how subtle that function is (its monotonic guard, its behaviour under
--     EvalPlanQual re-checks). Leaving it byte-identical preserves the 27-4 and
--     27-5 verification instead of re-opening it.
--   * The cache update is CONDITIONAL (`last_message_at <= new.created_at`) and
--     legitimately does nothing for an out-of-order insert. The broadcast must
--     fire UNCONDITIONALLY. Two functions make that impossible to confuse; one
--     function invites exactly that bug.
--   * PostgreSQL fires AFTER INSERT triggers in NAME order, so
--     `on_message_created` sorts before `on_message_created_broadcast` -- cache
--     first, publish second. Both are in the same transaction, so nothing a
--     client can observe depends on this, but it is the tidier order.
--   * Rollback is dropping one trigger, one function and one policy.
--
-- ============================================================================
-- ATOMICITY
--
-- realtime.send() writes a row into realtime.messages, so it participates in
-- the INSERT's own transaction. Verified during inspection: a send inside a
-- rolled-back transaction leaves nothing behind. Therefore
--
--     a message exists  <=>  its message.created event was published
--
-- and a rolled-back message produces NO event. This is exactly why the publish
-- belongs in a trigger and not in Express: there is no multi-statement
-- transaction facility in this backend (one PostgREST request = one implicit
-- transaction), so a second statement from the API could commit a message and
-- then fail to publish, with no way to undo either.
--
-- Conversely, realtime.send() wraps its own body in
-- `EXCEPTION WHEN OTHERS THEN RAISE WARNING 'WarnSendingBroadcastMessage: %'`,
-- so a Realtime malfunction can never fail a message insert -- and the backend
-- is never told that a broadcast failed. Client-side reconciliation against the
-- history endpoint is therefore mandatory, not optional (see docs/API.md).
--
-- ============================================================================
-- BROADCAST IS DELIVERY, NOT STORAGE
--
-- realtime.messages is a DAILY-PARTITIONED table that Supabase reclaims by
-- dropping old partitions. Nothing durable may ever live only there. Message
-- content is persisted in public.messages and read back through
-- GET /v1/conversations/:id/messages; the broadcast is a hint that arrives
-- sooner.
-- ============================================================================

-- ============================================================================
-- 1. can_access_conversation_topic() -- fail-closed topic parser
--
-- Turns a Realtime topic string into an authorization answer. The policy below
-- cannot do this inline safely: `split_part(realtime.topic(), ':', 2)::uuid`
-- RAISES on a malformed topic, and PostgreSQL does not guarantee that AND
-- short-circuits, so a regex guard in the same expression is not reliably
-- protective. A raise would surface as a subscribe error rather than a clean
-- deny. plpgsql with an explicit handler makes "malformed" and "not a
-- participant" the same answer: false.
--
-- SECURITY DEFINER for the same reason public.has_role() and
-- public.is_conversation_participant() are -- it must reach across RLS to
-- answer at all. It takes NO user id: identity comes from auth.uid(), read
-- inside is_conversation_participant(), so this cannot be used to probe anyone
-- else's membership. The worst an attacker can learn by calling it directly is
-- whether THEY are in a conversation, which they already know.
-- ============================================================================

create function public.can_access_conversation_topic(_topic text)
returns boolean
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  _conversation_id uuid;
begin
  -- Reject anything that is not exactly `conversation:<something>` before
  -- attempting a cast at all.
  if _topic is null or _topic !~ '^conversation:.+$' then
    return false;
  end if;

  begin
    _conversation_id := substring(_topic from 14)::uuid;   -- len('conversation:') = 13
  exception
    when others then
      return false;   -- malformed uuid, and anything else the cast can raise
  end;

  -- Delegates to the single canonical participant predicate -- the same one
  -- messages_select_participant uses -- so Realtime authorization and API
  -- authorization cannot drift. Returns false for a nonexistent conversation
  -- and for an unauthenticated caller.
  return public.is_conversation_participant(_conversation_id);
end;
$$;

comment on function public.can_access_conversation_topic(text) is
  'True when the CURRENT authenticated caller may subscribe to the Realtime '
  'topic `conversation:<uuid>`. Fail-closed by construction: a null, empty, '
  'wrongly-prefixed or malformed topic returns false rather than raising, and '
  'identity comes from auth.uid() via is_conversation_participant() rather '
  'than from any argument. Used only by the realtime.messages SELECT policy.';

-- Same grant shape as has_role() and is_conversation_participant(). The
-- Realtime service evaluates the policy as `authenticated`, so that role needs
-- EXECUTE; the function is fail-closed for anon regardless.
grant execute on function public.can_access_conversation_topic(text) to authenticated, service_role;

-- ============================================================================
-- 2. realtime.messages -- SELECT-ONLY subscribe policy
--
-- ############################################################################
-- #  DO NOT EVER ADD AN INSERT (OR UPDATE, OR DELETE) POLICY TO THIS TABLE.  #
-- ############################################################################
--
-- `authenticated` already holds table-level INSERT, SELECT and UPDATE GRANTS on
-- realtime.messages (Supabase ships them), and already holds EXECUTE on
-- realtime.send() plus USAGE on the realtime schema. The ONLY thing preventing
-- any logged-in user from publishing a forged `message.created` event into
-- somebody else's conversation is that this table has no INSERT policy -- RLS
-- with zero matching policies denies everything.
--
-- Clients cannot reach realtime.send() directly today only because PostgREST
-- exposes `public` and `graphql_public` and not `realtime`. For the same
-- reason: NEVER create a public wrapper around realtime.send(). Doing so would
-- hand every authenticated client a publish path.
--
-- Adding SELECT here is what makes private channels work at all: Realtime
-- consults this table's RLS only for channels subscribed with `private: true`.
-- A non-private channel bypasses it entirely, which is why the client contract
-- requires private (see docs/API.md).
--
-- No admin arm. An admin who is not a participant is refused exactly like any
-- third party; admin access to correspondence remains the separate, audited
-- admin_message_access path.
-- ============================================================================

create policy "messaging_broadcast_participant_select"
  on realtime.messages
  for select
  to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and public.can_access_conversation_topic(realtime.topic())
  );

-- ============================================================================
-- 3. broadcast_message_created()
--
-- SECURITY INVOKER (the default), matching touch_conversation_on_message() and
-- every other trigger function in this schema. It works because every message
-- INSERT runs through the backend's service-role client, which bypasses RLS, so
-- realtime.send()'s own INSERT into realtime.messages is permitted.
--
-- Worth stating explicitly: if a message were ever inserted as `authenticated`,
-- that inner INSERT would hit the (deliberately absent) INSERT policy above and
-- be denied -- and because realtime.send() swallows its own exceptions, the
-- failure would be SILENT. That path does not exist today: `authenticated` has
-- no INSERT grant on public.messages at all (Phase 27-2). Any future change
-- that grants one must revisit this function.
--
-- Publishes UNCONDITIONALLY for every committed insert -- there is deliberately
-- no guard here, unlike the cache trigger.
--
-- PAYLOAD: exactly the six columns of public.messages, which is byte-for-byte
-- the DTO GET/POST /v1/conversations/:id/messages already return. One message
-- shape for the whole client. No envelope: Realtime carries `event` and `topic`
-- out of band, so an in-payload type/action would only duplicate the channel
-- contract. No profile, listing, booking, read-state or admin data, and no
-- server metadata.
--
-- Note realtime.send() only injects an `id` into a payload that lacks one; ours
-- has the message id, so it is passed through untouched (the realtime.messages
-- row gets its own separate PK).
-- ============================================================================

create function public.broadcast_message_created()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  perform realtime.send(
    jsonb_build_object(
      'id',                new.id,
      'conversation_id',   new.conversation_id,
      'sender_id',         new.sender_id,
      'body',              new.body,
      'client_message_id', new.client_message_id,
      'created_at',        new.created_at
    ),
    'message.created',
    'conversation:' || new.conversation_id::text,
    true   -- private: forces Realtime to evaluate the RLS policy above
  );
  return null;
end;
$$;

comment on function public.broadcast_message_created() is
  'Publishes a committed message to its private Realtime channel '
  '`conversation:<conversation_id>` as `message.created`, carrying exactly the '
  'six-field message DTO. Runs inside the message INSERT''s own transaction, so '
  'a rolled-back message produces no event. Deliberately separate from '
  'touch_conversation_on_message(), which maintains a data invariant rather '
  'than delivering one -- and which is conditional, where this must always fire.';

-- ============================================================================
-- 4. The trigger
--
-- Named so it sorts AFTER `on_message_created` (PostgreSQL fires AFTER INSERT
-- triggers in name order): cache first, publish second.
-- ============================================================================

create trigger on_message_created_broadcast
  after insert on public.messages
  for each row
  execute function public.broadcast_message_created();

-- ============================================================================
-- DELIBERATELY NOT DONE
--
--   * No change to `supabase_realtime` -- that publication drives Postgres
--     Changes, which this phase does not use and which must stay empty.
--   * No new index. Broadcast reads nothing; realtime.messages carries its own
--     partition indexes.
--   * No change to any public grant, any of the five public messaging RLS
--     policies, touch_conversation_on_message(), on_message_created, or any
--     messaging table.
--   * No public wrapper around realtime.send(), and no new privilege on the
--     realtime schema.
-- ============================================================================
