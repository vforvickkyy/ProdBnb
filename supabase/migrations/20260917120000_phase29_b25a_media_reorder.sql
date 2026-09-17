-- Phase 29 B2.5-a: atomic reorder for a location's media gallery
--
-- WHY THIS EXISTS
--
-- Reordering is currently done by the client issuing one PATCH
-- /v1/locations/:id/media/:mediaId per moved photo. Making a photo the cover
-- therefore costs up to N sequential, independent requests -- each its own
-- transaction -- so a failure part-way leaves the gallery partially
-- renumbered, and two clients can interleave freely. There is also nothing
-- stopping two rows sharing a position, which makes `order by position` a
-- non-deterministic tie.
--
-- This function makes the whole renumber one statement-level transaction.
-- The PATCH endpoint is deliberately left in place and unchanged; B2.5-c
-- switches iOS off it, and only then (B2.5-f) does the uniqueness index land.
--
-- ############################################################################
-- #  THE TWO-PHASE RENUMBER IS NOT A STYLISTIC CHOICE.                       #
-- ############################################################################
--
-- B2.5-f will add:
--
--   create unique index location_media_gallery_position_uidx
--     on public.location_media (location_id, "position");
--
-- A unique *index* is checked per row as a multi-row UPDATE proceeds. Assigning
-- 0,1,2,... in a single statement therefore transiently places two rows on the
-- same position and fails spuriously, even though the committed state is
-- perfectly valid.
--
-- The obvious escape -- a DEFERRABLE UNIQUE *constraint* -- is a dead end:
-- `alter table ... add constraint ... unique (...)` accepts only plain columns,
-- never an expression, and B2.6 needs
--   coalesce(section_id, '00000000-0000-0000-0000-000000000000'::uuid)
-- which can only be a unique *index*, and an index cannot be deferred.
--
-- So the renumber is done in two passes inside one transaction:
--
--   pass 1:  "position" := -(ordinality)   -- -1, -2, -3 ... unique per location
--   pass 2:  "position" := ordinality - 1  -- the final 0, 1, 2 ...
--
-- Pass 1 vacates the entire non-negative range before pass 2 writes into it, so
-- no intermediate collision is possible. Both passes commit together, so the
-- negative state is never observable outside this function. This works with a
-- plain unique index and needs no deferral -- which is precisely what lets B2.6
-- swap in its expression-based index without touching this body.
--
-- ############################################################################
-- #  SECURITY INVOKER, DELIBERATELY. DO NOT MAKE THIS SECURITY DEFINER.      #
-- ############################################################################
--
-- `authenticated` already holds exactly the privilege this needs:
--
--   grant update ("position") on public.location_media to authenticated;   (phase12_hardening)
--
-- and the existing RLS policy `location_media_write_via_location_owner`
-- already encodes the full rule, admin included:
--
--   host_id = auth.uid() OR public.has_role(auth.uid(), 'admin')
--
-- Running as INVOKER therefore keeps RLS in force for free and grants no new
-- privilege to anyone. A DEFINER function would bypass that policy and would
-- have to re-implement the ownership check internally -- strictly worse.
--
-- The primary validation and the 404/403 distinction live in the service layer
-- (media.service.ts), matching every other media route. The assertions below
-- are a defensive backstop: they must never fire in normal operation, and if
-- they do they indicate a caller bug, so they surface as a 500 rather than
-- being silently tolerated. RLS is NOT used as a substitute for them -- a list
-- containing another location's media id must be rejected outright, never
-- allowed to silently renumber only the matching subset.
--
-- No table change, no column change, no grant change, no index. B2.5-a adds a
-- function and nothing else.

create function public.reorder_location_media(
  _location_id uuid,
  _ordered_ids uuid[]
)
returns setof public.location_media
language plpgsql
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

  -- The gallery this call operates on.
  --
  -- B2.6 COMPATIBILITY: when `section_id` is introduced, the general gallery
  -- becomes `section_id is null` and a section's gallery becomes
  -- `section_id = _section_id`. Both counts below, and both UPDATE statements,
  -- gain the same predicate. Nothing else in this function changes.
  select count(*) into _gallery_count
    from public.location_media
   where location_id = _location_id;

  if _gallery_count <> _requested_count then
    raise exception 'reorder_location_media: _ordered_ids must list the complete gallery (gallery has %, received %)',
      _gallery_count, _requested_count
      using errcode = '22023';
  end if;

  -- Every requested id must actually belong to this location's gallery. Without
  -- this, an id from another location would simply match no row and the UPDATE
  -- would renumber a partial gallery while reporting success.
  select count(*) into _matched_count
    from public.location_media lm
   where lm.location_id = _location_id
     and lm.id = any(_ordered_ids);

  if _matched_count <> _requested_count then
    raise exception 'reorder_location_media: _ordered_ids contains media that does not belong to this gallery'
      using errcode = '22023';
  end if;

  -- Pass 1: vacate the non-negative range. -1, -2, -3 ... are unique per
  -- location, so this cannot collide with itself either.
  update public.location_media as lm
     set "position" = -(o.ord)
    from unnest(_ordered_ids) with ordinality as o(media_id, ord)
   where lm.id = o.media_id
     and lm.location_id = _location_id;

  -- Pass 2: the final, contiguous, 0-based order.
  update public.location_media as lm
     set "position" = (o.ord - 1)::integer
    from unnest(_ordered_ids) with ordinality as o(media_id, ord)
   where lm.id = o.media_id
     and lm.location_id = _location_id;

  return query
    select lm.*
      from public.location_media lm
     where lm.location_id = _location_id
     order by lm."position" asc;
end;
$$;

comment on function public.reorder_location_media(uuid, uuid[]) is
  'Phase 29 B2.5-a. Atomically renumbers one location gallery to exactly 0..n-1 '
  'in the order given. SECURITY INVOKER: the caller''s own UPDATE ("position") '
  'grant and the location_media_write_via_location_owner RLS policy (owner or '
  'admin) are what authorize it. Two-phase renumber (negative, then final) so it '
  'never self-collides under the unique index B2.5-f adds. Raises 22023 as a '
  'backstop if _ordered_ids is not exactly the gallery''s id set -- the service '
  'layer performs the primary validation and error mapping.';

-- ACL: the same posture as the project's other write RPCs (see
-- mark_conversation_read in 20260913000000_phase27_7_read_state.sql).
--
-- `anon` is revoked explicitly as well as `public`. This function WRITES, and a
-- write path should not rely solely on RLS refusing an anonymous caller.
revoke all on function public.reorder_location_media(uuid, uuid[]) from public;
revoke all on function public.reorder_location_media(uuid, uuid[]) from anon;
grant execute on function public.reorder_location_media(uuid, uuid[]) to authenticated, service_role;
