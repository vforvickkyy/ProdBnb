-- Phase 5: Availability & Calendar
--
-- Answers "is this location available at this time?" via a weekly schedule,
-- date-specific overrides, and blocked periods, computed into concrete
-- windows by get_location_availability(). This is NOT booking -- nothing
-- here reserves a slot. Phase 6 will subtract confirmed bookings from the
-- same computation (see the comment on get_location_availability below).

create extension if not exists btree_gist with schema extensions;

-- ============================================================================
-- locations.timezone
--
-- Availability is meaningless without a timezone to interpret "Monday
-- 09:00" against. Validated at the application layer (Intl.DateTimeFormat)
-- rather than a DB CHECK -- Postgres CHECK constraints can't contain
-- subqueries, so validating against pg_timezone_names isn't possible there
-- without a trigger, which is more moving parts for the same guarantee.
-- ============================================================================

alter table public.locations add column timezone text not null default 'UTC';

-- ============================================================================
-- location_availability_rules — weekly recurring windows
-- ============================================================================

create table public.location_availability_rules (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations (id) on delete cascade,
  day_of_week text not null check (day_of_week in (
    'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'
  )),
  start_time time not null,
  end_time time not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_time > start_time),
  exclude using gist (
    location_id with =,
    day_of_week with =,
    int4range(
      extract(epoch from start_time)::int,
      extract(epoch from end_time)::int,
      '[)'
    ) with &&
  )
);

comment on table public.location_availability_rules is
  'Weekly recurring availability windows, in wall-clock time relative to the '
  'location''s own timezone. Half-open [start, end) — see the exclusion '
  'constraint, which prevents two overlapping windows on the same day.';

create trigger set_location_availability_rules_updated_at
  before update on public.location_availability_rules
  for each row
  execute function public.set_updated_at();

-- ============================================================================
-- location_availability_overrides — date-specific overrides
--
-- An override REPLACES the day's base weekly schedule entirely; it does not
-- merge with it. 'available' always specifies explicit hours (there's no
-- "same as normal" shorthand — ambiguous on a day with no base rule at
-- all); 'unavailable' is always a full-day closure, no partial form.
-- ============================================================================

create table public.location_availability_overrides (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations (id) on delete cascade,
  date date not null,
  status text not null check (status in ('available', 'unavailable')),
  start_time time,
  end_time time,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (location_id, date),
  check (
    (status = 'unavailable' and start_time is null and end_time is null)
    or (status = 'available' and start_time is not null and end_time is not null and end_time > start_time)
  )
);

create trigger set_location_availability_overrides_updated_at
  before update on public.location_availability_overrides
  for each row
  execute function public.set_updated_at();

-- ============================================================================
-- location_blocked_periods
--
-- reason is PRIVATE — see the RLS policy below (owner/admin SELECT only,
-- never mirrors published-location visibility like every other join table
-- in this schema). get_location_availability() reads block *times*
-- through SECURITY DEFINER, but never returns reason to any caller.
-- ============================================================================

create table public.location_blocked_periods (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations (id) on delete cascade,
  start_at timestamptz not null,
  end_at timestamptz not null,
  reason text,
  created_by uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_at > start_at),
  exclude using gist (
    location_id with =,
    tstzrange(start_at, end_at, '[)') with &&
  )
);

create trigger set_location_blocked_periods_updated_at
  before update on public.location_blocked_periods
  for each row
  execute function public.set_updated_at();

-- ============================================================================
-- get_location_availability() — the computed public/owner query
--
-- SECURITY DEFINER (unlike Phase 4's search_locations, which is INVOKER):
-- this function must read location_blocked_periods to correctly subtract
-- blocked time, but location_blocked_periods.reason is private, so that
-- table's SELECT policy is owner/admin only. A plain INVOKER function
-- called anonymously couldn't see blocks at all and would report
-- too-generous availability to the public. DEFINER lets it read block
-- *times* internally while its RETURN shape never includes reason, and it
-- re-derives the location's own visibility itself before returning
-- anything — the same pattern as get_host_public_profile().
--
-- Phase 6 compatibility: a future bookings table will get the same
-- EXCLUDE-constraint double-booking prevention used below for rules/blocks.
-- This function gains one more subtraction step (confirmed bookings,
-- alongside blocks) at that point — nothing about its signature changes.
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
  _block_range tstzrange;
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
    for _block_range in select unnest(_windows) loop
      _available := _available + tstzmultirange(_block_range);
    end loop;

    for _block_range in
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
      _available := _available - tstzmultirange(_block_range);
    end loop;

    for _block_range in select unnest(_available) loop
      date := _cur_date;
      start_at := lower(_block_range);
      end_at := upper(_block_range);
      return next;
    end loop;

    _cur_date := _cur_date + 1;
  end loop;
end;
$$;

grant execute on function public.get_location_availability(uuid, date, date) to anon, authenticated;

-- ============================================================================
-- Row Level Security
-- ============================================================================

alter table public.location_availability_rules enable row level security;
alter table public.location_availability_overrides enable row level security;
alter table public.location_blocked_periods enable row level security;

grant select, insert, update, delete on public.location_availability_rules to service_role;
grant select, insert, update, delete on public.location_availability_overrides to service_role;
grant select, insert, update, delete on public.location_blocked_periods to service_role;

grant select, insert, update, delete on public.location_availability_rules to authenticated;
grant select on public.location_availability_rules to anon;
grant select, insert, update, delete on public.location_availability_overrides to authenticated;
grant select on public.location_availability_overrides to anon;

-- No anon/public grant on location_blocked_periods at all — see the RLS
-- policy below and the module comment on reason's privacy.
grant select, insert, update, delete on public.location_blocked_periods to authenticated;

-- rules / overrides: SELECT mirrors the parent location's own visibility —
-- a marketplace's general operating hours are ordinary public information.
create policy "location_availability_rules_select_via_location"
  on public.location_availability_rules
  for select
  to anon, authenticated
  using (
    exists (
      select 1 from public.locations l
      where l.id = location_id
        and (l.status = 'published' or l.host_id = auth.uid() or public.has_role(auth.uid(), 'admin'))
    )
  );

create policy "location_availability_rules_write_via_location_owner"
  on public.location_availability_rules
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

create policy "location_availability_overrides_select_via_location"
  on public.location_availability_overrides
  for select
  to anon, authenticated
  using (
    exists (
      select 1 from public.locations l
      where l.id = location_id
        and (l.status = 'published' or l.host_id = auth.uid() or public.has_role(auth.uid(), 'admin'))
    )
  );

create policy "location_availability_overrides_write_via_location_owner"
  on public.location_availability_overrides
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

-- blocked_periods: owner/admin only, even for SELECT — the one departure
-- from the "mirrors location visibility" shape used everywhere else,
-- because reason is private and directly reachable via PostgREST with just
-- the public anon key (bypassing this Express app entirely).
create policy "location_blocked_periods_owner_or_admin"
  on public.location_blocked_periods
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
