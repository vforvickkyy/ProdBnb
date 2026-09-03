-- Phase 6: Booking Engine + Pricing Foundation
--
-- Reserves a location for a time interval, atomically -- two overlapping
-- requests can never both succeed, enforced by a partial EXCLUDE constraint
-- (the same GiST technique Phase 5 established), not an application-level
-- "check then insert" race. Payment is explicitly out of scope (Phase 7);
-- booking status and payment status are kept as separate concerns from the
-- start by simply not adding any payment column yet.

-- ============================================================================
-- locations: pricing + instant-booking columns
-- ============================================================================

alter table public.locations
  add column base_price_minor_units integer check (base_price_minor_units is null or base_price_minor_units >= 0),
  add column currency text not null default 'INR' check (currency ~ '^[A-Z]{3}$'),
  add column instant_booking_enabled boolean not null default false;

comment on column public.locations.base_price_minor_units is
  'Hourly rate in the smallest currency unit (e.g. paise for INR). Nullable '
  '-- a location without a price set yet cannot be booked. Never floating '
  'point: minor-unit integers avoid rounding error by construction.';

-- ============================================================================
-- bookings
-- ============================================================================

create table public.bookings (
  id uuid primary key default gen_random_uuid(),

  -- No `on delete cascade` here, unlike every other FK to locations in this
  -- schema -- deleting a location with booking history would silently
  -- destroy financial/historical records. locations.service.ts maps the
  -- resulting FK-violation to a clean 409, not a raw 500.
  location_id uuid not null references public.locations (id),
  booker_id uuid not null references public.profiles (id) on delete cascade,

  start_at timestamptz not null,
  end_at timestamptz not null,
  check (end_at > start_at),

  status text not null default 'requested'
    check (status in ('requested', 'confirmed', 'cancelled', 'completed', 'rejected')),

  -- Pricing snapshot -- the price at booking time, frozen. Never recomputed
  -- from the location's current price. platform_fee/tax/discount are always
  -- 0 this phase (no commission/tax model yet) but the columns exist so
  -- Phase 7 can populate them without a schema change.
  base_amount_minor_units integer not null check (base_amount_minor_units >= 0),
  platform_fee_minor_units integer not null default 0 check (platform_fee_minor_units >= 0),
  tax_minor_units integer not null default 0 check (tax_minor_units >= 0),
  discount_minor_units integer not null default 0 check (discount_minor_units >= 0),
  total_amount_minor_units integer not null check (total_amount_minor_units >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  check (
    total_amount_minor_units
    = base_amount_minor_units + platform_fee_minor_units + tax_minor_units - discount_minor_units
  ),

  cancelled_at timestamptz,
  cancelled_by uuid references public.profiles (id),
  cancellation_reason text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- The actual double-booking guarantee: only rows with a reserving status
  -- participate, so a cancelled/rejected booking's interval becomes
  -- instantly reusable the moment its status changes -- no row deletion
  -- needed, booking history is preserved.
  exclude using gist (
    location_id with =,
    tstzrange(start_at, end_at, '[)') with &&
  ) where (status in ('requested', 'confirmed'))
);

comment on table public.bookings is
  'A reservation of a location for a time interval. requested and confirmed '
  'are the only statuses that reserve the interval (see the exclusion '
  'constraint) -- a REQUESTED booking already holds the slot, not just a '
  'CONFIRMED one, so two bookers can never both request the same overlap.';

create index bookings_booker_id_idx on public.bookings (booker_id);

create trigger set_bookings_updated_at
  before update on public.bookings
  for each row
  execute function public.set_updated_at();

-- ============================================================================
-- RLS
-- ============================================================================

alter table public.bookings enable row level security;

grant select, insert, update, delete on public.bookings to service_role;
grant select, insert, update on public.bookings to authenticated;
-- No DELETE grant to authenticated -- bookings are never hard-deleted.

create policy "bookings_select_own_or_hosted_or_admin"
  on public.bookings
  for select
  to authenticated
  using (
    booker_id = auth.uid()
    or exists (select 1 from public.locations l where l.id = location_id and l.host_id = auth.uid())
    or public.has_role(auth.uid(), 'admin')
  );

-- "Create a new resource for yourself" -- same shape as locations' own
-- INSERT policy (host_id = auth.uid() and has_role(...,'host')).
create policy "bookings_insert_own_as_booker"
  on public.bookings
  for insert
  to authenticated
  with check (booker_id = auth.uid() and public.has_role(auth.uid(), 'booker'));

-- Row visibility only -- WHICH transition each role may perform is enforced
-- in bookings.service.ts, not here (RLS answers "can you touch this row at
-- all", the service layer answers "is this specific transition legal").
create policy "bookings_update_own_or_hosted_or_admin"
  on public.bookings
  for update
  to authenticated
  using (
    booker_id = auth.uid()
    or exists (select 1 from public.locations l where l.id = location_id and l.host_id = auth.uid())
    or public.has_role(auth.uid(), 'admin')
  )
  with check (
    booker_id = auth.uid()
    or exists (select 1 from public.locations l where l.id = location_id and l.host_id = auth.uid())
    or public.has_role(auth.uid(), 'admin')
  );

-- ============================================================================
-- get_location_availability() — extended to also subtract active bookings
--
-- Same shape as Phase 5's version, with one more subtraction loop mirroring
-- the existing blocked-periods one exactly. Still never leaks anything
-- booking-specific (booker identity, pricing) -- the return shape is
-- unchanged: (date, start_at, end_at).
-- ============================================================================

create or replace function public.get_location_availability(
  _location_id uuid,
  _from_date date,
  _to_date date
)
returns table (
  date date,
  start_at timestamptz,
  end_at timestamptz
)
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  _tz text;
  _cur_date date;
  _day_name text;
  _override record;
  _windows tstzrange[];
  _available tstzmultirange;
  _range tstzrange;
  _rule record;
  _day_names constant text[] := array[
    'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'
  ];
begin
  if _to_date < _from_date then
    raise exception 'to_date must not be before from_date';
  end if;
  if (_to_date - _from_date) > 90 then
    raise exception 'date range must not exceed 90 days';
  end if;

  select l.timezone into _tz
  from public.locations l
  where l.id = _location_id
    and (l.status = 'published' or l.host_id = auth.uid() or public.has_role(auth.uid(), 'admin'));

  if _tz is null then
    return;
  end if;

  _cur_date := _from_date;
  while _cur_date <= _to_date loop
    _windows := array[]::tstzrange[];

    select o.status, o.start_time, o.end_time into _override
    from public.location_availability_overrides o
    where o.location_id = _location_id and o.date = _cur_date;

    if found then
      if _override.status = 'available' then
        _windows := array[
          tstzrange(
            (_cur_date + _override.start_time) at time zone _tz,
            (_cur_date + _override.end_time) at time zone _tz,
            '[)'
          )
        ];
      end if;
    else
      _day_name := _day_names[extract(dow from _cur_date)::int + 1];
      for _rule in
        select r.start_time, r.end_time
        from public.location_availability_rules r
        where r.location_id = _location_id and r.day_of_week = _day_name
        order by r.start_time
      loop
        _windows := _windows || tstzrange(
          (_cur_date + _rule.start_time) at time zone _tz,
          (_cur_date + _rule.end_time) at time zone _tz,
          '[)'
        );
      end loop;
    end if;

    _available := '{}'::tstzmultirange;
    for _range in select unnest(_windows) loop
      _available := _available + tstzmultirange(_range);
    end loop;

    for _range in
      select tstzrange(b.start_at, b.end_at, '[)')
      from public.location_blocked_periods b
      where b.location_id = _location_id
        and tstzrange(b.start_at, b.end_at, '[)')
          && tstzrange(
            (_cur_date::timestamp) at time zone _tz,
            ((_cur_date + 1)::timestamp) at time zone _tz,
            '[)'
          )
    loop
      _available := _available - tstzmultirange(_range);
    end loop;

    -- Phase 6: also subtract active (requested/confirmed) bookings, the
    -- same overlap-filter shape as the blocks loop directly above.
    for _range in
      select tstzrange(bk.start_at, bk.end_at, '[)')
      from public.bookings bk
      where bk.location_id = _location_id
        and bk.status in ('requested', 'confirmed')
        and tstzrange(bk.start_at, bk.end_at, '[)')
          && tstzrange(
            (_cur_date::timestamp) at time zone _tz,
            ((_cur_date + 1)::timestamp) at time zone _tz,
            '[)'
          )
    loop
      _available := _available - tstzmultirange(_range);
    end loop;

    for _range in select unnest(_available) loop
      date := _cur_date;
      start_at := lower(_range);
      end_at := upper(_range);
      return next;
    end loop;

    _cur_date := _cur_date + 1;
  end loop;
end;
$$;

-- ============================================================================
-- has_conflicting_period() — direct, day-boundary-independent overlap check
--
-- Used by is_interval_available() to catch a conflict sitting on a day in
-- the middle of a multi-day request, which the day-by-day windowing above
-- can't see across in one call. SECURITY DEFINER to read block times
-- (reason stays unselected, so nothing private leaks) -- not granted
-- EXECUTE directly to anon/authenticated, since it's only ever called from
-- within is_interval_available()'s own body, not invoked as a public RPC.
-- ============================================================================

create or replace function public.has_conflicting_period(
  _location_id uuid,
  _start_at timestamptz,
  _end_at timestamptz
)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select
    exists (
      select 1 from public.location_blocked_periods b
      where b.location_id = _location_id
        and tstzrange(b.start_at, b.end_at, '[)') && tstzrange(_start_at, _end_at, '[)')
    )
    or exists (
      select 1 from public.bookings bk
      where bk.location_id = _location_id
        and bk.status in ('requested', 'confirmed')
        and tstzrange(bk.start_at, bk.end_at, '[)') && tstzrange(_start_at, _end_at, '[)')
    );
$$;

-- ============================================================================
-- is_interval_available() — the booking-creation pre-check
--
-- Single-day request: start_at and end_at must fall within the SAME
-- available window (strict containment) -- without this, a request from
-- 11:00-15:00 against windows 09:00-12:00 and 14:00-18:00 would wrongly
-- pass a looser "start in some window, end in some window" check despite
-- the 12:00-14:00 gap in the middle.
--
-- Multi-day request ("continuous custody" model -- see docs/DATABASE.md):
-- check-in must fall within an available window on its calendar day,
-- check-out must fall within an available window on ITS calendar day, and
-- no blocked period or other booking may overlap anywhere in between.
-- Intermediate days impose no operating-hours requirement of their own --
-- Phase 5's time-typed weekly rules can't express "open through midnight"
-- anyway, so requiring every intermediate day to match a full-day window
-- is a dead end without reworking Phase 5.
--
-- This is a pre-check only, for a clean 400 before ever attempting an
-- insert -- the actual double-booking guarantee is the exclusion
-- constraint on bookings itself, which is authoritative regardless of what
-- this function decides.
-- ============================================================================

create or replace function public.is_interval_available(
  _location_id uuid,
  _start_at timestamptz,
  _end_at timestamptz
)
returns boolean
language plpgsql
security invoker
stable
as $$
declare
  _tz text;
  _start_date date;
  _end_date date;
  _window record;
  _start_ok boolean := false;
begin
  if _end_at <= _start_at then
    return false;
  end if;

  select timezone into _tz
  from public.locations
  where id = _location_id
    and (status = 'published' or host_id = auth.uid() or public.has_role(auth.uid(), 'admin'));

  if _tz is null then
    return false;
  end if;

  if public.has_conflicting_period(_location_id, _start_at, _end_at) then
    return false;
  end if;

  _start_date := (_start_at at time zone _tz)::date;
  _end_date := (_end_at at time zone _tz)::date;

  if _start_date = _end_date then
    for _window in
      select start_at, end_at from public.get_location_availability(_location_id, _start_date, _start_date)
    loop
      if _start_at >= _window.start_at and _end_at <= _window.end_at then
        return true;
      end if;
    end loop;
    return false;
  end if;

  for _window in
    select start_at, end_at from public.get_location_availability(_location_id, _start_date, _start_date)
  loop
    if _start_at >= _window.start_at and _start_at < _window.end_at then
      _start_ok := true;
      exit;
    end if;
  end loop;

  if not _start_ok then
    return false;
  end if;

  for _window in
    select start_at, end_at from public.get_location_availability(_location_id, _end_date, _end_date)
  loop
    if _end_at > _window.start_at and _end_at <= _window.end_at then
      return true;
    end if;
  end loop;

  return false;
end;
$$;

grant execute on function public.is_interval_available(uuid, timestamptz, timestamptz) to authenticated;
