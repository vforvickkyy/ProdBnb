-- Phase 4: Search & Discovery
--
-- PostgreSQL/PostGIS-native search for the public marketplace feed. No
-- external search engine. One SECURITY INVOKER function (search_locations)
-- does the actual work — PostgREST's filter DSL can't express "match ALL of
-- these amenity ids", "order by computed distance", or full-text rank all at
-- once. The function explicitly filters status = 'published' itself, rather
-- than relying on RLS alone, since this is a public/anon-callable function.

create extension if not exists postgis with schema extensions;

-- ============================================================================
-- Generated columns
--
-- Both are derived entirely from existing columns (title/description/city,
-- latitude/longitude) so they can never drift out of sync. lat/lng stay the
-- simple, portable representation every client already consumes;
-- search_vector/location_point exist purely as internal, indexable
-- representations for full-text and geospatial queries.
-- ============================================================================

-- to_tsvector(regconfig, text) — the explicit-config form — is IMMUTABLE and
-- so valid in a generated column; the plain to_tsvector(text) form is not
-- (it depends on a runtime setting).
alter table public.locations
  add column search_vector tsvector generated always as (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(city, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'C')
  ) stored;

create index locations_search_vector_idx on public.locations using gin (search_vector);

alter table public.locations
  add column location_point extensions.geography(Point, 4326) generated always as (
    case
      when latitude is not null and longitude is not null
        then extensions.ST_SetSRID(extensions.ST_MakePoint(longitude, latitude), 4326)::extensions.geography
    end
  ) stored;

create index locations_location_point_idx on public.locations using gist (location_point);

-- Every search query filters status = 'published' and commonly sorts by
-- created_at — the one genuinely justified new plain index this phase adds.
create index locations_status_created_at_idx on public.locations (status, created_at desc);

-- ============================================================================
-- search_locations() — the public discovery query
-- ============================================================================

create or replace function public.search_locations(
  _search text default null,
  _city text default null,
  _region text default null,
  _country text default null,
  _category_ids uuid[] default null,
  _amenity_ids uuid[] default null,
  _use_case_ids uuid[] default null,
  _capacity_min integer default null,
  _capacity_max integer default null,
  _lat double precision default null,
  _lng double precision default null,
  _radius_km double precision default null,
  _north double precision default null,
  _south double precision default null,
  _east double precision default null,
  _west double precision default null,
  _sort text default 'newest',
  _page integer default 1,
  _page_size integer default 20
)
returns table (
  id uuid,
  title text,
  excerpt text,
  city text,
  region text,
  country text,
  latitude double precision,
  longitude double precision,
  capacity integer,
  distance_km double precision,
  categories jsonb,
  use_cases jsonb,
  primary_media_key text,
  created_at timestamptz,
  total_count bigint
)
language sql
security invoker
stable
as $$
  with filtered as (
    select l.*
    from public.locations l
    where l.status = 'published'
      and (_search is null or l.search_vector @@ websearch_to_tsquery('english', _search))
      and (_city is null or lower(l.city) = lower(_city))
      and (_region is null or lower(l.region) = lower(_region))
      and (_country is null or lower(l.country) = lower(_country))
      and (_capacity_min is null or l.capacity >= _capacity_min)
      and (_capacity_max is null or l.capacity <= _capacity_max)
      and (
        _category_ids is null or exists (
          select 1 from public.location_categories lc
          where lc.location_id = l.id and lc.category_id = any(_category_ids)
        )
      )
      and (
        _use_case_ids is null or exists (
          select 1 from public.location_use_cases luc
          where luc.location_id = l.id and luc.use_case_id = any(_use_case_ids)
        )
      )
      and (
        _amenity_ids is null or (
          select count(distinct la.amenity_id)
          from public.location_amenities la
          where la.location_id = l.id and la.amenity_id = any(_amenity_ids)
        ) = cardinality(_amenity_ids)
      )
      and (
        _radius_km is null or (
          l.location_point is not null
          and extensions.ST_DWithin(
            l.location_point,
            extensions.ST_SetSRID(extensions.ST_MakePoint(_lng, _lat), 4326)::extensions.geography,
            _radius_km * 1000
          )
        )
      )
      and (
        _north is null or (
          l.latitude between _south and _north and l.longitude between _west and _east
        )
      )
  )
  select
    f.id,
    f.title,
    left(f.description, 240) as excerpt,
    f.city,
    f.region,
    f.country,
    f.latitude,
    f.longitude,
    f.capacity,
    case
      when _lat is not null then
        extensions.ST_Distance(
          f.location_point,
          extensions.ST_SetSRID(extensions.ST_MakePoint(_lng, _lat), 4326)::extensions.geography
        ) / 1000
    end as distance_km,
    (
      select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name)), '[]'::jsonb)
      from public.location_categories lc
      join public.categories c on c.id = lc.category_id
      where lc.location_id = f.id
    ) as categories,
    (
      select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'name', u.name)), '[]'::jsonb)
      from public.location_use_cases luc
      join public.use_cases u on u.id = luc.use_case_id
      where luc.location_id = f.id
    ) as use_cases,
    (
      select lm.storage_key
      from public.location_media lm
      where lm.location_id = f.id
      order by lm.position asc
      limit 1
    ) as primary_media_key,
    f.created_at,
    count(*) over () as total_count
  from filtered f
  order by
    (case when _sort = 'nearest' and _lat is not null then
      extensions.ST_Distance(
        f.location_point,
        extensions.ST_SetSRID(extensions.ST_MakePoint(_lng, _lat), 4326)::extensions.geography
      )
    end) asc,
    (case when _sort = 'relevant' and _search is not null then
      ts_rank(f.search_vector, websearch_to_tsquery('english', _search))
    end) desc,
    f.created_at desc
  offset (_page - 1) * least(_page_size, 100)
  limit least(_page_size, 100);
$$;

grant execute on function public.search_locations(
  text, text, text, text, uuid[], uuid[], uuid[], integer, integer,
  double precision, double precision, double precision,
  double precision, double precision, double precision, double precision,
  text, integer, integer
) to anon, authenticated;
