-- Phase 11: Admin Control + Admin Panel
--
-- A purpose-built /v1/admin/* namespace over what largely already exists
-- (booking cancellation, refund creation, and location status transitions
-- were all already admin-capable via RLS/generic PATCH since Phases 2/6/7)
-- plus one genuinely new thing: an immutable audit log. No existing table's
-- meaning changes; this migration only adds.

-- ============================================================================
-- admin_audit_log -- append-only, like payment_webhook_events /
-- notification_delivery_attempts: no updated_at, no trigger, never mutated
-- after insert. Every privileged admin mutation writes exactly one row here
-- as its last step, via the service-role client only -- there is no
-- client-writable path to create, edit, or erase an entry, not even for the
-- admin who performed the action.
-- ============================================================================

create table public.admin_audit_log (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null references public.profiles (id),

  action text not null check (
    action in (
      'ADMIN_APPROVED_LOCATION',
      'ADMIN_REJECTED_LOCATION',
      'ADMIN_SUSPENDED_LOCATION',
      'ADMIN_RESTORED_LOCATION',
      'ADMIN_SUSPENDED_USER',
      'ADMIN_RESTORED_USER',
      'ADMIN_CANCELLED_BOOKING',
      'ADMIN_CREATED_REFUND'
    )
  ),

  target_type text not null check (target_type in ('location', 'user', 'booking', 'payment')),
  target_id uuid not null,

  reason text,
  metadata jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now()
);

comment on table public.admin_audit_log is
  'Append-only record of every privileged admin action. Written exclusively '
  'by the backend (service_role) as the last step of a successful mutation -- '
  'no INSERT/UPDATE/DELETE grant to authenticated at all, so no admin, '
  'including the one who performed an action, can create, edit, or erase an '
  'entry through any API.';

create index admin_audit_log_target_idx on public.admin_audit_log (target_type, target_id);
create index admin_audit_log_admin_id_idx on public.admin_audit_log (admin_id);
create index admin_audit_log_created_at_idx on public.admin_audit_log (created_at desc);

alter table public.admin_audit_log enable row level security;

grant select, insert, update, delete on public.admin_audit_log to service_role;
grant select on public.admin_audit_log to authenticated;

-- Every admin sees every entry -- accountability across the whole admin
-- team is the point, not a private per-admin log.
create policy "admin_audit_log_select_admin_only"
  on public.admin_audit_log
  for select
  to authenticated
  using (public.has_role(auth.uid(), 'admin'));

-- No policy at all for insert/update/delete -- combined with no grant above,
-- RLS denies every authenticated write regardless.

-- ============================================================================
-- locations: two additive columns for moderation
-- ============================================================================

alter table public.locations
  add column moderation_reason text,
  add column suspended_by_host_suspension boolean not null default false;

comment on column public.locations.moderation_reason is
  'The CURRENT explanation shown to the owning host for a rejected/suspended '
  'location -- set on reject/suspend, cleared on approve/restore. The full '
  'historical record of every reason ever given lives in admin_audit_log; '
  'this is not a second status system, just one explanatory field alongside '
  'the existing status column. Visible to the owning host and admin only.';

comment on column public.locations.suspended_by_host_suspension is
  'True only when this location''s current suspended status is a mechanical '
  'side effect of its HOST being suspended (see admin_audit_log '
  'ADMIN_SUSPENDED_USER/ADMIN_RESTORED_USER metadata), never set by the '
  'per-location suspend/restore actions themselves (which always clear it, '
  'marking the location''s state as an independent admin decision). Restoring '
  'a suspended host only republishes locations where this is true -- an '
  'independently-suspended-or-rejected location is never touched by a host '
  'restore.';
