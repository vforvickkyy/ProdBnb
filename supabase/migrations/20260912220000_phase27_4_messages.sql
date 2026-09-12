-- Phase 27-4: Message APIs
--
-- Two additive objects: a trigger that keeps a conversation's last-message
-- cache consistent with its messages, and a read function for message history.
-- No table, column, index, policy or grant from Phase 27-1 (20260912190000),
-- 27-2 (20260912200000) or 27-3 (20260912210000) is altered.
--
-- Notably, this phase adds NO new privilege. Phase 27-3 needed a SECURITY
-- DEFINER function because ordinary RLS structurally could not produce an
-- Inbox row (a host cannot read the booker's profile at all, and neither party
-- can read the listing once it is unpublished). Message history has no such
-- problem: every field the API returns lives on the `messages` row itself, and
-- `messages_select_participant` already grants exactly the right rows. The
-- function below is therefore SECURITY **INVOKER** -- RLS remains the
-- authorization boundary, not something the function reaches around.

-- ============================================================================
-- 1. touch_conversation_on_message() -- the last-message cache
--
-- `conversations.last_message_at` is what GET /v1/conversations orders by, and
-- `last_message_id` is what renders the Inbox preview. Both are a denormalized
-- cache of the newest message; `messages` is always the authority.
--
-- WHY A TRIGGER. The required invariant is "a message exists <=> the
-- conversation's cache reflects it". This backend has no multi-statement
-- transaction facility at all -- only @supabase/supabase-js, where each
-- PostgREST request is one implicit transaction -- so the update has to happen
-- inside the INSERT's own transaction or not atomically at all. An AFTER
-- INSERT trigger is the only shape that achieves it, and it is the same
-- technique enforce_refund_balance_before_insert (Phase 12) already uses.
-- Doing it as a second statement from Express would leave a window where a
-- committed message is invisible in the Inbox list.
--
-- WHY THE `last_message_at <= new.created_at` GUARD. Without it the cache can
-- move BACKWARDS. Two messages inserted concurrently into one conversation can
-- commit in either order; if the older one commits second, its trigger would
-- overwrite the newer one's cache and the conversation would sort to the wrong
-- place in the Inbox. Row-level locking serializes the two UPDATEs, and this
-- predicate makes the outcome independent of which order they arrive in --
-- the newest message always wins. Verified against a real out-of-order insert.
--
-- `<=` rather than `<` so the very first message still lands: a conversation's
-- `last_message_at` defaults to now() at creation, and a message created in
-- that same transaction would share the timestamp exactly.
--
-- `updated_at` is deliberately NOT set here. The existing
-- `set_conversations_updated_at` BEFORE UPDATE trigger (Phase 27-1) already
-- maintains it for any update to the row, including this one -- duplicating
-- that logic would create a second place for it to drift.
--
-- SECURITY INVOKER (the default), matching set_updated_at() and
-- enforce_refund_balance(). Every message insert runs through the backend's
-- service-role client, which holds UPDATE on `conversations` and bypasses RLS,
-- so no elevated privilege is needed. `authenticated` has no INSERT grant on
-- `messages` at all (Phase 27-2), so there is no other path in.
--
-- Non-recursive: the conversation UPDATE touches nothing that writes messages.
-- ============================================================================

create function public.touch_conversation_on_message()
returns trigger
language plpgsql
as $$
begin
  update public.conversations
     set last_message_id = new.id,
         last_message_at = new.created_at
   where id = new.conversation_id
     and last_message_at <= new.created_at;
  return null;
end;
$$;

comment on function public.touch_conversation_on_message() is
  'Keeps conversations.last_message_id/last_message_at in step with the newest '
  'message, inside the message INSERT''s own transaction (this backend has no '
  'multi-statement transaction facility). The last_message_at <= '
  'new.created_at predicate makes the cache monotonic, so two messages '
  'committing out of order cannot move a conversation backwards in the Inbox. '
  'updated_at is left to the existing set_conversations_updated_at trigger.';

create trigger on_message_created
  after insert on public.messages
  for each row
  execute function public.touch_conversation_on_message();

-- ============================================================================
-- 2. get_conversation_messages() -- message history
--
-- SECURITY INVOKER, so `messages_select_participant` (Phase 27-2) filters the
-- rows exactly as it would for a direct PostgREST select: a non-participant
-- gets zero rows, an admin who is not a participant gets zero rows, and
-- auth.uid() is null gets zero rows. This function grants nothing.
--
-- It exists for one reason: to keep the keyset predicate in SQL. Expressing
-- `created_at < c1 OR (created_at = c1 AND id < c2)` through PostgREST means
-- building an `.or()` filter STRING containing an ISO timestamp -- whose ':',
-- '.' and '+' are all PostgREST-reserved characters needing careful quoting.
-- A function keeps the comparison typed, readable, and provably aligned with
-- the index. Same shape and same reasoning as search_locations() (Phase 4),
-- which is likewise SECURITY INVOKER and called via .rpc().
--
-- ORDERING is `created_at DESC, id DESC` -- newest first, which is both what a
-- chat client wants (open on the newest page, scroll up into history) and an
-- exact match for the EXISTING index
-- `messages_conversation_id_created_at_id_idx (conversation_id, created_at
-- DESC, id DESC)` from Phase 27-1. NO NEW INDEX IS ADDED; this query is a pure
-- index range scan on the one that is already there.
--
-- Returns exactly the six columns of `messages`, which is exactly the public
-- DTO -- no sender profile, no listing, no booking, no read state. Sender
-- identity is resolved client-side against the conversation's `counterparty`,
-- so no profile access is needed anywhere in this phase.
-- ============================================================================

create function public.get_conversation_messages(
  _conversation_id uuid,
  _cursor_created_at timestamptz default null,
  _cursor_id uuid default null,
  _limit integer default 50
)
returns table (
  id uuid,
  conversation_id uuid,
  sender_id uuid,
  body text,
  client_message_id uuid,
  created_at timestamptz
)
language sql
security invoker
stable
set search_path = public
as $$
  select m.id, m.conversation_id, m.sender_id, m.body, m.client_message_id, m.created_at
  from public.messages m
  where m.conversation_id = _conversation_id
    -- Keyset predicate for (created_at desc, id desc). A cursor is
    -- all-or-nothing: the service layer passes both halves or neither, because
    -- a half-cursor would compare against a null id and silently drop rows.
    and (
      _cursor_created_at is null
      or m.created_at < _cursor_created_at
      or (m.created_at = _cursor_created_at and m.id < _cursor_id)
    )
  order by m.created_at desc, m.id desc
  -- Hard ceiling of 101, not 100, for the same reason as
  -- get_conversations_for_viewer(): the user-facing maximum of 100 is enforced
  -- in messaging.schema.ts, while the service asks for `limit + 1` rows to
  -- detect has_more without a second query. This clamp is the defensive
  -- backstop for a direct RPC caller, not the product limit.
  limit greatest(least(coalesce(_limit, 50), 101), 1);
$$;

comment on function public.get_conversation_messages(uuid, timestamptz, uuid, integer) is
  'Keyset-paginated message history for one conversation, newest first. '
  'SECURITY INVOKER -- messages_select_participant does the authorizing, so '
  'this function grants no access of its own and has no admin branch. Exists '
  'only to keep the composite (created_at, id) cursor predicate in typed SQL '
  'rather than in a PostgREST filter string. Uses the existing '
  'messages_conversation_id_created_at_id_idx; adds no index.';

-- EXECUTE is granted to PUBLIC by default for a new function. Revoked and
-- re-granted narrowly, matching get_conversations_for_viewer() (Phase 27-3).
-- Even with the grant, RLS still decides which rows come back.
revoke execute on function public.get_conversation_messages(uuid, timestamptz, uuid, integer) from public;
grant execute on function public.get_conversation_messages(uuid, timestamptz, uuid, integer) to authenticated, service_role;
