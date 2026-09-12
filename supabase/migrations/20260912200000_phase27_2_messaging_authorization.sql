-- Phase 27-2: Messaging Authorization & RLS
--
-- A small, additive follow-up to 20260912190000 (Phase 27-1), which already
-- created the four messaging tables, their RLS policies, their grants and
-- public.is_conversation_participant(). That migration is deliberately left
-- exactly as it was -- this file corrects the two things 27-2's authorization
-- review found, and nothing else.
--
-- What 27-2 did NOT need to change, because 27-1 already got it right:
--
--   * conversations  -- authenticated SELECT only, participant-scoped, no
--                       admin arm on the participant policy.
--   * messages       -- authenticated SELECT only. No INSERT, UPDATE or
--                       DELETE grant and no policy for any of them, so
--                       sender_id / conversation_id / created_at /
--                       client_message_id / body cannot be forged through
--                       direct PostgREST by any client holding a real
--                       Supabase session.
--   * admin_message_access -- authenticated SELECT for admins only; no write
--                       grant for anyone but service_role.
--   * is_conversation_participant(uuid) -- SECURITY DEFINER, search_path
--                       pinned, STABLE, reads auth.uid() internally, takes no
--                       caller-supplied user id, false for auth.uid() is null
--                       and false for a conversation that does not exist.
--
-- No Realtime configuration, no triggers, no API. Those are 27-3 onward.

-- ============================================================================
-- 1. admin_message_access.conversation_id -- drop the foreign key
--
-- 27-1 modelled this as `references conversations(id) on delete cascade`,
-- which made the audit record disappear the moment its conversation did. That
-- is the wrong lifetime for an audit record: the whole point of logging that
-- an admin read someone's private correspondence is that the log outlives the
-- thing it describes, including when the correspondence is later deleted.
-- (The cascade also existed to avoid the opposite failure -- a restricting FK
-- would have let a single admin access record permanently block deletion of
-- the booker's account. Dropping the FK entirely resolves both at once.)
--
-- This follows the existing admin_audit_log convention exactly:
-- admin_audit_log.target_id is a bare `uuid not null` with no FK, for the same
-- reason, and admin_audit_log has referenced bookings/locations/users that way
-- since Phase 11.
--
-- The column, its NOT NULL, and admin_message_access_conversation_id_idx are
-- all retained -- only the constraint is dropped. Nothing has ever written to
-- this table (the Admin Messaging service is a later sub-phase), so there is
-- no existing row to migrate or validate.
-- ============================================================================

alter table public.admin_message_access
  drop constraint admin_message_access_conversation_id_fkey;

comment on column public.admin_message_access.conversation_id is
  'The conversation that was accessed. A bare uuid reference with NO foreign '
  'key, matching admin_audit_log.target_id: an audit record must outlive the '
  'conversation it describes, so a deleted conversation leaves its access '
  'history intact rather than erasing it. Consequently this may reference a '
  'conversation that no longer exists -- that is the intended behaviour, not '
  'a dangling reference to repair.';

comment on table public.admin_message_access is
  'Append-only record of every admin access to private conversation content, '
  'with a mandatory stated reason. Contains no message content itself, and '
  'holds no foreign key to conversations (Phase 27-2) so audit history '
  'survives the deletion of what it describes. Written exclusively by the '
  'backend (service_role) -- no INSERT/UPDATE/DELETE grant to authenticated '
  'at all, so no admin can create, edit or erase an entry, including their '
  'own. The admin read path this gates is a later Phase 27 sub-phase.';

-- ============================================================================
-- 2. conversation_reads_write_own -- the cursor must point INTO its own
--    conversation.
--
-- 27-1's WITH CHECK validated two things: the row belongs to the caller, and
-- the caller participates in conversation_id. It did not constrain
-- last_read_message_id at all, so a participant could set their cursor in
-- conversation A to a message id belonging to an unrelated conversation B.
-- Verified accepted before this change.
--
-- The practical severity is low -- the FK still requires the message to
-- exist, and nothing is disclosed by the write itself -- but it is a real
-- integrity hole with a real (if small) side effect: the distinction between
-- a successful write and a 23503 foreign-key violation is a message-existence
-- oracle for a guessed uuid, and a cursor pointing outside its own thread is
-- simply wrong state for the "new messages" divider it exists to position.
--
-- Closed by requiring the referenced message to belong to the same
-- conversation. The subquery runs under the caller's own RLS, so it can only
-- ever match a message they are already entitled to read -- and since the
-- clause before it already established participation in conversation_id, a
-- legitimate cursor write is unaffected.
--
-- DROP + CREATE rather than editing 27-1: Postgres has no ALTER POLICY that
-- can add to an expression, and rewriting the earlier migration would change
-- history for an already-reviewed file.
-- ============================================================================

drop policy "conversation_reads_write_own" on public.conversation_reads;

create policy "conversation_reads_write_own"
  on public.conversation_reads
  for all
  to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and public.is_conversation_participant(conversation_id)
    and (
      last_read_message_id is null
      or exists (
        select 1
        from public.messages m
        where m.id = last_read_message_id
          and m.conversation_id = conversation_reads.conversation_id
      )
    )
  );

-- ============================================================================
-- 3. Account deletion -- investigated, deliberately NOT changed here
--
-- 27-2's authorization review established exactly what the Phase 27-1 FK graph
-- does on profile deletion. All three were verified against the local stack,
-- not inferred:
--
--   * Deleting a BOOKER's profile succeeds and cascades the whole thread away
--     -- the conversation, every message in it INCLUDING THE HOST'S OWN, and
--     both read cursors. The host loses their side of the correspondence.
--
--   * Deleting a HOST's profile FAILS outright. locations.host_id cascades, so
--     the delete tries to remove their locations, and conversations.location_id
--     (NO ACTION, matching bookings.location_id) blocks it. A host becomes
--     undeletable as soon as any conversation exists on any of their listings.
--     Note this is not new in kind -- bookings.location_id has had the same
--     effect for hosts with bookings since Phase 6 -- but Phase 27-1 widens
--     the trigger condition from "has a booking" to "has a booking or a
--     conversation".
--
--   * Deleting any SENDER removes the messages they sent from threads that
--     otherwise survive, leaving the counterparty holding one side of a
--     dialogue.
--
-- The approved direction is not to casually destroy the counterparty's
-- communication history, and to preserve or anonymise where appropriate. That
-- is a retention/erasure policy with legal weight (it interacts with account
-- deletion and data-subject erasure), and profiles.status already carries an
-- unused 'deleted' value that a soft-delete design would build on. It is
-- deliberately NOT decided in this migration.
--
-- Nothing in this file depends on the answer: messaging authorization is
-- expressed entirely through RLS policies and the participant helper, none of
-- which reference a deletion action. Whatever retention model is approved can
-- be applied as its own later migration without revisiting anything here.
-- ============================================================================
