-- Phase 8: Notification Infrastructure + APNs Push
--
-- A provider-agnostic notification layer -- in-app notification records,
-- per-device push delivery, user preferences -- as a downstream effect of
-- booking/payment events that already exist (Phases 6/6A/7). Nothing about
-- booking or payment state machines changes; no existing table is touched.
-- APNs is the first NotificationProvider adapter (src/modules/notifications/
-- providers/APNsProvider.ts); a future Android/Web provider is a new adapter
-- file plus a config value, never a rewrite of this schema.

-- ============================================================================
-- user_devices -- one row per (user, physical device/app-install). A push
-- token is a semi-durable identifier for a device+app-install, not for a
-- user, so it's kept globally unique (not scoped per-user): if the same
-- token is registered by a different user later (logout, someone else logs
-- in on the same phone), that row is reassigned rather than producing two
-- rows racing to own the same physical device.
-- ============================================================================

create table public.user_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,

  platform text not null check (platform in ('ios', 'android', 'web')),

  device_token text not null unique,

  -- Meaningful for 'ios' -- a sandbox-signed build's token only works
  -- against Apple's sandbox host, a production one only against production.
  -- Null where it doesn't apply (e.g. a future web push subscription).
  environment text check (environment is null or environment in ('sandbox', 'production')),

  is_active boolean not null default true,
  last_seen_at timestamptz not null default now(),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.user_devices is
  'One row per (user, device/app-install) push registration. device_token is '
  'globally unique across all users -- re-registering an existing token under '
  'a different user reassigns the row rather than erroring, so a shared '
  'device correctly stops notifying the previous user. Never hard-deleted '
  '(is_active is toggled off instead), so notification_delivery_attempts '
  'history stays intact.';

create index user_devices_user_id_idx on public.user_devices (user_id);

create trigger set_user_devices_updated_at
  before update on public.user_devices
  for each row
  execute function public.set_updated_at();

-- ============================================================================
-- notifications -- one row per logical notification per recipient, never
-- per device (see notification_delivery_attempts below for the per-device
-- concern). `type` is deliberately constrained to only the values that have
-- a real backend event source today (see notification.service.ts) and
-- matches the ProdBnb iOS app's own NotificationTypeKey raw values exactly,
-- including two intentional translations: the booking status 'rejected'
-- becomes notification type 'booking_declined', and a refund reaching
-- 'refunded' becomes 'refund_processed' -- iOS has no 'rejected'/'success'
-- notification case, only these.
-- ============================================================================

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,

  type text not null check (
    type in (
      'booking_request_received',
      'booking_confirmed',
      'booking_declined',
      'booking_cancelled',
      'payment_success',
      'payment_failed',
      'refund_processed'
    )
  ),

  title text not null,
  body text not null,

  -- Every event this phase traces back to exactly one booking (confirmed by
  -- the iOS app's own NotificationRouter, which deep-links every one of the
  -- 7 types above via the booking id) -- entity_type is a single-value enum
  -- today on purpose, ready to extend rather than pre-built for entities
  -- that don't exist yet.
  entity_type text not null check (entity_type in ('booking')),
  entity_id uuid not null,

  -- Small structured bag for anything beyond entity_id a push payload wants
  -- to carry (e.g. payment_id) -- mirrors the iOS app's own forward-
  -- compatible userInfo bag.
  data jsonb not null default '{}'::jsonb,

  -- Idempotency key, format "<entity_type>:<entity_id>:<type>" -- fully
  -- deterministic from the triggering entity + event type, so calling the
  -- same notify*() twice (a bug, two racing code paths) collides here and
  -- the second insert is a safe no-op. Nullable for forward-compatibility
  -- with any future non-event-sourced notification.
  source_event_id text,

  read_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (user_id, source_event_id)
);

comment on table public.notifications is
  'One row per logical notification per recipient. Idempotent via '
  '(user_id, source_event_id) -- see notification.service.ts. Delivery '
  'status is NOT stored here (see notification_delivery_attempts): a '
  'notification is per-user-event, delivery is inherently per-device.';

create index notifications_user_id_created_at_idx on public.notifications (user_id, created_at desc);

create trigger set_notifications_updated_at
  before update on public.notifications
  for each row
  execute function public.set_updated_at();

-- ============================================================================
-- notification_preferences -- one row per (user, category), the same
-- "one row per (owner, type)" idiom location_pricing already established.
-- Absence of a row for a category means enabled=true (the service layer
-- defaults it) -- the safe default, so a user who never opens settings
-- still gets transactional notifications. Preferences gate PUSH DELIVERY
-- only, never notification creation -- the in-app notifications list is
-- always complete regardless of this table, so a disabled preference can
-- never accidentally make a critical transactional notification vanish
-- entirely, only suppress the push attempt for it.
-- ============================================================================

create table public.notification_preferences (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,

  category text not null check (category in ('booking', 'payment')),
  enabled boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (user_id, category)
);

comment on table public.notification_preferences is
  'Per-user, per-category push-delivery preference. Only booking/payment '
  'exist as categories -- the only two with a real notification-producing '
  'event this phase. A missing row means enabled (see notification.service.ts).';

create trigger set_notification_preferences_updated_at
  before update on public.notification_preferences
  for each row
  execute function public.set_updated_at();

-- ============================================================================
-- notification_delivery_attempts -- one row per (notification, device) push
-- attempt, append-only like payment_webhook_events: a retry (not
-- implemented this phase, see docs/DATABASE.md) would be a new row, not a
-- mutation of an old one. 'skipped' is the explicit, honest outcome when no
-- provider is configured (NOTIFICATION_PROVIDER=disabled) -- never
-- conflated with a real 'sent' or 'failed'.
-- ============================================================================

create table public.notification_delivery_attempts (
  id uuid primary key default gen_random_uuid(),
  notification_id uuid not null references public.notifications (id),
  device_id uuid not null references public.user_devices (id),

  -- 'disabled' is a real, recordable provider value (not just 'apns') --
  -- NOTIFICATION_PROVIDER=disabled is the default, and every attempt made
  -- under it is truthfully attributed to no real provider, status 'skipped'.
  provider text not null check (provider in ('disabled', 'apns')),
  status text not null check (status in ('sent', 'failed', 'invalid_token', 'skipped')),

  provider_message_id text,
  error_reason text,

  created_at timestamptz not null default now()
);

comment on table public.notification_delivery_attempts is
  'Append-only audit of every push attempt, one row per (notification, '
  'device). Internal only -- never exposed through any API, no '
  'authenticated/anon access at all (mirrors payment_webhook_events).';

create index notification_delivery_attempts_notification_id_idx on public.notification_delivery_attempts (notification_id);
create index notification_delivery_attempts_device_id_idx on public.notification_delivery_attempts (device_id);

-- ============================================================================
-- RLS
-- ============================================================================

alter table public.user_devices enable row level security;
alter table public.notifications enable row level security;
alter table public.notification_preferences enable row level security;
alter table public.notification_delivery_attempts enable row level security;

grant select, insert, update, delete on public.user_devices to service_role;
grant select, insert, update, delete on public.notifications to service_role;
grant select, insert, update, delete on public.notification_preferences to service_role;
grant select, insert, update, delete on public.notification_delivery_attempts to service_role;

-- user_devices: SELECT + UPDATE only for authenticated (the soft-delete
-- toggle is an UPDATE of is_active on a row the caller already owns) -- no
-- INSERT grant. Registration (POST /v1/devices) always goes through the
-- service-role client in device.service.ts, because a token collision with
-- a DIFFERENT user's existing row (reassignment) is something RLS
-- structurally cannot allow a normal user-scoped client to do.
grant select, update on public.user_devices to authenticated;

create policy "user_devices_select_own"
  on public.user_devices
  for select
  to authenticated
  using (user_id = auth.uid());

create policy "user_devices_update_own"
  on public.user_devices
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- notifications: SELECT + UPDATE only (the client only ever sets read_at).
-- No INSERT grant -- a client must never fabricate a notification for
-- itself or anyone else, the same reasoning Phase 7 applied to `payments`.
-- No admin override: notifications are private, and nothing in this phase
-- establishes a legitimate product need for admin visibility into them.
grant select, update on public.notifications to authenticated;

create policy "notifications_select_own"
  on public.notifications
  for select
  to authenticated
  using (user_id = auth.uid());

create policy "notifications_update_own"
  on public.notifications
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- notification_preferences: ordinary self-service, no cross-user concern
-- (a preference row is never shared/reassigned) -- read/write both go
-- through the caller's own request-scoped client.
grant select, insert, update on public.notification_preferences to authenticated;

create policy "notification_preferences_select_own"
  on public.notification_preferences
  for select
  to authenticated
  using (user_id = auth.uid());

create policy "notification_preferences_write_own"
  on public.notification_preferences
  for all
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- notification_delivery_attempts: no policy at all beyond the service_role
-- grant above -- RLS with zero matching policies for a role denies
-- everything, which is exactly the intent (internal audit table only).
