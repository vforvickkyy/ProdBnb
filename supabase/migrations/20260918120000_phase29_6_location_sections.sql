-- Phase 29.6: Location Sections
--
-- A location may optionally be divided into named production areas -- "Police
-- Station", "Arabian City", "Warehouse" -- each with its own name, description
-- and ordered photos. The location keeps its general gallery for photos that
-- belong to no particular section.
--
-- ############################################################################
-- #  THE ONE SEMANTIC RULE EVERYTHING ELSE FOLLOWS FROM                      #
-- ############################################################################
--
--   location_media.section_id IS NULL      -> the GENERAL location gallery
--   location_media.section_id = <section>  -> that section's gallery
--
-- A photo belongs to exactly ONE gallery. There is no many-to-many membership,
-- no duplicated row to make one photo appear twice, and no is_cover flag. The
-- cover convention is unchanged and applies WITHIN a gallery: the lowest
-- `position` among the rows of that gallery.
--
-- Every existing row keeps `section_id = NULL` and therefore stays exactly what
-- it is today: a general-gallery photo. Nothing is moved, invented or deleted.
--
-- ############################################################################
-- #  WHY `ON DELETE NO ACTION` ON section_id, AND NOT CASCADE OR RESTRICT     #
-- ############################################################################
--
-- CASCADE is wrong: deleting a section would silently delete its media rows,
-- orphaning the R2 objects behind them with nothing left pointing at the keys.
-- Media deletion is the one path that also removes the stored object, and it
-- must stay deliberate.
--
-- RESTRICT is wrong for a subtler reason. Deleting a LOCATION cascades to both
-- location_sections and location_media independently, and the order in which
-- Postgres processes those two cascades is not defined. A RESTRICT check fires
-- immediately, so if the sections cascade runs first it would abort the whole
-- location delete while the media rows were still standing -- breaking an
-- operation that works today.
--
-- NO ACTION is checked at the END of the statement, by which time both cascades
-- have completed and nothing references the deleted sections any more. So:
--
--   * deleting a location with sections and section media -> works
--   * deleting a section that still holds media           -> 23503, a hard backstop
--
-- The API refuses a non-empty section with a 409 long before the constraint is
-- reached; this is the belt to that braces.

create table public.location_sections (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations (id) on delete cascade,
  name text not null,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Sections are always read as "this location's sections", newest rules applied
-- in the service layer. No unique constraint on (location_id, name): duplicate
-- section names are explicitly allowed -- two stages really can both be called
-- "Warehouse", and forcing a rename would be the product inventing a rule.
create index location_sections_location_idx on public.location_sections (location_id, created_at);

create trigger set_location_sections_updated_at
  before update on public.location_sections
  for each row
  execute function public.set_updated_at();

comment on table public.location_sections is
  'Phase 29.6. An optional named production area within a location ("Police '
  'Station", "Arabian City"). Photos join a section through '
  'location_media.section_id; section_id IS NULL means the general location '
  'gallery. Duplicate names within a location are allowed by design. The 20 '
  'sections-per-location cap is enforced in the service layer, where it can '
  'return a clean 400, rather than as a trigger.';

comment on column public.location_sections.description is
  'Optional free text. NULL and empty string are both permitted and mean the '
  'same thing to clients.';

-- ============================================================================
-- location_media.section_id
-- ============================================================================

alter table public.location_media
  add column section_id uuid null references public.location_sections (id) on delete no action;

-- Mirrors location_media_location_position_idx (Phase 2) but for a section's
-- own gallery: every section media read is "this section, ordered by position".
create index location_media_section_position_idx
  on public.location_media (section_id, "position")
  where section_id is not null;

-- The general gallery is now a filtered subset of a location's media rather
-- than all of them, and it is read on every location detail, search result and
-- conversation row. A partial index keeps that the cheap path it was.
create index location_media_general_gallery_idx
  on public.location_media (location_id, "position")
  where section_id is null;

comment on column public.location_media.section_id is
  'Phase 29.6. NULL = this photo is in the location''s GENERAL gallery. '
  'Non-NULL = it belongs to that section''s gallery, and to that one only. A '
  'photo is never in two galleries. Positions are numbered 0..n-1 WITHIN a '
  'gallery, so a general photo and a section photo may both sit at position 0. '
  'Any query that means "the general gallery" -- notably a cover-photo lookup '
  '-- must say `section_id is null` explicitly, or a section photo at position '
  '0 will be picked as the location''s cover.';

-- ============================================================================
-- Grants and RLS
-- ============================================================================
--
-- Supabase ships ALTER DEFAULT PRIVILEGES granting ALL on new public tables to
-- anon, authenticated and service_role, so this table arrived with full DML
-- already granted to anon. Revoking first and granting back explicitly is the
-- Phase 12 pattern, and it is the only way the grants below mean what they say.

revoke all on public.location_sections from anon;
revoke all on public.location_sections from authenticated;

grant select on public.location_sections to anon;
grant select, insert, update, delete on public.location_sections to authenticated;
grant select, insert, update, delete on public.location_sections to service_role;

alter table public.location_sections enable row level security;

-- Visibility mirrors the parent location exactly, the same rule
-- location_media_select_via_location uses: a published location's sections are
-- public; a draft's are visible only to its host and to admins.
create policy "location_sections_select_via_location"
  on public.location_sections
  for select
  to anon, authenticated
  using (
    exists (
      select 1 from public.locations l
      where l.id = location_id
        and (l.status = 'published' or l.host_id = auth.uid() or public.has_role(auth.uid(), 'admin'))
    )
  );

-- Writes follow location_media_write_via_location_owner: the owner of the
-- parent location, or an admin. WITH CHECK as well as USING, so a section
-- cannot be moved to another location by updating location_id.
create policy "location_sections_write_via_location_owner"
  on public.location_sections
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
-- record_location_media() -- now gallery-aware (Phase 29.5 guarantee preserved)
-- ============================================================================
--
-- Phase 29.5 made position assignment concurrency-safe by resolving the next
-- position and inserting under a transaction-scoped advisory lock, because the
-- previous read-then-insert let two concurrent completions compute the same
-- position. That guarantee is preserved exactly; what changes is its SCOPE.
--
-- Positions are per-GALLERY (Option B), not per-location:
--
--   general gallery   section_id IS NULL   -> 0, 1, 2, ...
--   section A         section_id = A       -> 0, 1, 2, ...
--   section B         section_id = B       -> 0, 1, 2, ...
--
-- So the max() must be taken within the gallery, and the lock must be keyed on
-- the gallery too. Keying it on the location alone would still be correct but
-- would needlessly serialise uploads to different sections of the same
-- location; keying it on the section alone would be WRONG, because every
-- general-gallery upload shares a NULL section and would collapse into one key
-- across all locations.
--
-- The key is therefore derived from location AND section together. NULL is
-- rendered as an empty string so the general gallery has its own stable key,
-- distinct from every section of the same location.

drop function public.record_location_media(uuid, uuid, text, text, integer);

create function public.record_location_media(
  _media_id uuid,
  _location_id uuid,
  _media_type text,
  _storage_key text,
  _position integer default null,
  _section_id uuid default null
)
returns setof public.location_media
language plpgsql
security invoker
set search_path = public
as $$
declare
  _resolved_position integer;
begin
  if _media_id is null or _location_id is null then
    raise exception 'record_location_media: _media_id and _location_id must not be null'
      using errcode = '22023';
  end if;

  if _media_type is null or _storage_key is null then
    raise exception 'record_location_media: _media_type and _storage_key must not be null'
      using errcode = '22023';
  end if;

  -- A section must belong to the location the media is being recorded against.
  -- The service layer checks this first and returns the proper error; this is
  -- the backstop that makes it impossible to bypass.
  if _section_id is not null then
    if not exists (
      select 1 from public.location_sections s
       where s.id = _section_id and s.location_id = _location_id
    ) then
      raise exception 'record_location_media: _section_id does not belong to _location_id'
        using errcode = '22023';
    end if;
  end if;

  -- Serialise position assignment for THIS GALLERY only. Held until the
  -- transaction ends; a concurrent completion for the same gallery waits here
  -- and then reads a maximum that already includes the row committed ahead of
  -- it. Another section, or another location, is unaffected.
  --
  -- hashtext() can in principle collide across galleries. A collision costs a
  -- little unnecessary serialisation and nothing else -- it can never produce a
  -- duplicate position, which is the only property that matters here.
  perform pg_advisory_xact_lock(
    hashtext('location_media.position'),
    hashtext(_location_id::text || ':' || coalesce(_section_id::text, ''))
  );

  if _position is not null then
    -- The caller stated a position. Honoured as-is: this is the existing
    -- contract of `POST .../complete { "position": n }`.
    _resolved_position := _position;
  else
    -- Append within the gallery. `is not distinct from` is what makes the NULL
    -- case work: `section_id = null` would match no rows and every general
    -- upload would be handed position 0.
    select coalesce(max(m."position") + 1, 0)
      into _resolved_position
      from public.location_media m
     where m.location_id = _location_id
       and m.section_id is not distinct from _section_id;
  end if;

  -- A primary-key violation here is deliberately NOT caught: it means this
  -- media id is already recorded, and the service layer's replay handling owns
  -- that answer.
  return query
    insert into public.location_media (id, location_id, section_id, media_type, storage_key, "position")
    values (_media_id, _location_id, _section_id, _media_type, _storage_key, _resolved_position)
    returning *;
end;
$$;

comment on function public.record_location_media(uuid, uuid, text, text, integer, uuid) is
  'Phase 29.5, gallery-aware since Phase 29.6. Records one uploaded object '
  'against a location''s general gallery (_section_id NULL) or one of its '
  'sections, assigning its position under an advisory lock keyed on that '
  'GALLERY so concurrent completions cannot compute the same position. '
  'Positions run 0..n-1 within each gallery independently. Rejects a section '
  'belonging to a different location. An explicit _position is honoured '
  'verbatim; NULL appends. SECURITY INVOKER, granted to service_role only: '
  'ownership and the R2 HeadObject check both remain in the service layer, and '
  'authenticated deliberately still holds no INSERT on location_media.';

-- DROP discarded the old ACL, so it is restated in full. Unchanged from
-- Phase 29.5: service_role ONLY. Granting `authenticated` execute here would
-- hand back precisely the direct INSERT capability Phase 12 removed.
revoke all on function public.record_location_media(uuid, uuid, text, text, integer, uuid) from public;
revoke all on function public.record_location_media(uuid, uuid, text, text, integer, uuid) from anon;
revoke all on function public.record_location_media(uuid, uuid, text, text, integer, uuid) from authenticated;
grant execute on function public.record_location_media(uuid, uuid, text, text, integer, uuid) to service_role;

-- ============================================================================
-- reorder_location_media() -- now gallery-aware
-- ============================================================================
--
-- Phase 29 B2.5-a anticipated this exactly: "when section_id is introduced, the
-- general gallery becomes section_id is null and a section's gallery
-- section_id = _section_id. Both counts below, and both UPDATE statements, gain
-- the same predicate. Nothing else in this function changes." That is precisely
-- what happens here.
--
-- The complete-set rule now applies WITHIN the selected gallery: reordering a
-- section must list that section's photos exactly, and may not name a general
-- gallery photo (or another section's) -- and vice versa. Cross-gallery ids are
-- rejected by the same "does not belong to this gallery" check that already
-- rejected another location's ids.
--
-- The two-phase renumber is unchanged and still not a stylistic choice: a
-- unique index is checked per row during a multi-row UPDATE, so assigning
-- 0,1,2... in one statement would collide with itself. See the B2.5-a migration
-- for why a deferrable constraint is a dead end.

drop function public.reorder_location_media(uuid, uuid[]);

create function public.reorder_location_media(
  _location_id uuid,
  _ordered_ids uuid[],
  _section_id uuid default null
)
returns setof public.location_media
language plpgsql
security invoker
set search_path = public
as $$
declare
  _requested_count integer;
  _distinct_count  integer;
  _gallery_count   integer;
  _matched_count   integer;
begin
  if _location_id is null then
    raise exception 'reorder_location_media: _location_id must not be null'
      using errcode = '22023';
  end if;

  if _ordered_ids is null then
    raise exception 'reorder_location_media: _ordered_ids must not be null'
      using errcode = '22023';
  end if;

  -- array_length returns NULL, not 0, for an empty array.
  _requested_count := coalesce(array_length(_ordered_ids, 1), 0);

  if _requested_count = 0 then
    raise exception 'reorder_location_media: _ordered_ids must not be empty'
      using errcode = '22023';
  end if;

  select count(distinct x) into _distinct_count from unnest(_ordered_ids) as x;

  if _distinct_count <> _requested_count then
    raise exception 'reorder_location_media: _ordered_ids contains duplicate ids'
      using errcode = '22023';
  end if;

  if _section_id is not null then
    if not exists (
      select 1 from public.location_sections s
       where s.id = _section_id and s.location_id = _location_id
    ) then
      raise exception 'reorder_location_media: _section_id does not belong to _location_id'
        using errcode = '22023';
    end if;
  end if;

  -- The gallery this call operates on. `is not distinct from` selects the
  -- general gallery when _section_id is NULL and one section otherwise.
  select count(*) into _gallery_count
    from public.location_media
   where location_id = _location_id
     and section_id is not distinct from _section_id;

  if _gallery_count <> _requested_count then
    raise exception 'reorder_location_media: _ordered_ids must list the complete gallery (gallery has %, received %)',
      _gallery_count, _requested_count
      using errcode = '22023';
  end if;

  -- Every requested id must actually belong to THIS gallery. Without the
  -- section predicate, a general-gallery id could renumber a section (and vice
  -- versa) while reporting success.
  select count(*) into _matched_count
    from public.location_media lm
   where lm.location_id = _location_id
     and lm.section_id is not distinct from _section_id
     and lm.id = any(_ordered_ids);

  if _matched_count <> _requested_count then
    raise exception 'reorder_location_media: _ordered_ids contains media that does not belong to this gallery'
      using errcode = '22023';
  end if;

  -- Pass 1: vacate the non-negative range.
  update public.location_media as lm
     set "position" = -(o.ord)
    from unnest(_ordered_ids) with ordinality as o(media_id, ord)
   where lm.id = o.media_id
     and lm.location_id = _location_id
     and lm.section_id is not distinct from _section_id;

  -- Pass 2: the final, contiguous, 0-based order.
  update public.location_media as lm
     set "position" = (o.ord - 1)::integer
    from unnest(_ordered_ids) with ordinality as o(media_id, ord)
   where lm.id = o.media_id
     and lm.location_id = _location_id
     and lm.section_id is not distinct from _section_id;

  return query
    select lm.*
      from public.location_media lm
     where lm.location_id = _location_id
       and lm.section_id is not distinct from _section_id
     order by lm."position" asc;
end;
$$;

comment on function public.reorder_location_media(uuid, uuid[], uuid) is
  'Phase 29 B2.5-a, gallery-aware since Phase 29.6. Atomically renumbers ONE '
  'gallery to exactly 0..n-1 in the order given: the location''s general '
  'gallery when _section_id is NULL, otherwise that section''s. _ordered_ids '
  'must list that gallery''s photos exactly once each; an id from another '
  'gallery, another section or another location is rejected. SECURITY INVOKER: '
  'the caller''s own UPDATE ("position") grant and the '
  'location_media_write_via_location_owner RLS policy (owner or admin) are what '
  'authorize it. Two-phase renumber (negative, then final) so it never '
  'self-collides under the unique index a later phase adds. Raises 22023 as a '
  'backstop -- the service layer performs the primary validation and error '
  'mapping.';

-- DROP discarded the old ACL. Restated unchanged from B2.5-a: `authenticated`
-- keeps execute, because reordering is a host action already authorised by its
-- own UPDATE ("position") grant and the owner-or-admin RLS policy.
revoke all on function public.reorder_location_media(uuid, uuid[], uuid) from public;
revoke all on function public.reorder_location_media(uuid, uuid[], uuid) from anon;
grant execute on function public.reorder_location_media(uuid, uuid[], uuid) to authenticated, service_role;

-- ============================================================================
-- Cover-photo readers: the general gallery must stay the general gallery
-- ============================================================================
--
-- Two live objects pick a location's cover with `order by position asc limit 1`
-- and no section predicate. Left alone, a section photo sitting at position 0 --
-- which is now entirely normal, because positions restart per gallery -- would
-- be served as the LOCATION's primary image in search results and in the
-- conversation list. Both are recreated below with `section_id is null` added.
-- Nothing else about either definition changes.

-- ---------------------------------------------------------------------------
-- search_locations(): primary_media_key
-- ---------------------------------------------------------------------------
--
-- Reproduced VERBATIM from 20260913120000_phase29_d1_search_starting_price.sql,
-- the live definition, with exactly one line added: `and lm.section_id is null`
-- in the primary_media_key subquery. Nothing else -- not the geo filters, not
-- the D1 cheapest-tier starting_price rule, not the paging -- is touched.
--
-- CREATE OR REPLACE rather than DROP + CREATE, deliberately: the signature is
-- unchanged, and replacing in place PRESERVES the function's ACL. A DROP would
-- discard it and require the grants to be restated exactly (the trap D1 itself
-- had to handle).

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
        and lm.section_id is null   -- Phase 29.6: general gallery only
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

-- ---------------------------------------------------------------------------
-- get_conversations_for_viewer(): location_primary_media_key
-- ---------------------------------------------------------------------------
--
-- Same treatment, same reason: reproduced VERBATIM from
-- 20260913000000_phase27_7_read_state.sql (the live definition, which superseded
-- the Phase 27-3 one) with the single `and lm.section_id is null` added. The
-- conversation list shows each thread's location thumbnail; without this a
-- section photo could become that thumbnail.

create or replace function public.get_conversations_for_viewer(
  _cursor_last_message_at timestamptz default null,
  _cursor_id uuid default null,
  _limit integer default 20,
  _conversation_id uuid default null
)
returns table (
  id uuid,
  booking_id uuid,
  last_message_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  viewer_role text,
  location_id uuid,
  location_title text,
  location_city text,
  location_status text,
  location_primary_media_key text,
  counterparty_id uuid,
  counterparty_first_name text,
  counterparty_last_name text,
  counterparty_avatar_url text,
  unread_count bigint
)
language sql
security definer
set search_path = public
stable
as $$
  select
    c.id,
    c.booking_id,
    c.last_message_at,
    c.created_at,
    c.updated_at,

    case when c.booker_id = auth.uid() then 'booker' else 'host' end as viewer_role,

    l.id as location_id,
    l.title as location_title,
    l.city as location_city,
    l.status as location_status,

    (
      select lm.storage_key
      from public.location_media lm
      where lm.location_id = l.id
        and lm.section_id is null   -- Phase 29.6: general gallery only
      order by lm.position asc
      limit 1
    ) as location_primary_media_key,

    p.id as counterparty_id,
    p.first_name as counterparty_first_name,
    p.last_name as counterparty_last_name,
    p.avatar_url as counterparty_avatar_url,

    -- ------------------------------------------------------------------
    -- unread_count -- derived, never stored.
    --
    -- A denormalized counter would mean incrementing a column on the hot
    -- message-insert path for the non-sender and recomputing it on every
    -- mark-read: a second source of truth that can drift from `messages`,
    -- which is the authority. Phase 27-1 rejected a denormalized participant
    -- table for exactly this reason. Measured, the derived form costs ~0.4 ms
    -- per 20-row page, so there is nothing to buy.
    --
    -- CAPPED AT 100 (approved decision D-1). The inner `limit 101` is what
    -- makes the work BOUNDED: without it this is O(unread) per conversation
    -- and a single 5,000-message unread thread dominates the page. 101, not
    -- 100, so that "exactly 100 unread" and "more than 100 unread" are
    -- distinguishable inside the subquery; `least(…, 100)` then clamps the
    -- reported value, so the API contract is 0..100 where 100 means
    -- "100 or more".
    --
    -- THE PREDICATE. `sender_id <> auth.uid()` -- your own messages are never
    -- unread to you; sending is reading. The row comparison is the same total
    -- (created_at, id) order as the message index and the pagination cursor,
    -- written as a SINGLE unconditional comparison with COALESCE sentinels so
    -- PostgreSQL can use it as an index RANGE START CONDITION on the existing
    -- messages_conversation_id_created_at_id_idx under a GENERIC parameterized
    -- plan -- measured as `Index Cond`, not `Filter`. This is Phase 27-5's
    -- lesson applied in the opposite direction: '-infinity' and the minimum
    -- uuid mean "no cursor -> everything from the counterparty is unread", and
    -- they also absorb the half-null cursor state described in the header.
    --
    -- NO NEW INDEX IS ADDED; this is a pure range scan on the Phase 27-1 index.
    -- ------------------------------------------------------------------
    least(
      (
        select count(*)
        from (
          select 1
          from public.messages m
          where m.conversation_id = c.id
            and m.sender_id <> auth.uid()
            and (m.created_at, m.id) > (
                  coalesce(r.last_read_at,         '-infinity'::timestamptz),
                  coalesce(r.last_read_message_id, '00000000-0000-0000-0000-000000000000'::uuid)
                )
          limit 101
        ) capped
      ),
      100
    ) as unread_count

  from public.conversations c
  join public.locations l on l.id = c.location_id
  left join public.profiles p
    on p.id = case when c.booker_id = auth.uid() then l.host_id else c.booker_id end
  -- The caller's own cursor for this conversation. LEFT, because "no row yet"
  -- is the normal state of a conversation nobody has opened and must mean
  -- "everything unread", not "drop this conversation from the Inbox".
  -- Scoped to auth.uid(): this function is SECURITY DEFINER, so RLS does not
  -- scope it and the predicate has to.
  left join public.conversation_reads r
    on r.conversation_id = c.id
   and r.user_id = auth.uid()

  where
    auth.uid() is not null

    and (c.booker_id = auth.uid() or l.host_id = auth.uid())

    and (_conversation_id is null or c.id = _conversation_id)

    and (
      _conversation_id is not null
      or _cursor_last_message_at is null
      or c.last_message_at < _cursor_last_message_at
      or (c.last_message_at = _cursor_last_message_at and c.id < _cursor_id)
    )

  order by c.last_message_at desc, c.id desc

  limit greatest(least(coalesce(_limit, 20), 101), 1);
$$;
