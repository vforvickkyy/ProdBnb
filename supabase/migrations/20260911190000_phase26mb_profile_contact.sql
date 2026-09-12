-- Phase 26-MB: Profile contact details — phone + postal address
--
-- Purely additive. Seven nullable columns on `profiles`, no data backfill, no
-- change to any existing column, policy or trigger. Every existing profile
-- stays valid and reads back with `null` for all of them.
--
-- Scope note: this is the *user's own* contact address, not a listing address.
-- `locations` keeps its own address columns (Phase 2) and is untouched. No
-- latitude/longitude is added here — geospatial work belongs to Phase 26-N.

-- ============================================================================
-- Columns
--
-- Naming deliberately mirrors the vocabulary `public.locations` already
-- established (`address_line1/address_line2/city/region/country/postal_code`),
-- with an `address_` prefix on every part. The prefix is not decoration: a
-- bare `city` or `country` on a *profile* row reads as a general profile
-- attribute rather than part of one postal address, and the app already has a
-- separate "default city" preference concept that would collide with it.
--
-- Plain `text`, like every address column on `locations` — length limits are
-- enforced in the Zod layer (`users.schema.ts`), which is where this codebase
-- consistently puts them.
-- ============================================================================

alter table public.profiles
  add column phone text,
  add column address_line1 text,
  add column address_line2 text,
  add column address_city text,
  add column address_region text,
  add column address_country text,
  add column address_postal_code text;

comment on column public.profiles.phone is
  'The user''s own contact number, as they entered it. Deliberately NOT '
  'synchronised with auth.users.phone: that column is only populated by the '
  'phone-OTP sign-in flow, so it is absent for everyone who signed up with '
  'email, Apple or Google. This is the profile''s own field and is the only '
  'one /v1/me returns.';

comment on column public.profiles.address_line1 is
  'Street address. Part of the user''s own contact address — unrelated to a '
  'location''s address, which lives on public.locations.';

-- ============================================================================
-- Column-level UPDATE grant
--
-- This is the part that is easy to miss. Phase 1 deliberately granted UPDATE
-- on a *named column list* rather than the whole table:
--
--   grant update (first_name, last_name, avatar_url) on public.profiles to authenticated;
--
-- so that `profiles_update_own` (which is column-agnostic) still cannot be
-- used to change `status`, `id` or the timestamps. A new column is therefore
-- NOT writable by an authenticated user until it is added to that list —
-- PATCH /v1/me runs on the caller's own RLS-scoped client, so without this the
-- update would fail rather than silently succeed.
--
-- `status`, `id`, `created_at` and `updated_at` remain excluded, exactly as
-- before.
-- ============================================================================

grant update (
  phone,
  address_line1,
  address_line2,
  address_city,
  address_region,
  address_country,
  address_postal_code
) on public.profiles to authenticated;

-- ============================================================================
-- RLS
--
-- Intentionally unchanged. `profiles_select_own_or_admin` and
-- `profiles_update_own` are both column-agnostic (`id = auth.uid()`), so they
-- already cover these columns correctly: a user can read and write their own
-- contact details and nobody else's. No new policy is needed, and none is
-- added — widening a policy here would be a security regression for zero gain.
-- ============================================================================
