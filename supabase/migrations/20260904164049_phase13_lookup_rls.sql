-- Phase 13: enable RLS on the three Phase 2 lookup tables (categories,
-- amenities, use_cases). Purely additive, defense-in-depth.
--
-- These tables already had no client-facing write grant at all -- only
-- service_role has ever had insert/update/delete on them (Phase 2:
-- `grant select, insert, update, delete on public.categories to
-- service_role`, `grant select on public.categories to anon,
-- authenticated`, and identically for amenities/use_cases). So this closes
-- a gap in the SECOND layer of protection, not an active vulnerability:
-- without RLS, a future accidental `grant insert/update/delete ... to
-- authenticated` on any of these three tables would have had nothing else
-- to stop it. With RLS enabled and no write policy defined for
-- anon/authenticated, that same accident is still blocked by RLS with zero
-- further action needed -- exactly the property Phase 12 already relies on
-- everywhere else in this schema (see e.g. payments/payment_refunds having
-- no client grant AND RLS enabled, belt and suspenders).
--
-- The SELECT policy is `using (true)` -- deliberately identical in effect
-- to having no RLS at all for reads, since these are meant to be a fully
-- public taxonomy (Phase 2's own original comment: "every row is always
-- visible to everyone"). No existing grant is touched by this migration.
-- Confirmed unaffected: catalog.controller.ts (GET /v1/categories,
-- /v1/amenities, /v1/use-cases) reads through anonClient; location detail
-- responses read the join shape `location_categories ( categories (id,
-- name) )` etc. through the caller's own scoped client -- both continue to
-- see every row, unchanged, since `using (true)` permits exactly what an
-- absent RLS policy already permitted.

alter table public.categories enable row level security;
alter table public.amenities enable row level security;
alter table public.use_cases enable row level security;

create policy "categories_select_all"
  on public.categories
  for select
  to anon, authenticated
  using (true);

create policy "amenities_select_all"
  on public.amenities
  for select
  to anon, authenticated
  using (true);

create policy "use_cases_select_all"
  on public.use_cases
  for select
  to anon, authenticated
  using (true);

-- Deliberately no insert/update/delete policy for anon/authenticated on any
-- of the three -- matches the existing grants exactly (service_role only,
-- unchanged from Phase 2). RLS now backs that up structurally, not just via
-- the grant layer.
