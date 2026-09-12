-- Phase 27-8: Message notifications
--
-- Three CHECK constraints widened, and nothing else. No new table, no new
-- column, no new index, no new trigger, no policy change, no grant change, and
-- no Realtime object of any kind. Phase 27-1 through 27-7 are untouched.
--
-- ============================================================================
-- WHY THIS IS THE WHOLE MIGRATION
--
-- ProdBnb already has a complete push notification system: Phase 8 built the
-- provider-agnostic delivery stack (public.notifications,
-- public.notification_preferences, public.user_devices,
-- public.notification_delivery_attempts, a real APNs provider) and Phase 26-K
-- wired the iOS token lifecycle to it. It has been delivering booking and
-- payment notifications since it shipped.
--
-- The 27-8 inspection probed what actually stopped that system from carrying a
-- message notification, by attempting the inserts rather than reading the DDL.
-- The answer was exactly three CHECK constraints:
--
--   insert ... type='new_message', entity_type='conversation'
--     ERROR:  violates check constraint "notifications_entity_type_check"
--   insert ... type='new_message', entity_type='booking'
--     ERROR:  violates check constraint "notifications_type_check"
--   insert into notification_preferences ... category='message'
--     ERROR:  violates check constraint "notification_preferences_category_check"
--
-- Everything else the feature needs already exists. Hence a migration that
-- widens three vocabularies and stops.
--
-- ============================================================================
-- WHY DROP + ADD RATHER THAN "ALTER"
--
-- PostgreSQL has no statement that edits a CHECK expression in place, so a
-- widened constraint is necessarily dropped and re-added under the same name.
--
-- Every change here is PURELY WIDENING: each new constraint accepts a strict
-- superset of what the old one accepted. No existing row can be invalidated by
-- one, which is why a plain ADD CONSTRAINT is correct and a NOT VALID /
-- VALIDATE CONSTRAINT split would be ceremony -- that pattern exists to avoid a
-- long ACCESS EXCLUSIVE lock while scanning a large table to prove existing
-- rows comply, and here compliance is guaranteed by construction.
--
-- ============================================================================
-- WHAT IS DELIBERATELY NOT DONE
--
--   * No foreign key from notifications.entity_id to conversations.id.
--     entity_id has always been a bare uuid -- it points at bookings today with
--     no FK either -- and adding one now would give a deleted conversation the
--     power to either block the delete or cascade notification history away.
--     Phase 27-2 reached the same conclusion for admin_message_access.
--
--   * No 'message_reply' type. The backend has no event that distinguishes a
--     reply from a first message, and a CHECK value with no producer is a
--     promise the system does not keep. (iOS already defines the key; that is
--     the client running ahead of the server, not a contract to satisfy.)
--
--   * No new preference granularity -- no per-conversation muting, no quiet
--     hours, no digests. One category, matching booking and payment.
-- ============================================================================

-- ============================================================================
-- 1. notifications.type -- add 'new_message'
--
-- The seven existing values are re-listed verbatim and in their original order
-- so a future reader can diff this against the Phase 8 migration and see that
-- exactly one value was appended.
-- ============================================================================

alter table public.notifications
  drop constraint notifications_type_check;

alter table public.notifications
  add constraint notifications_type_check check (
    type in (
      'booking_request_received',
      'booking_confirmed',
      'booking_declined',
      'booking_cancelled',
      'payment_success',
      'payment_failed',
      'refund_processed',
      'new_message'
    )
  );

-- ============================================================================
-- 2. notifications.entity_type -- add 'conversation'
--
-- Phase 8 wrote this as `check (entity_type in ('booking'))`. A single-element
-- IN is normalised by PostgreSQL to `entity_type = 'booking'` in the catalog,
-- which is why \d displays a bare equality -- the author's intent was always a
-- list, and this restores it to one.
--
-- entity_type is what the client routes on: the iOS NotificationRouter reads
-- prodbnb_entity_type/prodbnb_conversation_id and deep-links to the Inbox,
-- exactly as 'booking' sends it to the Bookings tab.
-- ============================================================================

alter table public.notifications
  drop constraint notifications_entity_type_check;

alter table public.notifications
  add constraint notifications_entity_type_check check (
    entity_type in ('booking', 'conversation')
  );

comment on column public.notifications.entity_type is
  'What this notification is about, and what the client deep-links to: a '
  'booking (Phase 8) or a conversation (Phase 27-8). Deliberately a bare enum '
  'with NO foreign key on entity_id -- a deleted entity must neither block the '
  'delete nor erase the notification history describing it.';

-- ============================================================================
-- 3. notification_preferences.category -- add 'message'
--
-- Gates PUSH DELIVERY ONLY. It is never consulted when deciding whether to
-- CREATE the in-app notification row -- a user who has turned message pushes
-- off still sees the message in their in-app list. That asymmetry is Phase 8's
-- and is preserved exactly.
--
-- A MISSING ROW MEANS ENABLED (see preferences.service.ts). So this migration
-- backfills nothing and needs to backfill nothing: every existing user is
-- opted in to message notifications the moment the category exists, which is
-- the approved behaviour (decision N-7) and matches how booking and payment
-- have always behaved.
-- ============================================================================

alter table public.notification_preferences
  drop constraint notification_preferences_category_check;

alter table public.notification_preferences
  add constraint notification_preferences_category_check check (
    category in ('booking', 'payment', 'message')
  );

comment on table public.notification_preferences is
  'Per-user, per-category push-delivery preference: booking, payment (Phase 8) '
  'and message (Phase 27-8). A missing row means ENABLED, so no backfill is '
  'needed when a category is added and a user who never opens settings still '
  'receives transactional and message push. Gates push delivery only -- the '
  'in-app notification row is created regardless (see notification.service.ts).';
