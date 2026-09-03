-- Phase 6A: Booking Model & Pricing Expansion
--
-- Replaces the single implicit hourly-rate pricing model from Phase 6 with
-- four distinct booking types (hourly/half_day/day/multi_day), each with its
-- own configurable rate per location. Nothing about the double-booking
-- guarantee changes: every booking type still ultimately resolves to one
-- [start_at, end_at) interval, and the existing partial EXCLUDE constraint
-- on bookings (untouched by this migration) is what protects it.

-- ============================================================================
-- location_pricing — replaces locations.base_price_minor_units/currency as
-- the sole pricing source. Those two columns stay in place (non-destructive)
-- but are no longer read or written by application code after this phase —
-- keeping both live would let them disagree about a location's hourly rate,
-- exactly the "duplicate pricing records" ambiguity this table exists to
-- avoid.
-- ============================================================================

create table public.location_pricing (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations (id) on delete cascade,
  booking_type text not null check (booking_type in ('hourly', 'half_day', 'day', 'multi_day')),

  -- The per-hour rate for 'hourly', the per-day rate for 'multi_day', or the
  -- flat rate for 'half_day'/'day' (no multiplication — the amount already
  -- is the price for that unit).
  amount_minor_units integer not null check (amount_minor_units >= 0),
  currency text not null default 'INR' check (currency ~ '^[A-Z]{3}$'),

  -- Only meaningful (and required) for booking_type = 'half_day': how many
  -- hours a half-day booking spans at this location. Not a fixed universal
  -- constant — host-configurable per location, since the product hasn't
  -- finalized a named morning/afternoon window system yet.
  -- Both branches must resolve to an explicit boolean, not NULL — a plain
  -- NULL BETWEEN comparison evaluates to NULL, and Postgres CHECK
  -- constraints treat NULL as a pass, not a failure, so the "duration
  -- required for half_day" half of this needs its own explicit NOT NULL.
  half_day_duration_hours integer check (
    (booking_type <> 'half_day' and half_day_duration_hours is null)
    or (
      booking_type = 'half_day'
      and half_day_duration_hours is not null
      and half_day_duration_hours between 1 and 23
    )
  ),

  is_active boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One configuration per (location, type) — toggle is_active off rather
  -- than deleting to disable a type, so the configured rate survives for
  -- easy re-enabling and there's never ambiguity about which row is current.
  unique (location_id, booking_type)
);

comment on table public.location_pricing is
  'Per-location, per-booking-type pricing. Replaces the old single hourly '
  'rate on locations. A location need not configure every type; an '
  'unconfigured or inactive type simply cannot be booked.';

create trigger set_location_pricing_updated_at
  before update on public.location_pricing
  for each row
  execute function public.set_updated_at();

-- ============================================================================
-- Backfill: any location with an existing hourly rate gets an equivalent
-- location_pricing row, so already-configured locations don't go dark.
-- ============================================================================

insert into public.location_pricing (location_id, booking_type, amount_minor_units, currency, is_active)
select id, 'hourly', base_price_minor_units, currency, true
from public.locations
where base_price_minor_units is not null;

-- ============================================================================
-- RLS — identical shape to location_categories / location_availability_rules:
-- SELECT mirrors the parent location's visibility (pricing for a live
-- listing is ordinary public marketplace information), INSERT/UPDATE/DELETE
-- requires owning the parent location or being admin.
-- ============================================================================

alter table public.location_pricing enable row level security;

grant select, insert, update, delete on public.location_pricing to service_role;
grant select, insert, update, delete on public.location_pricing to authenticated;
grant select on public.location_pricing to anon;

create policy "location_pricing_select_via_location"
  on public.location_pricing
  for select
  to anon, authenticated
  using (
    exists (
      select 1 from public.locations l
      where l.id = location_id
        and (l.status = 'published' or l.host_id = auth.uid() or public.has_role(auth.uid(), 'admin'))
    )
  );

create policy "location_pricing_write_via_location_owner"
  on public.location_pricing
  for all
  to authenticated
  using (
    exists (
      select 1 from public.locations l
      where l.id = location_id and (l.host_id = auth.uid() or public.has_role(auth.uid(), 'admin'))
    )
  )
  with check (
    exists (
      select 1 from public.locations l
      where l.id = location_id and (l.host_id = auth.uid() or public.has_role(auth.uid(), 'admin'))
    )
  );

-- ============================================================================
-- bookings.booking_type — additive column. Backfilled to 'hourly' for any
-- pre-existing row (Phase 6 only ever created hourly bookings) before the
-- NOT NULL is applied, so no historical booking or its price snapshot is
-- disturbed. The EXCLUDE constraint and every other column are untouched.
-- ============================================================================

alter table public.bookings add column booking_type text;

update public.bookings set booking_type = 'hourly' where booking_type is null;

alter table public.bookings
  alter column booking_type set not null,
  add constraint bookings_booking_type_check check (booking_type in ('hourly', 'half_day', 'day', 'multi_day'));
