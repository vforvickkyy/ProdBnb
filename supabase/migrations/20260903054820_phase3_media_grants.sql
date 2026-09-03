-- Phase 3: Cloudflare R2 media — write path for location_media
--
-- location_media already exists (Phase 2) with a SELECT-only policy and no
-- write grant for `authenticated` at all — deliberately, since nothing could
-- write there until a real upload flow existed. This adds exactly that: the
-- grant, plus one policy mirroring the same "write allowed if you own the
-- parent location, or are admin" pattern already used for
-- location_categories/location_amenities/location_use_cases in Phase 2.
-- No table or column changes.

grant insert, update, delete on public.location_media to authenticated;

create policy "location_media_write_via_location_owner"
  on public.location_media
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
