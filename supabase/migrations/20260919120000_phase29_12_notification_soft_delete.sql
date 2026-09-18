-- Phase 29.12: Notification soft delete
--
-- Lets a user remove a notification from their own inbox (iOS swipe-to-delete)
-- WITHOUT destroying the row.
--
-- ############################################################################
-- #  WHY SOFT AND NOT HARD                                                   #
-- ############################################################################
--
-- A hard `delete from public.notifications` is wrong three times over here:
--
-- 1. IT WOULD FAIL. notification_delivery_attempts.notification_id references
--    public.notifications (id) with NO `on delete` clause, i.e. NO ACTION. So
--    deleting any notification that was ever pushed to an active device raises
--    a foreign-key violation (23503) -- which is precisely the set of
--    notifications a user is most likely to want gone (the ones that buzzed
--    their phone). That FK is deliberate: the attempts table documents itself
--    as an append-only audit, and this migration does NOT relax it.
--
-- 2. IT WOULD DESTROY AUDIT HISTORY. Same reason.
--
-- 3. IT WOULD FREE THE IDEMPOTENCY KEY. `unique (user_id, source_event_id)` is
--    what makes notify() safe to call twice. Remove the row and a retry of the
--    same source event silently recreates the notification the user deleted.
--    Keeping the row keeps the collision, so deleted stays deleted. FOREVER.
--
-- Soft delete preserves all four things that matter: notification identity,
-- delivery audit history, source_event_id idempotency, and read state.
--
-- ############################################################################
-- #  THE ONE SEMANTIC RULE EVERYTHING ELSE FOLLOWS FROM                      #
-- ############################################################################
--
--   notifications.deleted_at IS NULL      -> in the user's active inbox
--   notifications.deleted_at IS NOT NULL  -> hidden from EVERY user-facing
--                                            read path, row retained
--
-- "Every user-facing read path" is exhaustive and enumerated in
-- notification.service.ts: listNotifications, getNotification, the unread
-- count (which is listNotifications' `count`), and markAllNotificationsRead.
-- A path that forgets the filter is the one way a deleted notification comes
-- back, so tests in tests/notifications.test.ts pin all four.

alter table public.notifications
  add column deleted_at timestamptz;

comment on column public.notifications.deleted_at is
  'Set when the recipient removes the notification from their inbox. NULL '
  'means active. Never hard-deleted: notification_delivery_attempts holds an '
  'append-only FK to this row, and (user_id, source_event_id) must keep '
  'colliding so a retried source event cannot resurrect a deleted '
  'notification. Every user-facing read path filters `deleted_at is null`.';

-- The list endpoint's exact access pattern (user's active notifications,
-- newest first). Partial, because deleted rows are never listed -- they are
-- retained only to anchor the FK and the idempotency key.
--
-- The Phase 8 index notifications_user_id_created_at_idx is deliberately left
-- in place: it still serves the unfiltered service-role/admin reads.
create index notifications_user_id_active_created_at_idx
  on public.notifications (user_id, created_at desc)
  where deleted_at is null;

-- ============================================================================
-- Grants / RLS -- INTENTIONALLY UNCHANGED.
--
-- Soft deletion is an UPDATE of a column on a row the caller already owns, so
-- it is already authorised by what Phase 8 established:
--
--   grant select, update on public.notifications to authenticated;   -- line 236
--   create policy "notifications_update_own" ... using (user_id = auth.uid())
--                                              with check (user_id = auth.uid());
--
-- That grant is TABLE-level, not column-level (verified against the whole
-- migration history -- the column-scoped `grant update (...)` idiom is used on
-- public.profiles and public.location_media, but never on this table), so the
-- new column needs no grant of its own.
--
-- Deliberately NOT added:
--   * no `grant delete ... to authenticated`
--   * no delete RLS policy
-- A client must never be able to actually remove a notification row; row
-- ownership stays enforced by user_id = auth.uid() exactly as before.
-- ============================================================================

-- Fails the migration loudly if the assumption above ever stops holding, rather
-- than silently shipping an endpoint the client has no privilege to exercise.
-- A TABLE-level grant covers every column, including one added after the grant.
do $$
begin
  if not exists (
    select 1
    from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name = 'notifications'
      and grantee = 'authenticated'
      and privilege_type = 'UPDATE'
  ) then
    raise exception
      'phase29_12: authenticated has no table-level UPDATE grant on public.notifications -- soft delete cannot work';
  end if;
end
$$;
