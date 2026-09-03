# Database

Postgres, managed entirely through Supabase CLI migrations. **Never modify the schema by hand
in the Supabase dashboard** — every change must be a versioned file in `supabase/migrations/`.

## Migration workflow

```bash
# Create a new, empty, timestamped migration file
supabase migration new <short_description>

# Start the local Postgres/Auth/Studio stack (requires Docker running)
supabase start

# Apply any pending migrations to the local stack
supabase migration up

# Check what's applied locally vs. pending
supabase migration list

# Reset the local database (drops and recreates it, re-runs every migration
# from scratch, then re-runs supabase/seed.sql if present) — local only, safe
# to run as often as you like, has no effect on the remote project
supabase db reset

# When ready to ship a reviewed migration to the real "ProdBnb" project:
supabase db push
```

`supabase db push` writes directly to the shared, live project — always verify the migration
against the local stack first (`supabase db reset` should succeed cleanly from empty), and treat
`db push` as a deliberate, explicit step, not something run reflexively.

The project is already linked to the "ProdBnb" Supabase project (`supabase link` was run once
for this repo). Re-run `supabase link --project-ref <ref>` only if the link is ever lost.

## Phase 1 schema

### `public.profiles`

Application-level profile for a Supabase Auth user. **`id` is the same UUID as
`auth.users.id`** — a 1:1 relationship, not a separate internal identifier. This is the standard
Supabase pattern: it keeps "internal profile ID" and "Supabase auth user ID" as one stable value
instead of introducing a second ID to keep in sync.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | `references auth.users(id) on delete cascade` |
| `first_name` | `text` | nullable |
| `last_name` | `text` | nullable |
| `avatar_url` | `text` | nullable — a URL, not the image itself (R2 upload lands in Phase 3) |
| `status` | `text` | `active` \| `suspended` \| `deleted`, default `active` |
| `created_at` | `timestamptz` | default `now()` |
| `updated_at` | `timestamptz` | auto-maintained by trigger |

Deliberately **excludes** authentication credentials (those stay in `auth.users`, owned by
Supabase Auth) and richer profile fields (`phone`, `bio`, `production_name`, a job-title-style
"production role", `default_city`) that the iOS app's `UserProfile` model has — those belong to
a future profile-enrichment pass, not the Phase 1 foundation. Adding them later is a plain
`ALTER TABLE ... ADD COLUMN` migration; no breaking change to existing consumers.

A row is created automatically the moment a new `auth.users` row appears (trigger
`on_auth_user_created` → `handle_new_user()`), so there's no race between a client's first
request and profile creation, and no endpoint has to "lazily create" a profile.

### `public.user_roles`

The marketplace role model. **A user can hold multiple roles at once** — this table is the
reason: one row per `(user, role)` pair, not a single column on `profiles`.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | `default gen_random_uuid()` |
| `user_id` | `uuid` | `references profiles(id) on delete cascade` |
| `role` | `text` | `check (role in ('booker','host','admin'))` |
| `created_at` | `timestamptz` | default `now()` |
| | | `unique (user_id, role)` |

A plain `text` + `CHECK` constraint was used instead of a Postgres `enum` type — adding a new
allowed role later (e.g. a Phase-11 admin sub-role) is an ordinary constraint migration, not the
`ALTER TYPE ... ADD VALUE` ceremony enums require.

**No role is auto-granted at signup.** `booker`/`host` are self-service
(`POST /v1/me/roles`); `admin` cannot be granted through any API — see "Granting the admin role"
below.

## Row Level Security

RLS is enabled on both tables. The backend deliberately does most of its data access through a
**request-scoped client carrying the caller's own JWT** (`src/lib/supabase.ts`), not the
service-role key — so these policies are the actual enforcement point, and a bug in the Express
layer can't silently return another user's data.

- **`profiles` SELECT** — a user sees their own row, or every row if they hold the `admin` role.
- **`profiles` UPDATE** — a user may update only their own row, and — via Postgres
  **column-level grants**, not just the row policy — only the `first_name`, `last_name`, and
  `avatar_url` columns. `status`, `id`, and the timestamps are never grantable to `authenticated`,
  so even a permissive row policy can't be used to self-escalate account status.
- **`profiles` INSERT/DELETE** — no policy for regular users. Rows are created only by the
  `SECURITY DEFINER` trigger; deletion cascades from `auth.users`.
- **`user_roles` SELECT** — a user sees their own role rows, or every row if they're an admin.
- **`user_roles` INSERT** — a user may insert a row for themself only with `role in
  ('booker','host')`; an admin may insert any role for any user.
- **`user_roles` DELETE** — a user may delete their own `booker`/`host` rows; an admin may
  delete any row.

### `has_role()` and the RLS recursion problem

A policy on `user_roles` that queries `user_roles` to check "is this caller an admin" would
recurse into itself. `public.has_role(_user_id uuid, _role text)` is a `SECURITY DEFINER`
function — it runs with the privileges of its owner, bypassing RLS *inside its own body*, so
policies can call it safely. This is the pattern Supabase's own RLS documentation recommends for
role checks; it's used by every policy above that needs to ask "is the caller an admin."

## Granting the admin role

There's no endpoint for this — deliberately. `admin` is powerful enough that granting it should
require direct database access with the service-role key, not a request any authenticated user
could send. To grant it (local stack or the linked project, using the `service_role` key):

```sql
insert into public.user_roles (user_id, role)
values ('<auth-user-uuid>', 'admin');
```

Or via the Supabase JS admin client with the service-role key:

```ts
await adminClient.from("user_roles").insert({ user_id: "<auth-user-uuid>", role: "admin" });
```
