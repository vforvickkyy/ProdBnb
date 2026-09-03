-- Phase 1: Core Foundation, Authentication, Users & Roles
--
-- Creates the application-level user profile (linked 1:1 to auth.users) and a
-- normalized multi-role model (booker / host / admin). Supabase Auth remains the
-- single authentication authority; nothing here duplicates auth credentials.

-- ============================================================================
-- profiles
-- ============================================================================

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  first_name text,
  last_name text,
  avatar_url text,
  status text not null default 'active'
    check (status in ('active', 'suspended', 'deleted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is
  'Application-level profile for a Supabase Auth user. id = auth.users.id (1:1). '
  'Auth credentials stay in auth.users; only display/account-state data lives here.';

-- ============================================================================
-- user_roles
-- ============================================================================

create table public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  role text not null check (role in ('booker', 'host', 'admin')),
  created_at timestamptz not null default now(),
  unique (user_id, role)
);

comment on table public.user_roles is
  'Marketplace roles held by a user. One row per (user, role) — a user can hold '
  'multiple roles at once (e.g. both booker and host).';

create index user_roles_user_id_idx on public.user_roles (user_id);

-- ============================================================================
-- updated_at trigger
-- ============================================================================

create function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger set_profiles_updated_at
  before update on public.profiles
  for each row
  execute function public.set_updated_at();

-- ============================================================================
-- has_role() — SECURITY DEFINER helper for RLS policies
--
-- Policies on user_roles cannot query user_roles directly without recursing.
-- This function runs with the privileges of its owner (bypassing RLS on the
-- table it queries internally) so policies can safely call it. This is the
-- pattern documented by Supabase for role-checking in RLS.
-- ============================================================================

create function public.has_role(_user_id uuid, _role text)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.user_roles
    where user_id = _user_id
      and role = _role
  );
$$;

-- ============================================================================
-- handle_new_user() — auto-create a profile row for every new auth.users row
-- ============================================================================

create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, first_name, last_name)
  values (
    new.id,
    new.raw_user_meta_data ->> 'first_name',
    new.raw_user_meta_data ->> 'last_name'
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();

-- ============================================================================
-- Row Level Security
-- ============================================================================

alter table public.profiles enable row level security;
alter table public.user_roles enable row level security;

-- Supabase's current default does NOT auto-expose newly created tables to any
-- Data API role — table-level grants must be explicit, even though RLS is
-- also enabled, and even for service_role (bypassing RLS is not the same as
-- holding a base GRANT). RLS controls which ROWS a query can see; these
-- grants control whether the role can query the table at all. Only
-- `authenticated` and `service_role` get anything here — there is no
-- anonymous-readable data in this schema.
grant select on public.profiles to authenticated;
grant select, insert, update, delete on public.profiles to service_role;
grant select, insert, delete on public.user_roles to authenticated;
grant select, insert, update, delete on public.user_roles to service_role;
grant execute on function public.has_role(uuid, text) to authenticated, service_role;

-- profiles: users read their own row; admins read every row.
create policy "profiles_select_own_or_admin"
  on public.profiles
  for select
  to authenticated
  using (id = auth.uid() or public.has_role(auth.uid(), 'admin'));

-- profiles: users update their own row. Combined with the column-level grants
-- below, this cannot be used to change status/id/timestamps.
create policy "profiles_update_own"
  on public.profiles
  for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- No INSERT/DELETE policy for regular users: rows are created only by the
-- SECURITY DEFINER trigger above, and deletion cascades from auth.users.

-- Column-level privileges: even though the UPDATE policy grants row access,
-- only these columns are writable by authenticated users. status/id/timestamps
-- are excluded, so profile updates can never self-escalate account status.
revoke update on public.profiles from authenticated;
grant update (first_name, last_name, avatar_url) on public.profiles to authenticated;

-- user_roles: users read their own roles; admins read every row.
create policy "user_roles_select_own_or_admin"
  on public.user_roles
  for select
  to authenticated
  using (user_id = auth.uid() or public.has_role(auth.uid(), 'admin'));

-- user_roles: users may self-assign booker/host only. Admins may assign any
-- role to any user (including admin — granting admin is still only possible
-- for a caller who already holds admin).
create policy "user_roles_insert_self_or_admin"
  on public.user_roles
  for insert
  to authenticated
  with check (
    (user_id = auth.uid() and role in ('booker', 'host'))
    or public.has_role(auth.uid(), 'admin')
  );

-- user_roles: users may remove their own non-admin roles; admins may remove any.
create policy "user_roles_delete_own_or_admin"
  on public.user_roles
  for delete
  to authenticated
  using (
    (user_id = auth.uid() and role in ('booker', 'host'))
    or public.has_role(auth.uid(), 'admin')
  );
