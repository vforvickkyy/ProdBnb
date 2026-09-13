-- Phase 29 D1: starting price on the public discovery card
--
-- Adds one nullable `starting_price` summary to search_locations() so a Discover
-- card can show an honest "From ₹15,000/day" without an N+1. Before this, the
-- public list endpoint returned no pricing at all, so EVERY card read "Contact
-- host for pricing" regardless of how the location was really priced.
--
-- Nothing else about the function changes: every parameter, filter, sort,
-- offset/limit, total_count, the published-status check and all existing output
-- columns are carried over verbatim. The addition is SELECT-list only, so it
-- cannot alter which rows match or the order they come back in.
--
-- CREATE OR REPLACE is not usable here — Postgres refuses it when the return
-- type changes — so the function is dropped and recreated, and the execute
-- grant is RE-ISSUED at the bottom. Dropping a function discards its ACL, and
-- without that grant the anon marketplace feed would 403. (Same shape as
-- 20260913000000_phase27_7_read_state.sql, which drops and re-grants
-- get_conversations_for_viewer.)

-- ============================================================================
-- The starting-price rule (Phase 29 decision D1-a, approved)
--
-- Among a location's ACTIVE pricing rows with a POSITIVE amount:
--
--   * all one currency  -> the cheapest amount wins; ties break by unit order
--   * several currencies -> unit order alone decides
--   * none               -> NULL
--
-- The multi-currency branch exists because location_pricing.currency is per
-- row, not per location — nothing in the schema stops a host configuring
-- hourly in USD and day in INR. Comparing minor units across currencies would
-- be meaningless (USD 100 is not "less than" INR 3000), and converting them
-- would require an exchange rate this system does not have and must not
-- invent. So the comparison is simply not made; the deterministic unit order
-- answers instead.
--
-- Unit order is hourly -> half_day -> day -> multi_day: smallest bookable
-- commitment first. It matches iOS's existing BookingPricingTier.displayOrder,
-- which is the only tier ordering that existed anywhere in ProdBnb before this
-- migration. The rule now lives here so web and Android inherit one answer
-- instead of each re-deriving it.
--
-- Zero-amount rows are excluded (decision D1-b). The CHECK on the column is
-- `>= 0`, so 0 is storable, and under a cheapest-amount rule a single 0 row
-- would make every card read "From ₹0". Such a row stays valid stored data and
-- is neither deleted nor altered — it just never becomes the "From" price.
--
-- `min(currency) over () = max(currency) over ()` is the single-currency test.
-- count(DISTINCT ...) is deliberately not used: Postgres does not implement
-- DISTINCT for window functions.
--
-- This is a SUMMARY of configured pricing, never a quote. The authoritative
-- total still comes from the booking flow.
-- ============================================================================

drop function public.search_locations(
  text, text, text, text, uuid[], uuid[], uuid[], integer, integer,
  double precision, double precision, double precision,
  double precision, double precision, double precision, double precision,
  text, integer, integer
);

create function public.search_locations(
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
  starting_price jsonb,
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
    -- Every column is qualified with `p.`/`t.`: the RETURNS TABLE output names
    -- above are in scope in this body, and `currency` would otherwise be
    -- ambiguous against locations.currency, which phase 6a left in place.
    (
      select jsonb_build_object(
               'amount_minor_units', t.amount_minor_units,
               'currency',           t.currency,
               'booking_type',       t.booking_type
             )
      from (
        select
          p.amount_minor_units,
          p.currency,
          p.booking_type,
          (min(p.currency) over () = max(p.currency) over ()) as single_currency
        from public.location_pricing p
        where p.location_id = f.id
          and p.is_active
          and p.amount_minor_units > 0
      ) t
      order by
        -- NULL for every row when the location mixes currencies, so they all
        -- tie here and the unit order below is what actually decides.
        case when t.single_currency then t.amount_minor_units end asc nulls last,
        case t.booking_type
          when 'hourly'    then 1
          when 'half_day'  then 2
          when 'day'       then 3
          when 'multi_day' then 4
        end asc
      limit 1
    ) as starting_price,
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

-- Re-grant: DROP FUNCTION discarded the previous ACL. Without this the public
-- marketplace feed 403s for anonymous callers.
grant execute on function public.search_locations(
  text, text, text, text, uuid[], uuid[], uuid[], integer, integer,
  double precision, double precision, double precision,
  double precision, double precision, double precision, double precision,
  text, integer, integer
) to anon, authenticated;
