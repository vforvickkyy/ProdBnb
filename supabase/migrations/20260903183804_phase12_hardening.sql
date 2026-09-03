-- Phase 12: Security + Integrity Hardening
--
-- Closes a gap common to `bookings`/`locations`/`location_media`: RLS on
-- these tables has always checked ROW ownership only ("is this your row"),
-- never WHICH COLUMNS or WHICH VALUES a write may touch. Every legitimate
-- ProdBnb client already holds a real Supabase session (needed to talk to
-- Supabase Auth at all), so a caller could go around the Express app
-- entirely and PATCH their own booking's price down to near-zero, self-
-- publish a location bypassing admin moderation, or fabricate a location_media
-- row pointing at another location's real R2 object. `profiles.status` and
-- `payments`/`payment_refunds` already got this right (Phase 1 and Phase 7,
-- respectively) -- this migration extends the same column-grant-restriction
-- pattern to the three tables that were missed, and adds one DB-level
-- backstop each for two TOCTOU races (duplicate successful payment,
-- concurrent over-refund) mirroring the existing `payments_one_inflight_
-- per_booking` technique. Purely additive: no existing table, column, or
-- migration is altered or dropped.

-- ============================================================================
-- bookings: no authenticated INSERT/UPDATE at all, going forward.
--
-- Every legitimate write already goes through bookings.service.ts, which now
-- performs its actual insert/update via the service-role client (see the
-- matching application change) after doing the exact same authorization/
-- business-rule checks it always did -- nothing about WHO may create or
-- transition a booking changes, only WHERE the write is executed from. This
-- exactly mirrors how `payments`/`payment_refunds` have worked since Phase 7.
-- SELECT is untouched -- booker/host/admin visibility via RLS is unaffected.
-- ============================================================================

revoke insert, update on public.bookings from authenticated;

comment on table public.bookings is
  'A reservation of a location for a time interval. requested and confirmed '
  'are the only statuses that reserve the interval (see the exclusion '
  'constraint) -- a REQUESTED booking already holds the slot, not just a '
  'CONFIRMED one, so two bookers can never both request the same overlap. '
  'authenticated has SELECT only (Phase 12) -- every insert/update goes '
  'through the backend service-role client, which already fully enforces '
  'authorization and pricing/interval correctness before writing.';

-- ============================================================================
-- locations: authenticated keeps INSERT/UPDATE, but never for the
-- moderation-controlling columns (status, moderation_reason,
-- suspended_by_host_suspension) or host_id. A host's own content edits
-- (title/description/address/...) and the initial create still go straight
-- through their own scoped client, unchanged. Every status-affecting write
-- (a host's own draft->submitted/submitted->draft/published->archived, or an
-- admin's moderation/override) now goes through the service-role client --
-- see the matching application change in locations.service.ts and
-- admin/locations.service.ts. Authorization itself is unchanged: it was
-- already fully checked in application code before any write executed.
-- ============================================================================

revoke insert, update on public.locations from authenticated;

grant insert (
  host_id, title, description,
  address_line1, address_line2, city, region, country, postal_code,
  latitude, longitude, capacity, timezone, instant_booking_enabled
) on public.locations to authenticated;

grant update (
  title, description,
  address_line1, address_line2, city, region, country, postal_code,
  latitude, longitude, capacity, timezone, instant_booking_enabled
) on public.locations to authenticated;

-- status/moderation_reason/suspended_by_host_suspension/host_id: no
-- authenticated grant at all, on either insert or update -- status always
-- starts at its column default ('draft') on create, and can only ever move
-- from there via the service-role-backed code paths in locations.service.ts
-- / admin/locations.service.ts.

-- ============================================================================
-- location_media: only completeUpload() may ever create a row (after its own
-- R2 headObject verification), and only via the service-role client from now
-- on -- no authenticated INSERT grant at all. Reordering (position) remains a
-- normal host/admin self-service action; deleting is unaffected.
-- ============================================================================

revoke insert, update on public.location_media from authenticated;
grant update (position) on public.location_media to authenticated;

-- ============================================================================
-- admin_audit_log: one additive action, for the generic admin status
-- override that PATCH /v1/locations/:id still allows (unlike the four
-- purpose-built moderation actions, this path can reach ANY of the 8
-- statuses -- including 'approved' and 'under_review', which no dedicated
-- endpoint produces -- so it can't simply be folded into one of the existing
-- eight action values). Every admin mutation is now audited, not just the
-- ones reachable through /v1/admin/*.
-- ============================================================================

-- Looked up dynamically rather than hardcoding Postgres's auto-generated
-- name for the original inline `check (...)` -- avoids a wrong guess about
-- exactly what that name is.
do $$
declare
  _constraint_name text;
begin
  select conname into _constraint_name
  from pg_constraint
  where conrelid = 'public.admin_audit_log'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) like '%ADMIN_APPROVED_LOCATION%';

  if _constraint_name is not null then
    execute format('alter table public.admin_audit_log drop constraint %I', _constraint_name);
  end if;
end $$;

alter table public.admin_audit_log add constraint admin_audit_log_action_check check (
  action in (
    'ADMIN_APPROVED_LOCATION',
    'ADMIN_REJECTED_LOCATION',
    'ADMIN_SUSPENDED_LOCATION',
    'ADMIN_RESTORED_LOCATION',
    'ADMIN_UPDATED_LOCATION_STATUS',
    'ADMIN_SUSPENDED_USER',
    'ADMIN_RESTORED_USER',
    'ADMIN_CANCELLED_BOOKING',
    'ADMIN_CREATED_REFUND'
  )
);

-- ============================================================================
-- payments: DB-level backstop against a booking accumulating more than one
-- successful payment. The application already rejects this (see the matching
-- application change in payment.service.ts) -- this index is what makes that
-- guarantee atomic under concurrent requests, exactly the same relationship
-- payments_one_inflight_per_booking already has to its own application-level
-- pre-check.
-- ============================================================================

create unique index payments_one_settled_per_booking
  on public.payments (booking_id)
  where (status in ('success', 'partially_refunded', 'refunded'));

-- ============================================================================
-- payment_refunds: DB-level backstop against two concurrent refund requests
-- both reading the same "remaining balance" before either commits (the
-- application's own check-then-insert in createRefund() is correct but not
-- atomic on its own). Locks the parent payment row for the duration of the
-- check, so a second concurrent insert against the same payment necessarily
-- waits for the first to commit (and see its refund counted) before it can
-- proceed. Mirrors the exact balance rule payment.service.ts#createRefund
-- already applies -- this is a backstop, not a new business rule.
-- ============================================================================

create or replace function public.enforce_refund_balance()
returns trigger
language plpgsql
as $$
declare
  _payment_amount integer;
  _already_committed integer;
begin
  select amount_minor_units into _payment_amount
  from public.payments
  where id = new.payment_id
  for update;

  if not found then
    raise exception 'Payment % not found', new.payment_id;
  end if;

  select coalesce(sum(amount_minor_units), 0) into _already_committed
  from public.payment_refunds
  where payment_id = new.payment_id
    and status in ('pending', 'success');

  if _already_committed + new.amount_minor_units > _payment_amount then
    raise exception 'Refund amount % exceeds the remaining refundable balance for payment %',
      new.amount_minor_units, new.payment_id
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger enforce_refund_balance_before_insert
  before insert on public.payment_refunds
  for each row
  execute function public.enforce_refund_balance();

-- ============================================================================
-- Missing indexes for query patterns that already exist in the service
-- layer (bookings/admin listing filters, admin payments/refunds dashboard) --
-- see listBookings() in bookings.service.ts and listAllPayments()/
-- listAllRefunds() in admin/payments.service.ts. The existing partial GiST
-- exclusion index on bookings only covers active-status overlap checks, not
-- plain listing/filtering across all statuses.
-- ============================================================================

create index bookings_location_id_start_at_idx on public.bookings (location_id, start_at desc);
create index bookings_status_start_at_idx on public.bookings (status, start_at desc);
create index payments_status_created_at_idx on public.payments (status, created_at desc);
create index payment_refunds_status_created_at_idx on public.payment_refunds (status, created_at desc);
