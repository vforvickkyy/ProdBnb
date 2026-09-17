-- Phase 29.5: concurrency-safe position assignment when recording uploaded media
--
-- WHY THIS EXISTS
--
-- `completeUpload` assigned a new row's position with a read-then-insert:
--
--   select position from location_media
--    where location_id = $1 order by position desc limit 1;   -- read
--   insert into location_media (..., position) values (..., read + 1);
--
-- Those are two separate statements in two separate implicit transactions, with
-- nothing holding a lock between them. Under READ COMMITTED neither transaction
-- can see the other's uncommitted row, so two completions racing for the SAME
-- location both read the same maximum and both insert the same position.
--
-- This is NOT a rare edge case. `HostPhotoUploadQueue.maxConcurrent == 2` on
-- iOS, so every multi-photo upload runs two completions concurrently against
-- one location. The duplicate is simply invisible today because nothing forbids
-- it -- `location_media_location_position_idx` (Phase 2) is a plain, non-unique
-- index.
--
-- It stops being invisible the moment the planned UNIQUE (location_id, position)
-- index lands: the losing insert would raise 23505, and `completeUpload`'s
-- existing recovery looks the row up by MEDIA ID -- which finds nothing, because
-- a position collision comes from a *different* media id whose row was never
-- inserted -- so the error would be rethrown unmapped as a bare 500. Adding the
-- integrity constraint would have broken ordinary multi-photo upload.
--
-- ############################################################################
-- #  THE LOCK IS THE FIX. A RETRY LOOP IS NOT.                               #
-- ############################################################################
--
-- Computing the position inside the INSERT does not help:
--
--   insert into location_media (...) select ..., coalesce(max(position)+1, 0)
--     from location_media where location_id = $1;
--
-- is still one snapshot read per transaction, so both racers still read the
-- same maximum. Only serialising the read-compute-insert sequence fixes it, and
-- the transaction-scoped advisory lock below is the narrowest tool that does:
--
--   * It is keyed on the LOCATION, so two different locations never block each
--     other -- concurrency is preserved exactly where it is safe.
--   * `pg_advisory_xact_lock` is released automatically when the transaction
--     ends, on commit or rollback. There is no unlock to leak.
--   * It needs no new table, no sequence per location, and no unique index --
--     which matters, because the unique index is deliberately NOT part of this
--     phase.
--
-- The two-key form is used so this lock cannot collide with an advisory lock
-- taken by some unrelated subsystem: the first key namespaces the lock to this
-- concern, the second identifies the location.
--
-- ############################################################################
-- #  SECURITY INVOKER, AND service_role ONLY. DO NOT BROADEN THIS.           #
-- ############################################################################
--
-- Phase 12 revoked INSERT on location_media from `authenticated` outright, so
-- that a host could not register a row pointing at an arbitrary storage_key and
-- bypass the R2 HeadObject verification `completeUpload` performs. The insert
-- has therefore always run through the service-role client, after the service
-- layer has already checked ownership with the CALLER's scoped client.
--
-- This function preserves that exactly: it is granted to `service_role` alone,
-- so it is reachable only from the same trusted path, and it is INVOKER so it
-- grants nobody any privilege they did not already hold. It is deliberately NOT
-- granted to `authenticated` -- that would hand every host precisely the insert
-- capability Phase 12 took away.
--
-- ############################################################################
-- #  WHAT THIS FUNCTION DOES NOT DO                                          #
-- ############################################################################
--
--   * It does not verify the R2 object exists. That stays in the service layer,
--     before this is ever called, and is unchanged.
--   * It does not check ownership. Same -- `assertLocationManageable` runs
--     first, against the caller's own client.
--   * It does not swallow a primary-key violation. A replayed media id must
--     still raise 23505 so `completeUpload`'s idempotent-replay recovery
--     (Phase 29 B2.5-b) can answer 200 with the row that already exists.
--   * It does not renumber, normalise or deduplicate anything. An explicitly
--     supplied `_position` is honoured verbatim, which is the pre-existing
--     contract of the optional `position` field on the complete endpoint.
--
-- No table change, no column change, no index, no grant change to any table.
-- Phase 29.5 adds a function and nothing else.

create function public.record_location_media(
  _media_id uuid,
  _location_id uuid,
  _media_type text,
  _storage_key text,
  _position integer default null
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

  -- Serialise position assignment for THIS location only. Held until this
  -- transaction ends; a concurrent completion for the same location waits here
  -- and then reads a maximum that already includes the row committed ahead of
  -- it. A completion for any other location is unaffected.
  --
  -- hashtext() can in principle collide across locations. A collision costs a
  -- little unnecessary serialisation and nothing else -- it can never produce a
  -- duplicate position, which is the only property that matters here.
  perform pg_advisory_xact_lock(hashtext('location_media.position'), hashtext(_location_id::text));

  if _position is not null then
    -- The caller stated a position. Honoured as-is: this is the existing
    -- contract of `POST .../complete { "position": n }`, and changing it would
    -- be an API change this phase does not make.
    _resolved_position := _position;
  else
    -- Append. Read under the lock, so the value cannot go stale before the
    -- insert below uses it.
    select coalesce(max(m."position") + 1, 0)
      into _resolved_position
      from public.location_media m
     where m.location_id = _location_id;
  end if;

  -- A primary-key violation here is deliberately NOT caught: it means this
  -- media id is already recorded, and the service layer's replay handling owns
  -- that answer.
  return query
    insert into public.location_media (id, location_id, media_type, storage_key, "position")
    values (_media_id, _location_id, _media_type, _storage_key, _resolved_position)
    returning *;
end;
$$;

comment on function public.record_location_media(uuid, uuid, text, text, integer) is
  'Phase 29.5. Records one uploaded object against a location, assigning its '
  'position under a per-location transaction-scoped advisory lock so that '
  'concurrent completions cannot compute the same position. Replaces a '
  'read-then-insert in completeUpload() that could hand two racing uploads the '
  'same position -- invisible while positions may repeat, but a bare 500 once '
  'the planned UNIQUE (location_id, position) index exists, because the '
  'idempotency recovery keys off the media id and a position collision comes '
  'from a different one. An explicit _position is honoured verbatim; NULL '
  'appends at max+1. SECURITY INVOKER and granted to service_role only: '
  'ownership and the R2 HeadObject check both remain in the service layer, and '
  'authenticated deliberately still holds no INSERT on location_media (Phase '
  '12), so this grants nobody anything new.';

-- ACL: the same posture as the project's other write RPCs (see
-- reorder_location_media in 20260917120000_phase29_b25a_media_reorder.sql),
-- except that `authenticated` is NOT granted execute.
--
-- reorder_location_media is granted to authenticated because reordering is a
-- host action authorised by their own UPDATE ("position") grant and the
-- location_media_write_via_location_owner policy. Recording a NEW row is not:
-- Phase 12 removed INSERT from authenticated on purpose, and this function must
-- not quietly give it back. Only the trusted service-role path may call it.
revoke all on function public.record_location_media(uuid, uuid, text, text, integer) from public;
revoke all on function public.record_location_media(uuid, uuid, text, text, integer) from anon;
revoke all on function public.record_location_media(uuid, uuid, text, text, integer) from authenticated;
grant execute on function public.record_location_media(uuid, uuid, text, text, integer) to service_role;
