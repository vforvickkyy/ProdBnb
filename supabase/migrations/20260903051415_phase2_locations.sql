-- Phase 2: Locations / Listings
--
-- The marketplace inventory a HOST lists. "Property type" is deliberately not
-- a separate column — it's represented through `categories` (see docs/DATABASE.md)
-- to avoid duplicating that concept the way categories/use-cases could otherwise
-- overlap. No booking/availability/payment/search/R2 logic belongs here.

-- ============================================================================
-- locations
-- ============================================================================

create table public.locations (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references public.profiles (id) on delete cascade,

  title text not null check (char_length(title) between 1 and 200),
  description text not null default '' check (char_length(description) <= 5000),

  address_line1 text,
  address_line2 text,
  city text not null,
  region text,
  country text not null,
  postal_code text,

  latitude double precision check (latitude is null or latitude between -90 and 90),
  longitude double precision check (longitude is null or longitude between -180 and 180),

  capacity integer check (capacity is null or capacity > 0),

  status text not null default 'draft'
    check (status in (
      'draft', 'submitted', 'under_review', 'approved',
      'published', 'rejected', 'suspended', 'archived'
    )),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.locations is
  'A production location listed by a HOST. Only status = published is publicly '
  'discoverable; other statuses are visible only to the owning host and admins.';

create index locations_host_id_idx on public.locations (host_id);
create index locations_status_idx on public.locations (status);
create index locations_city_idx on public.locations (city);
create index locations_created_at_idx on public.locations (created_at);
create index locations_lat_lng_idx on public.locations (latitude, longitude);

create trigger set_locations_updated_at
  before update on public.locations
  for each row
  execute function public.set_updated_at();

-- ============================================================================
-- categories / amenities / use_cases — normalized lookup tables
--
-- Deliberately no RLS: every row is always visible to everyone, so a
-- permissive `using (true)` policy would be pure boilerplate. Only SELECT is
-- granted to anon/authenticated — there is no client-facing write path;
-- adding a new option later is a one-line insert via service_role.
-- ============================================================================

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

create table public.amenities (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

create table public.use_cases (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

insert into public.categories (name) values
  ('Residential'), ('Commercial'), ('Outdoor'), ('Studio'), ('Office'),
  ('Industrial'), ('Event'), ('Lifestyle'), ('Other');

insert into public.amenities (name) values
  ('Parking'), ('Power'), ('Wi-Fi'), ('Kitchen'), ('Air Conditioning'),
  ('Natural Light'), ('Green Room'), ('Restroom'), ('Sound Control');

insert into public.use_cases (name) values
  ('Film'), ('Advertising'), ('Photography'), ('Music Video'),
  ('Editorial'), ('Event'), ('Other');

-- ============================================================================
-- location_categories / location_amenities / location_use_cases — join tables
-- ============================================================================

create table public.location_categories (
  location_id uuid not null references public.locations (id) on delete cascade,
  category_id uuid not null references public.categories (id) on delete cascade,
  primary key (location_id, category_id)
);
create index location_categories_category_id_idx on public.location_categories (category_id);

create table public.location_amenities (
  location_id uuid not null references public.locations (id) on delete cascade,
  amenity_id uuid not null references public.amenities (id) on delete cascade,
  primary key (location_id, amenity_id)
);
create index location_amenities_amenity_id_idx on public.location_amenities (amenity_id);

create table public.location_use_cases (
  location_id uuid not null references public.locations (id) on delete cascade,
  use_case_id uuid not null references public.use_cases (id) on delete cascade,
  primary key (location_id, use_case_id)
);
create index location_use_cases_use_case_id_idx on public.location_use_cases (use_case_id);

-- ============================================================================
-- location_media — metadata only. Actual files live in Cloudflare R2 (Phase 3).
-- No write grants yet: there is no upload flow to produce a real storage_key,
-- so there is nothing for a write endpoint to do until Phase 3.
-- ============================================================================

create table public.location_media (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations (id) on delete cascade,
  media_type text not null check (media_type in ('photo', 'video')),
  storage_key text not null,
  position integer not null default 0,
  metadata jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index location_media_location_position_idx on public.location_media (location_id, position);

create trigger set_location_media_updated_at
  before update on public.location_media
  for each row
  execute function public.set_updated_at();

-- ============================================================================
-- get_host_public_profile() — minimal public host info for a published listing
--
-- Bridges just what a public listing page needs (name/avatar) without
-- touching Phase 1's profiles RLS/grants, which stay authenticated-only,
-- own-row-or-admin. Only returns a row when the host actually has a
-- published location.
-- ============================================================================

create function public.get_host_public_profile(_host_id uuid)
returns table (id uuid, first_name text, last_name text, avatar_url text)
language sql
security definer
set search_path = public
stable
as $$
  select p.id, p.first_name, p.last_name, p.avatar_url
  from public.profiles p
  where p.id = _host_id
    and exists (
      select 1 from public.locations l
      where l.host_id = p.id and l.status = 'published'
    );
$$;

-- ============================================================================
-- Row Level Security
-- ============================================================================

alter table public.locations enable row level security;
alter table public.location_categories enable row level security;
alter table public.location_amenities enable row level security;
alter table public.location_use_cases enable row level security;
alter table public.location_media enable row level security;

-- Table-level grants must be explicit for every Data API role, including
-- service_role — see Phase 1's migration comment for why.
grant select, insert, update, delete on public.locations to service_role;
grant select, insert, update, delete on public.location_categories to service_role;
grant select, insert, update, delete on public.location_amenities to service_role;
grant select, insert, update, delete on public.location_use_cases to service_role;
grant select, insert, update, delete on public.location_media to service_role;
grant select, insert, update, delete on public.categories to service_role;
grant select, insert, update, delete on public.amenities to service_role;
grant select, insert, update, delete on public.use_cases to service_role;

grant select on public.categories to anon, authenticated;
grant select on public.amenities to anon, authenticated;
grant select on public.use_cases to anon, authenticated;

grant select, insert, update, delete on public.locations to authenticated;
grant select on public.locations to anon;

grant select, insert, delete on public.location_categories to authenticated;
grant select on public.location_categories to anon;
grant select, insert, delete on public.location_amenities to authenticated;
grant select on public.location_amenities to anon;
grant select, insert, delete on public.location_use_cases to authenticated;
grant select on public.location_use_cases to anon;

grant select on public.location_media to authenticated, anon;

grant execute on function public.get_host_public_profile(uuid) to anon, authenticated;

-- locations: published is public; owner or admin can always see their own.
create policy "locations_select_published_or_own_or_admin"
  on public.locations
  for select
  to anon, authenticated
  using (
    status = 'published'
    or host_id = auth.uid()
    or public.has_role(auth.uid(), 'admin')
  );

-- locations: only a HOST may create, and only for themself.
create policy "locations_insert_own_as_host"
  on public.locations
  for insert
  to authenticated
  with check (host_id = auth.uid() and public.has_role(auth.uid(), 'host'));

-- locations: owner or admin may update/delete. Status-transition and field
-- restrictions are enforced at the application layer (see users/roles pattern
-- of validation-schema + service-layer checks, not just RLS).
create policy "locations_update_own_or_admin"
  on public.locations
  for update
  to authenticated
  using (host_id = auth.uid() or public.has_role(auth.uid(), 'admin'))
  with check (host_id = auth.uid() or public.has_role(auth.uid(), 'admin'));

create policy "locations_delete_own_or_admin"
  on public.locations
  for delete
  to authenticated
  using (host_id = auth.uid() or public.has_role(auth.uid(), 'admin'));

-- location_categories / location_amenities / location_use_cases: visibility
-- mirrors the parent location; mutation requires owning that location (or
-- admin). No separate role check needed — ownership already implies the
-- creator was a host.
create policy "location_categories_select_via_location"
  on public.location_categories
  for select
  to anon, authenticated
  using (
    exists (
      select 1 from public.locations l
      where l.id = location_id
        and (l.status = 'published' or l.host_id = auth.uid() or public.has_role(auth.uid(), 'admin'))
    )
  );

create policy "location_categories_write_via_location_owner"
  on public.location_categories
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

create policy "location_amenities_select_via_location"
  on public.location_amenities
  for select
  to anon, authenticated
  using (
    exists (
      select 1 from public.locations l
      where l.id = location_id
        and (l.status = 'published' or l.host_id = auth.uid() or public.has_role(auth.uid(), 'admin'))
    )
  );

create policy "location_amenities_write_via_location_owner"
  on public.location_amenities
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

create policy "location_use_cases_select_via_location"
  on public.location_use_cases
  for select
  to anon, authenticated
  using (
    exists (
      select 1 from public.locations l
      where l.id = location_id
        and (l.status = 'published' or l.host_id = auth.uid() or public.has_role(auth.uid(), 'admin'))
    )
  );

create policy "location_use_cases_write_via_location_owner"
  on public.location_use_cases
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

-- location_media: read-only via the API this phase (no write grant to
-- authenticated/anon at all — see the table comment above). The SELECT
-- policy still mirrors parent-location visibility for when service_role
-- (or a future authenticated write path) inserts rows.
create policy "location_media_select_via_location"
  on public.location_media
  for select
  to anon, authenticated
  using (
    exists (
      select 1 from public.locations l
      where l.id = location_id
        and (l.status = 'published' or l.host_id = auth.uid() or public.has_role(auth.uid(), 'admin'))
    )
  );
