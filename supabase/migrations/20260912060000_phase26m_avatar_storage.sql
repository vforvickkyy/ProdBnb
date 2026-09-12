-- Phase 26-M: Supabase Storage for profile avatars
--
-- Creates the `avatars` bucket and the four `storage.objects` policies the iOS client needs.
-- Scope is exactly this bucket: no other bucket, policy or schema is touched, and Storage RLS is
-- left enabled (it already is).
--
-- **This is not listing media.** Listing photos stay on Cloudflare R2, reached through
-- `/v1/locations/:id/media` and gated by `assertLocationManageable`. A profile photo has no
-- location to hang off, which is why it needs its own, user-scoped home.
--
-- The iOS client (`SupabaseAvatarStorageRepository`) uploads to:
--
--     POST /storage/v1/object/avatars/<auth-user-id>/avatar.<jpg|png>
--
-- with the user's bearer token and `x-upsert: true`, then stores the public URL in
-- `profiles.avatar_url` (the column has existed since Phase 1).

-- ============================================================================
-- Bucket
--
-- Public, deliberately: an avatar is meant to be viewable by anyone who can see the profile, and
-- the client persists a public URL rather than minting signed URLs on every render.
--
-- `file_size_limit` and `allowed_mime_types` mirror the client's own limits exactly
-- (`AvatarContentType` = jpeg/png, `maxSizeMB` = 5). Belt and braces: a public bucket should not
-- accept arbitrary files just because the client happens to behave.
--
-- `on conflict do nothing` so re-running this migration never rewrites a bucket that already
-- exists — it must not silently flip an existing bucket's visibility or limits.
-- ============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'avatars',
  'avatars',
  true,
  5242880,                                  -- 5 MB, matching the client
  array['image/jpeg', 'image/png']
)
on conflict (id) do nothing;

-- ============================================================================
-- Policies
--
-- Ownership rule, used by all three write policies:
--
--     (storage.foldername(name))[1] = auth.uid()::text
--
-- `storage.foldername(name)` splits the object name on "/" and returns every segment except the
-- last, so for `"<user-id>/avatar.jpg"` it yields `{"<user-id>"}` and `[1]` is the owning user's
-- id. (Verified against this project's own `storage.foldername` definition rather than assumed.)
--
-- It fails closed by construction: an object uploaded to the bucket root has no folder segment, so
-- `[1]` is NULL, `NULL = auth.uid()::text` is NULL, and the policy does not match.
--
-- `owner`/`owner_id` are deliberately not used for this. `owner` is documented as deprecated, and
-- the path is what the client actually controls — pinning the rule to the path is what guarantees
-- user A cannot write into user B's folder.
--
-- Each policy is dropped-if-exists first so the migration is re-runnable. Only these four names
-- are touched; no pre-existing policy is affected (there were none on `storage.objects`).
-- ============================================================================

-- Read: public. The bucket is public, and an avatar is meant to be seen. Scoped to this bucket
-- only — it grants nothing anywhere else.
drop policy if exists "avatars_public_read" on storage.objects;
create policy "avatars_public_read"
  on storage.objects
  for select
  to public
  using (bucket_id = 'avatars');

-- Upload: only into your own folder.
drop policy if exists "avatars_insert_own" on storage.objects;
create policy "avatars_insert_own"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Replace: only your own object, and it must still be yours afterwards.
--
-- Both `using` and `with check` are required. `using` decides which rows you may update; without
-- `with check` an update could rename an object *into* someone else's folder, which is exactly the
-- cross-user write this is meant to prevent. `x-upsert` from the client lands here.
drop policy if exists "avatars_update_own" on storage.objects;
create policy "avatars_update_own"
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Delete: only your own object.
drop policy if exists "avatars_delete_own" on storage.objects;
create policy "avatars_delete_own"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ============================================================================
-- Deliberately NOT done here
--
-- - Row Level Security on `storage.objects` is left as-is (already enabled). It is never disabled.
-- - No blanket grant to `authenticated` over `storage.objects`; every write policy above is scoped
--   to this bucket AND to the caller's own folder.
-- - No service-role path is involved in a normal user upload — the client uses the user's own
--   access token.
-- - No other bucket is created, altered or dropped.
-- ============================================================================
