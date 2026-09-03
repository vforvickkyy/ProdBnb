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

Phase 2 shipped this with no write grant at all (there was no upload flow yet to produce a real
`storage_key`). Phase 3 adds the write path — see "Media storage" below.

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
- **`location_media` SELECT** — mirrors the parent location's visibility (unchanged since Phase
  2). **INSERT/UPDATE/DELETE** — added in Phase 3, same "owns the parent location, or admin"
  pattern as the join tables above — see "Media storage" below.

## Media storage (Phase 3): Cloudflare R2

**R2 stores the actual photo/video bytes. Postgres (`location_media`) stores only metadata and a
reference key — never binaries.** Supabase Auth remains the identity layer; the backend is the
only thing that ever holds R2 credentials or decides who's allowed to write where.

### Object-key strategy

`locations/{location_id}/{media_id}/original` — no file extension. The actual content type is
stored as the R2 object's own `Content-Type` (set at upload time via the presigned `PUT`), which
is how every S3-compatible store serves the right type on `GET` regardless of the key's shape.
Both `location_id` and `media_id` are UUIDs, so the key is inherently collision-free and never
derived from a client-supplied filename.

### Upload flow (`src/modules/media/`, `src/lib/r2.ts`)

1. `POST /v1/locations/:id/media/upload` — caller must own `:id` or be admin. Declares
   `media_type`/`content_type`/`size_bytes`; both are validated (content-type against a fixed
   per-media-type allowlist, size against `MEDIA_MAX_PHOTO_SIZE_MB`/`MEDIA_MAX_VIDEO_SIZE_MB`).
   The backend mints `media_id`, derives the key, and signs a `PutObjectCommand` with
   `ContentType`/`ContentLength` **pinned** — R2 will only accept a `PUT` whose actual headers
   match exactly, so a client can't upload a different type or a bigger file than what was
   authorized. Nothing is written to Postgres yet.
2. The client `PUT`s the raw bytes straight to the returned URL — the backend server never sees
   the file.
3. `POST /v1/locations/:id/media/:mediaId/complete` — same ownership check, then a `HeadObject`
   call asks R2 directly whether something now exists at that key (never trusts "the client says
   it uploaded"). `media_type` is derived from the *actual* stored content-type, size is
   re-checked, and only then is the `location_media` row inserted (`id = mediaId`, so the id the
   client already has becomes the row's real id).

No "pending upload" table exists between steps 1 and 3 — the key is fully deterministic from
`(location_id, media_id)`, and the only way real bytes can land at that exact key is through a
presigned `PUT` the backend only ever issues after verifying ownership, so there's nothing worth
persisting in between.

### Public access model

`GET /v1/locations/:id/media` and the location detail response both return a computed `url`
(`R2_PUBLIC_BASE_URL` + `storage_key`) — never the raw `storage_key`. The bucket itself is
public, keyed by unguessable UUIDs; **access control for draft/unpublished media is enforced by
never revealing the key through the API for a location the caller can't already see** (the
existing `location_media_select_via_location` RLS policy), not by R2 bucket permissions. This
was a deliberate choice over presigned, expiring `GET` URLs — a public marketplace gallery wants
stable, cacheable image URLs, and `R2_PUBLIC_BASE_URL` only makes sense for a public-bucket
setup. Worth knowing if the security model ever needs to be stricter: swapping to presigned
`GET`s is a change to `publicUrlFor()` alone, nothing about ownership/authorization changes.

### Deletion

`DELETE /v1/locations/:id/media/:mediaId` (owner or admin) deletes the R2 object first —
best-effort, logged but not fatal, since a transient R2 error shouldn't block a host from
removing something from their own listing — then the `location_media` row.

### Limits (configurable via env, see `.env.example`)

| | Default |
|---|---|
| Photo max size | 20 MB (`MEDIA_MAX_PHOTO_SIZE_MB`) |
| Video max size | 500 MB (`MEDIA_MAX_VIDEO_SIZE_MB`) |
| Presigned upload URL validity | 15 min (`R2_UPLOAD_URL_EXPIRY_SECONDS`) |

Allowed content types are a fixed constant in `src/modules/media/media.schema.ts`, not
env-configurable (a content-safety decision, not a numeric "limit"): `photo` → `image/jpeg,
image/png, image/webp`; `video` → `video/mp4, video/quicktime, video/webm`.

### Testing without real R2 credentials

`tests/media.test.ts` replaces `src/lib/r2.ts` wholesale with `vi.mock` — a small in-memory
object store standing in for R2, seeded by the test to simulate "a client actually uploaded"
before calling `/complete`. This exercises every bit of real business logic (ownership,
validation, the 404-vs-403 distinction, ordering) without needing a real bucket to run `npm
test`. Real end-to-end verification (an actual `PUT` to actual R2) needs real values in `.env`.

## Search & Discovery (Phase 4)

`GET /v1/locations` is backed entirely by PostgreSQL/PostGIS — no external search engine
(Elasticsearch/Algolia/etc.), no microservice. Everything lives in one function,
`public.search_locations(...)`, called via the anon client exactly like the rest of the public
API (`src/lib/supabase.ts` → `anonClient`).

### Why a SQL function instead of PostgREST filters

PostgREST's URL-filter syntax can express simple `column = value` filters, but not "match ALL of
these amenity ids," "order by a computed distance," or full-text ranking, all in one query. A
single `SECURITY INVOKER`, `STABLE` SQL function (same pattern as `has_role()`/
`get_host_public_profile()`) takes every filter as a typed, named parameter — never string
interpolation — builds one parameterized query internally, and returns compact rows plus a
`count(*) over()` window column for the total, in one round trip.

**Security note**: the function's `WHERE` clause hardcodes `status = 'published'` explicitly. It
doesn't rely on RLS alone to keep this safe, even though RLS would also filter it — a query that
originates from backend code should make its own intent explicit rather than assuming a
downstream policy will always be there to catch a mistake.

### Two generated columns, not separately-maintained duplicate data

```sql
search_vector tsvector generated always as (
  setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
  setweight(to_tsvector('english', coalesce(city, '')), 'B') ||
  setweight(to_tsvector('english', coalesce(description, '')), 'C')
) stored

location_point geography(Point, 4326) generated always as (
  case when latitude is not null and longitude is not null
    then ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography
  end
) stored
```

Both are `GENERATED ALWAYS ... STORED` — derived entirely from `title`/`description`/`city` and
`latitude`/`longitude`, recomputed automatically on every insert/update, so they can never drift
out of sync with the columns clients actually read and write. `latitude`/`longitude` stay the
simple, JSON-friendly representation every client already consumes; `location_point` exists
purely as an internal, indexable representation for `ST_DWithin`/`ST_Distance` — this is the
"clear reason" the general "don't duplicate lat/lng" rule (Phase 2) allows for.

`to_tsvector('english', text)` (the `regconfig`-qualified form) is `IMMUTABLE` and so valid in a
generated column; the plain `to_tsvector(text)` form depends on a runtime setting and is not.
Query-side text search uses `websearch_to_tsquery('english', ...)` — the variant designed for
raw user-typed queries (handles quoted phrases, `-exclude`, etc. sensibly) rather than requiring
tsquery's own operator syntax.

### PostGIS

`create extension if not exists postgis with schema extensions;` — installed into the dedicated
`extensions` schema, not `public`, matching the Supabase-recommended convention already reflected
in `supabase/config.toml`'s `extra_search_path = ["public", "extensions"]`. Verified directly
against the local stack (both migration application *and* an actual RPC call — PostGIS function/
type resolution inside a function body is the one place schema-qualification could subtly break)
before this was applied anywhere else.

### Filter semantics

- **Categories, use-cases**: match **any** of the given ids — `exists (select 1 from
  location_categories where location_id = l.id and category_id = any(_category_ids))`.
- **Amenities**: match **all** of the given ids — a location must hold every one, not just one:
  `(select count(distinct amenity_id) from location_amenities where location_id = l.id and
  amenity_id = any(_amenity_ids)) = cardinality(_amenity_ids)`. This is the standard "match every
  tag" SQL pattern, and matches both the prompt's own spec and the existing (mocked) iOS
  `SearchRepository`'s filter behavior.
- **Radius**: `ST_DWithin(location_point, ST_MakePoint(lng,lat)::geography, radius_km * 1000)` —
  independent of sorting; a client can supply `lat`/`lng` alone just to get `distance_km`
  annotated and sortable, without a hard radius cutoff.
- **Bounding box**: a plain `latitude between south and north and longitude between west and
  east` — all four corners required together; doesn't handle the antimeridian-crossing case
  (`west > east` is rejected, not interpreted as wrapping).

### Indexes

| Index | Backs |
|---|---|
| `locations_search_vector_idx` (GIN on `search_vector`) | `search=` |
| `locations_location_point_idx` (GiST on `location_point`) | `radius_km=`, bounding box, `sort=nearest` |
| `locations_status_created_at_idx` (btree on `status, created_at desc`) | every query (always filters `published`) combined with the default newest-first sort |

No new index for `city`/`region`/`country` exact-match filtering, and none for "primary media" —
the existing `(location_id, position)` index on `location_media` (Phase 2) already makes "first
media item for this location" a cheap index-scan lookup, exactly what `search_locations`'s
correlated subquery needs. Both are documented here as deliberate non-additions, not oversights —
candidates to revisit if `EXPLAIN ANALYZE` on real data ever shows a need, not built blindly now.

### Response shape

`search_locations` returns compact rows (`excerpt` instead of full `description`, no `host_id`,
no `status`) — `src/modules/search/search.service.ts` maps `primary_media_key` through the same
`publicUrlFor()` from `src/lib/r2.ts` that the media/location-detail code already uses, so URL
construction logic lives in exactly one place.

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
