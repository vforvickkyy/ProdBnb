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

## Row Level Security — Phase 1 (`profiles`, `user_roles`)

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

## Phase 2 schema

### `public.locations`

A production location listed by a `HOST`. "Property type" is deliberately **not** a column
here — it's expressed entirely through `categories` below (see "Why no `property_type`
column" further down).

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | `default gen_random_uuid()` |
| `host_id` | `uuid` | `references profiles(id) on delete cascade` |
| `title` | `text` | 1–200 chars |
| `description` | `text` | default `''`, ≤5000 chars |
| `address_line1`, `address_line2` | `text` | nullable |
| `city` | `text` | not null |
| `region` | `text` | state/region, nullable |
| `country` | `text` | not null — plain text, no country lookup table this phase |
| `postal_code` | `text` | nullable |
| `latitude`, `longitude` | `double precision` | nullable — a draft may be incomplete; range-checked when present |
| `capacity` | `integer` | nullable, `> 0` when present |
| `status` | `text` | see lifecycle below |
| `created_at`, `updated_at` | `timestamptz` | `updated_at` via the same `set_updated_at()` trigger Phase 1 created |

Indexed on `host_id`, `status`, `city`, `created_at`, and a plain btree on `(latitude,
longitude)` — real geospatial/PostGIS indexing is a Phase 4 (Search/Discovery) concern, not
this one.

### Listing lifecycle

`draft → submitted → under_review → approved → published`, with `rejected`, `suspended`, and
`archived` as off-ramps. **Only `published` is publicly discoverable** — `approved` means an
admin has greenlit it, `published` means it's actually live (a separate, deliberate step).

Status changes go through the same `PATCH /v1/locations/:id` as any other field. Rather than a
full workflow engine (explicitly a later concern), the allowed transitions are just:

- **Host**: `draft → submitted` (must already have `title`, `description`, `city`, `country`,
  `latitude`, `longitude` set — enforced in `locations.service.ts`, not a `NOT NULL` constraint,
  so drafts can stay incomplete), or `published → archived`. Any other requested status from a
  host is `403`.
- **Admin**: any of the 8 statuses, no restrictions — this is the review/moderation lever
  (`submitted → under_review → approved → published`, or `→ rejected`/`→ suspended` at any
  point) until a real admin workflow (Phase 11) exists.

### Why no `property_type` column

The prompt for this phase listed "location/property type" as a field to consider, but
separately mandated a normalized, multi-select `categories` system whose own example list
(Residential, Commercial, Outdoor, Studio, Office, Industrial, Event, Lifestyle, Other) is the
same concept — the same duplication the prompt explicitly warned against for categories vs.
use-cases. So a location's "type" is expressed entirely through its `categories`, which also
lets a location genuinely be more than one type (e.g. an industrial building converted into a
studio).

### `public.categories` / `public.amenities` / `public.use_cases`

Three identically-shaped lookup tables: `id uuid PK`, `name text unique not null`,
`created_at`. Seeded in the migration itself (not `supabase/seed.sql`, which only runs on local
`db reset` and would never reach the remote project):

- **categories**: Residential, Commercial, Outdoor, Studio, Office, Industrial, Event,
  Lifestyle, Other
- **amenities**: Parking, Power, Wi-Fi, Kitchen, Air Conditioning, Natural Light, Green Room,
  Restroom, Sound Control
- **use_cases**: Film, Advertising, Photography, Music Video, Editorial, Event, Other

Not exhaustive — just a starting set. **No RLS** on these three (every row is always visible to
everyone; a permissive `using (true)` policy would be pure boilerplate) — just `GRANT SELECT` to
`anon`/`authenticated`. No client-facing write path at all; adding a new option later is a
one-line `insert` with the service-role key, the same way granting `admin` works.

### `public.location_categories` / `location_amenities` / `location_use_cases`

Join tables, one per lookup table: composite PK `(location_id, <x>_id)`, both columns `on
delete cascade`, plus a reverse index on `<x>_id` (for "all locations with category X", which
Phase 4 will need).

### `public.location_media`

Metadata only — actual files live in Cloudflare R2 starting Phase 3.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `location_id` | `uuid` | `references locations(id) on delete cascade` |
| `media_type` | `text` | `check in ('photo','video')` |
| `storage_key` | `text` | future R2 object key — not a URL, no R2 logic exists yet |
| `position` | `integer` | display order, default `0` |
| `metadata` | `jsonb` | optional (width/height/duration/alt-text later) |
| `created_at`, `updated_at` | `timestamptz` | |

No write endpoint exists yet, and no write grant to `authenticated`/`anon` either — there's no
upload flow to produce a real `storage_key`, so there's nothing for a write endpoint to do until
Phase 3 adds both the grant and the "register this uploaded object" endpoint together.

### `get_host_public_profile()`

A public listing page needs to show *something* about its host (name, avatar) without exposing
the rest of that host's `profiles` row — which stays `authenticated`-only, own-row-or-admin,
unchanged from Phase 1. Rather than loosening that policy, this is a narrow `SECURITY DEFINER`
function (same pattern as `has_role()`) that returns just `id, first_name, last_name,
avatar_url`, and only for a host who has at least one `published` location. Used only by
`GET /v1/locations/:id`.

## Row Level Security — Phase 2 (`locations` and related tables)

RLS is enabled on every Phase 2 table except the three lookup tables above.
Table-level `GRANT`s are explicit everywhere, for every role including `service_role` — Supabase's
current default does not auto-expose a newly created table to *any* Data API role, RLS or not,
and that includes `service_role` (bypassing RLS is not the same as holding a base `GRANT`). This
was discovered the hard way while verifying Phase 1 against a real local stack, and every Phase 2
table's migration statements include the grants from the start.

- **`locations` SELECT** — `status = 'published'`, or the caller owns it (`host_id =
  auth.uid()`), or the caller is admin. To `anon` and `authenticated`.
- **`locations` INSERT** — only a caller holding the `host` role, and only for themself
  (`host_id = auth.uid() and has_role(auth.uid(),'host')`).
- **`locations` UPDATE/DELETE** — owner or admin. The app layer additionally excludes `host_id`
  from the update schema entirely (same defense-in-depth idiom as Phase 1 excluding `status`
  from the profile update schema) and enforces the status-transition rule above — RLS alone
  doesn't know about the transition allow-list.
- **`location_categories`/`location_amenities`/`location_use_cases` SELECT** — mirrors the
  parent location's own visibility. **INSERT/DELETE** — requires owning the parent location (or
  admin); no separate role check needed, since ownership already implies the row's creator was
  a host.
- **`location_media` SELECT** — mirrors the parent location's visibility. No INSERT/UPDATE/DELETE
  grant to `authenticated`/`anon` at all this phase (see above).

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
