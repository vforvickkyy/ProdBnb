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

> **Phase 26-MB — contact details.** The seven `phone`/`address_*` columns are the *user's own*
> contact address, deliberately namespaced with an `address_` prefix: a bare `city` on a profile
> row would read as a general attribute rather than one part of a postal address, and would collide
> with the app's separate "default city" preference. The vocabulary otherwise mirrors
> `public.locations` (`line1/line2/city/region/country/postal_code`). No latitude/longitude is
> stored for a user address — geospatial work belongs to a later phase.
>
> They are writable by their owner because the Phase 26-MB migration adds them to the
> **column-level UPDATE grant**. That grant, not RLS alone, is what keeps `status`, `id` and the
> timestamps read-only for a normal user — see the grant note below.


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
| `phone` | `text` | nullable — Phase 26-MB. The user's own contact number. **Not** synchronised with `auth.users.phone`, which only the phone-OTP flow populates |
| `address_line1` | `text` | nullable — Phase 26-MB |
| `address_line2` | `text` | nullable — Phase 26-MB |
| `address_city` | `text` | nullable — Phase 26-MB |
| `address_region` | `text` | nullable — Phase 26-MB |
| `address_country` | `text` | nullable — Phase 26-MB |
| `address_postal_code` | `text` | nullable — Phase 26-MB |
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
- **`locations` UPDATE/DELETE** — owner or admin. **As of Phase 12**, `authenticated`'s column
  grant on `UPDATE` (and `INSERT`) excludes `status`/`moderation_reason`/
  `suspended_by_host_suspension`/`host_id` entirely — a raw PostgREST call can no longer move
  status regardless of ownership; only the service-role-backed code paths in
  `locations.service.ts`/`admin/locations.service.ts` can. See "RLS/grant hardening (Phase 12)"
  below for why and what changed.
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

## Availability & Calendar (Phase 5)

**Availability is not booking.** Nothing in this phase reserves a slot — it answers "is this
location available at this time?" via a weekly schedule, date-specific overrides, and blocked
periods. Phase 6 (below) adds bookings as one more subtraction step on top of this same engine.

### Timezone

`locations.timezone text not null default 'UTC'` — every wall-clock time in a weekly rule or
override (`09:00`, say) is meaningless without a zone to interpret it against, so this column is
foundational to everything else in this section. It's a real IANA identifier (`Asia/Kolkata`,
`America/Los_Angeles`), never an abbreviation like `IST`/`PST` — abbreviations aren't
unambiguous (multiple zones share `IST`) and don't carry DST rules. Validated at the
**application layer** (`ianaTimezoneSchema` in `locations.schema.ts`, using
`Intl.DateTimeFormat`, which throws on anything that isn't a real identifier) rather than a
database `CHECK` — Postgres `CHECK` constraints can't contain subqueries, so validating against
the `pg_timezone_names` catalog view isn't possible there without a trigger, which is more moving
parts for the same guarantee `Intl` already gives.

DST correctness comes for free from Postgres's own `AT TIME ZONE` operator (used throughout the
functions below), which consults the server's IANA tzdata — there's no manual UTC-offset
arithmetic anywhere in this design.

### Schema

**`public.location_availability_rules`** — weekly recurring windows, in wall-clock time relative
to the location's own timezone.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `location_id` | `uuid` | FK, cascade |
| `day_of_week` | `text` | `check in ('sunday'..'saturday')` — text, matching every other enum-shaped column in this schema (`status`, `role`, `media_type`), not an integer |
| `start_time`, `end_time` | `time` | `check (end_time > start_time)` — half-open `[start, end)`, and this also means **overnight windows (e.g. `22:00–02:00`) are rejected outright**, a deliberate simplification (see below) |
| | | `exclude using gist (location_id with =, day_of_week with =, int4range(...) with &&)` — see "Overlap prevention" |

**`public.location_availability_overrides`** — date-specific, and **replaces** the day's base
schedule entirely rather than merging with it (an `unavailable` override on a normally-open
Monday leaves *zero* windows, not "the normal hours minus nothing").

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `location_id` | `uuid` | FK, cascade |
| `date` | `date` | immutable after creation — delete and recreate to move one |
| `status` | `text` | `check in ('available','unavailable')` |
| `start_time`, `end_time` | `time`, nullable | **required together** when `status='available'` (opening a normally-closed day must say what hours — there's no "same as normal" shorthand, which would be ambiguous on a day with no base rule at all); **both null** when `status='unavailable'` (always a full-day closure, no partial-unavailable form) |
| | | `unique (location_id, date)` — one override per date, so there's no overlap concept to prevent here beyond that |

**`public.location_blocked_periods`** — arbitrary `timestamptz` ranges (unlike rules/overrides, a
block can span multiple calendar days), for maintenance/private-use/etc.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `location_id` | `uuid` | FK, cascade |
| `start_at`, `end_at` | `timestamptz` | absolute instants; `check (end_at > start_at)` |
| `reason` | `text`, nullable | **private** — see RLS below |
| `created_by` | `uuid` | `references profiles(id)` |
| | | `exclude using gist (location_id with =, tstzrange(start_at, end_at, '[)') with &&)` |

No indexes beyond what these constraints already create — the exclusion constraints' `GiST`
indexes and the overrides' unique-constraint `btree` index already cover every query pattern this
phase needs (location_id lookups, date/range overlap). A deliberate non-addition, same reasoning
Phase 4 used to justify *not* adding a primary-media index.

### Overlap prevention: real `EXCLUDE` constraints, not "check then insert"

Per the design brief: application-level pre-checks alone can race under concurrent requests.
Both `location_availability_rules` and `location_blocked_periods` use Postgres `EXCLUDE USING
gist` constraints — the same double-booking-prevention technique Phase 6's `bookings` table
reuses below, with a `WHERE` clause added since only some booking statuses reserve the interval.
Both need the `btree_gist` extension (installed alongside `postgis`, in the
`extensions` schema) — a `GiST` exclusion constraint that mixes a plain equality column
(`location_id`, `day_of_week`) with a range column needs it. `time` has no native Postgres range
type, so the rules constraint expresses each window as `int4range(seconds-since-midnight,
seconds-since-midnight, '[)')` — still exact, still half-open, just measured in seconds instead
of a native time range. A conflicting insert raises Postgres error code `23P01`
(`exclusion_violation`), mapped to a `409 CONFLICT` in `rules.service.ts`/`blocks.service.ts`,
the same error-code-mapping idiom `23505`/`23503` already use elsewhere.

### Overnight (cross-midnight) windows: rejected, not supported

`22:00–02:00` is rejected by the plain `end_time > start_time` check. A window that isn't fully
contained within one calendar day breaks the per-day computation loop and the half-open-interval
reasoning used everywhere else here cleanly — this is a documented limitation, not a silent gap,
and can be revisited later without touching anything else in this design.

### `get_location_availability()` — the computed query

`language plpgsql`, unlike Phase 4's `search_locations` (`language sql`) — the day-by-day
loop and override-or-base-schedule branching map more naturally to procedural code than one
query. **`SECURITY DEFINER`, not `INVOKER`** (the opposite of `search_locations`) — the one
security-relevant decision in this phase worth explaining carefully:

This function must read `location_blocked_periods` to correctly subtract blocked time from the
computed windows. But `location_blocked_periods.reason` is private, so that table's `SELECT`
policy is owner-or-admin only (see RLS below) — a plain `SECURITY INVOKER` function called
anonymously simply couldn't see any blocks, and would report availability that's *too generous*
to the public (never subtracting anything it can't see). `SECURITY DEFINER` — `set search_path =
public`, fully schema-qualified body, matching `get_host_public_profile()`'s existing pattern —
lets it read block *times* internally regardless of the caller, while its `RETURNS TABLE` shape
(`date, start_at, end_at`) structurally cannot include `reason`; it was never selected. Before
returning anything at all, it re-derives the location's own visibility itself:

```sql
where l.id = _location_id
  and (l.status = 'published' or l.host_id = auth.uid() or public.has_role(auth.uid(), 'admin'))
```

— exactly the same three-way check the `locations` RLS policies themselves use — so it's safe to
`GRANT EXECUTE` to `anon, authenticated` directly.

**Algorithm**, per requested date: if an override exists, use it exclusively (available → its
own window; unavailable → none); otherwise use every weekly rule matching that date's
day-of-week. Convert each resulting wall-clock window to a `tstzrange` via `(date + time) at
time zone location.timezone`. Subtract every overlapping `location_blocked_periods` range using
Postgres's native `tstzmultirange` subtraction (`multirange - multirange`; note both operands
must be multiranges — `multirange - range` isn't a defined operator, so a lone `tstzrange` is
first wrapped with `tstzmultirange(...)`). Emit whatever ranges remain.

The date-range itself is capped at 90 days, both as a `zod` `.refine()` at the application layer
and, defensively, inside the function itself (`raise exception` if exceeded) — the same
belt-and-suspenders pattern `least(_page_size, 100)` uses in `search_locations`.

### RLS

- `location_availability_rules` / `location_availability_overrides`: **`SELECT`** mirrors the
  parent location's own visibility (published, or owner, or admin) — identical shape to
  `location_categories_select_via_location`. **`INSERT`/`UPDATE`/`DELETE`**: owner or admin,
  identical shape to `location_categories_write_via_location_owner`. Nothing sensitive lives in
  either table — a marketplace's general operating hours are ordinary public information.
- `location_blocked_periods`: **`SELECT` restricted to owner-or-admin only — never mirrors
  published visibility**, the one departure from the join-table RLS shape used everywhere else
  in this schema, specifically because of `reason`. This matters because PostgREST is directly
  reachable by anyone holding the public anon key, entirely bypassing the Express app — if this
  table's `SELECT` policy mirrored location visibility the way the others do, `reason` would be
  one raw REST call away regardless of what the Express layer chooses to expose. `anon` gets no
  grant on this table at all.
- Every new table gets explicit `GRANT`s for `authenticated` and `service_role` from the start —
  the Phase 1 lesson, applied on day one this time.

## Booking Engine + Pricing Foundation (Phase 6, extended by Phase 6A)

**The critical requirement**: two users requesting the same location and overlapping interval at
nearly the same instant must never both end up with an active booking. This is guaranteed by a
Postgres constraint, not by application code checking first and inserting second — a "check then
insert" is inherently racy under concurrency, since two concurrent requests can both pass the
check before either one inserts.

### `bookings`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `location_id` | `uuid` | `references locations(id)` — **no `on delete cascade`**, unlike every other FK to `locations` in this schema (see below) |
| `booker_id` | `uuid` | `references profiles(id) on delete cascade` |
| `booking_type` | `text` | `check in ('hourly','half_day','day','multi_day')` — **Phase 6A**, immutable after creation (no endpoint ever updates it); every pre-Phase-6A row was backfilled to `'hourly'` |
| `start_at`, `end_at` | `timestamptz` | absolute instants; `check (end_at > start_at)` — the one interval every booking type ultimately resolves to, see "Booking types" below |
| `status` | `text` | `check in ('requested','confirmed','cancelled','completed','rejected')`, default `'requested'` |
| `base_amount_minor_units` | `integer` | the price snapshot — see "Pricing" below |
| `platform_fee_minor_units`, `tax_minor_units`, `discount_minor_units` | `integer`, default `0` | unused this phase (always `0`), structurally ready for Phase 7 |
| `total_amount_minor_units` | `integer` | `check (= base + platform_fee + tax - discount)` |
| `currency` | `text` | copied from the location *at booking time* — a snapshot, not a live reference |
| `cancelled_at`, `cancelled_by`, `cancellation_reason` | nullable | set only by the cancel action |

### Double-booking prevention: a partial `EXCLUDE` constraint

```sql
exclude using gist (
  location_id with =,
  tstzrange(start_at, end_at, '[)') with &&
) where (status in ('requested', 'confirmed'))
```

The same `EXCLUDE USING gist` technique Phase 5 established for
`location_availability_rules`/`location_blocked_periods`, reusing the same `btree_gist`
extension already installed. The `WHERE` clause is what makes it a *partial* exclusion
constraint — only `requested`/`confirmed` rows participate, so a `cancelled`/`rejected` booking's
old interval becomes instantly reusable the moment its status changes (no row deletion needed,
full booking history preserved). **Verified directly against the local stack with two genuinely
concurrent raw inserts** for the identical interval before this was ever wired into Express: one
returned `201`, the other failed with Postgres error code `23P01`
(`exclusion_violation`) — mapped to `409 CONFLICT` in `bookings.service.ts`.

**Why `requested` reserves the slot, not just `confirmed`**: if only `confirmed` bookings
blocked the interval, two different bookers could both successfully *request* the same
overlapping time, leaving the host to arbitrarily resolve a conflict that should never have been
possible to create. Requesting already holds the slot; a host's `confirm`/`reject` decides
whether that hold becomes permanent or releases.

### `is_interval_available()` — the pre-check, not the guarantee

`POST /v1/bookings` calls `is_interval_available(location_id, start_at, end_at)` *before*
attempting the insert, purely to produce a clean `400` ("not available") instead of always
racing to find out via a `409`. It is not what makes double-booking impossible — the exclusion
constraint above is authoritative regardless of what this function decides, and stays correct
even if this pre-check were deleted entirely.

It reuses `get_location_availability()` rather than re-deriving schedule logic, composed
differently depending on the request shape:

- **Same calendar day**: `start_at` and `end_at` must fall within the *same* returned window
  (strict containment) — without this, a request from `11:00` to `15:00` against windows
  `09:00–12:00` and `14:00–18:00` would wrongly pass a looser "start in some window, end in some
  window" check despite the `12:00–14:00` gap sitting in the middle.
- **Multi-day ("continuous custody" model)**: check-in (`start_at`) must fall within an available
  window on its calendar day; check-out (`end_at`) must fall within an available window on *its*
  calendar day; and a separate helper, `has_conflicting_period()`, checks the *entire* span for
  any overlapping blocked period or other active booking, independent of day boundaries (the
  day-by-day windowing alone can't see a conflict sitting on a day in the middle of a multi-day
  request). Intermediate days impose no operating-hours requirement of their own — once checked
  in, the booker has continuous exclusive use through checkout. This is a deliberate design
  choice, not an obvious reading of the product spec: Phase 5's `time`-typed weekly rules can't
  express "open through midnight," so requiring every intermediate day to match a full 24-hour
  window is a dead end without reworking Phase 5's schema entirely.

`has_conflicting_period()` is `SECURITY DEFINER` (needs to read block times regardless of the
caller, the same reasoning `get_location_availability()` already established) but is **not**
granted `EXECUTE` directly to `anon`/`authenticated` — it's only ever called from within
`is_interval_available()`'s own body, never invoked as a public RPC on its own.

### `get_location_availability()` — one more subtraction step

Extended (via `CREATE OR REPLACE`, same function, same signature, same `(date, start_at,
end_at)` return shape) to also subtract `bookings` with `status in ('requested','confirmed')`,
using the identical per-day overlap-filter and `tstzmultirange` subtraction the blocked-periods
loop already used. This is what makes `GET /v1/locations/:id/availability` correctly stop
showing booked time with no change to its API contract, and it never leaks booker identity or
pricing — the return shape is still just three columns.

### Booking types & pricing (Phase 6A)

Phase 6 shipped one implicit pricing model: a single hourly rate on `locations`, `total =
round(rate * elapsed_hours)`. That's wrong for a production-location marketplace, where a shoot
is more often booked as a half-day, a full day, or several consecutive days at a flat rate than
as raw hours. Phase 6A replaces it with four distinct booking types that all still resolve to the
one thing the exclusion constraint above has always protected atomically: a `[start_at, end_at)`
interval. **Nothing about the exclusion constraint, `get_location_availability()`, or
`is_interval_available()` changed for this** — Phase 6A is entirely about what happens *before*
those are called.

#### `public.location_pricing`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `location_id` | `uuid` | `references locations(id) on delete cascade` |
| `booking_type` | `text` | `check in ('hourly','half_day','day','multi_day')` |
| `amount_minor_units` | `integer` | `check (>= 0)` — the per-hour rate for `hourly`, the flat rate for `half_day`/`day`, the per-day rate for `multi_day` |
| `currency` | `text` | same `^[A-Z]{3}$` check as everywhere else, default `'INR'`, per-row (not inherited from a single location-level currency) |
| `half_day_duration_hours` | `integer`, nullable | only meaningful — and required — when `booking_type = 'half_day'`; `check` enforces both directions (must be set for `half_day`, must be null otherwise), `between 1 and 23` |
| `is_active` | `boolean not null default true` | toggled off rather than deleted, so a rate can be re-enabled without losing history |
| `created_at`, `updated_at` | `timestamptz` | existing `set_updated_at()` trigger |
| | | `unique (location_id, booking_type)` — one active-or-inactive row per type per location, so there's never a "which rate wins" ambiguity |

A location doesn't need every type configured. An unconfigured or deactivated type simply can't
be booked (`400 VALIDATION_ERROR`, not `404` — the location itself is real and visible, that one
booking type just isn't offered there).

`locations.base_price_minor_units`/`currency` (Phase 6) still exist as columns — dropping them
would be destructive for no benefit — but the application layer stopped reading and writing them
entirely after Phase 6A shipped; `location_pricing` is the sole pricing source. The Phase 6A
migration backfills a `location_pricing` row (`booking_type = 'hourly'`) from any location that
had a non-null `base_price_minor_units`, so an already-bookable listing doesn't go dark.

#### The four booking types and how each resolves to an interval

Each type has its own request shape (`POST /v1/bookings`, a `zod` discriminated union on
`booking_type`) — not one generic `{start_at, end_at}` forced onto every type. Interval
resolution happens once, in `resolveInterval()` (`bookings.service.ts`), before the unmodified
Phase 6 `is_interval_available()` check ever runs:

- **`hourly`** — `{ start_at, end_at }`, unchanged from Phase 6. Price:
  `round(amount_minor_units * elapsed_hours)`.
- **`half_day`** — `{ start_at }` only. `end_at = start_at + location_pricing.half_day_duration_hours`
  (host-configured per location, e.g. `4`) — not a fixed universal duration, and not yet a named
  `MORNING`/`AFTERNOON` window system (a clean, isolated later extension to this same column, not
  a reason to build a second booking engine now). Price is the flat configured `amount_minor_units`,
  no multiplication — the price *is* the price for that unit.
- **`day`** — `{ date }` only, no times. The reserved interval is derived from the location's
  *actual* availability that date via `get_location_availability(location_id, date, date)` — the
  earliest window's start to the latest window's end — never a naive 24-hour assumption. If that
  date's schedule has a gap (e.g. `09:00–12:00` and `14:00–18:00`), the derived span
  (`09:00–18:00`) fails the existing same-day *strict single-window containment* check in
  `is_interval_available()`, so a `day` booking is correctly rejected on a day the location isn't
  actually open continuously. Price is the flat configured `amount_minor_units`.
- **`multi_day`** — `{ start_date, end_date }`, no times. Check-in day contributes its earliest
  window's start, check-out day contributes its latest window's end (each via the same
  availability-derivation `day` uses), and the combined interval is validated by the exact same
  multi-day "continuous custody" path `is_interval_available()` already implements for Phase 6 —
  intermediate days impose no operating-hours requirement of their own, unchanged. Price:
  `amount_minor_units * day_count`, where `day_count` is the inclusive number of calendar days
  between `start_date` and `end_date` in the location's own timezone (e.g. ₹15,000/day × 3 days =
  ₹45,000).

No new availability logic exists anywhere for this — `day`/`multi_day` derivation is a thin
reuse of `get_location_availability()`, and all four types share the identical
`is_interval_available()` pre-check and the identical `EXCLUDE` constraint downstream, which is
completely unaware of `booking_type`. This is also why cross-type conflicts work automatically:
an `hourly` request overlapping an existing `half_day` booking (or any other type pair) is
rejected the same way a same-type overlap always was — the constraint only ever sees an interval.

**Backward compatibility**: a request that omits `booking_type` entirely is treated as `hourly`
with `{location_id, start_at, end_at}` — the exact original Phase 6 shape, byte-for-byte. An
existing client that hasn't picked up the new field yet keeps working unmodified.

#### Centralized pricing calculation

`calculateBookingPrice()` (`src/modules/bookings/pricing.ts`) is the single place any booking
amount is computed — `bookings.service.ts` never contains a pricing formula itself. It looks up
the one active `location_pricing` row for `(location_id, booking_type)` — throwing a `400` if
none exists — then applies exactly one of the four formulas above. No taxes/fees/discounts are
computed yet; the existing Phase 6 snapshot columns for them stay `0`, structurally ready for
Phase 7.

**Currency**: `text`, `check (currency ~ '^[A-Z]{3}$')` — an ISO-4217 *shape*, not a fixed
allowlist of specific currencies, so supporting a new one is never a migration. Defaults to
`'INR'`. **Minor units** (e.g. paise), never floating point — avoids all floating-point rounding
error by construction, and matches how real payment processors (Stripe, Razorpay) represent
amounts, which will matter once Phase 7 has to hand this number to one.

#### RLS on `location_pricing`

The same two-policy shape already used for `location_categories`/`location_availability_rules`:
**`SELECT`** mirrors the parent location's visibility (published, or owner, or admin — pricing
for a live listing is ordinary public marketplace information, the same reasoning already applied
to operating hours in Phase 5) — a non-owning/public caller only ever sees `is_active = true`
rows, while the owner/admin see everything so they can manage inactive rows too. **`INSERT`/
`UPDATE`/`DELETE`** ("for all") requires owning the parent location or being admin, via the same
`assertLocationManageable()` helper every other location sub-resource module already shares.

### Price snapshot

`bookings` copies `base_amount_minor_units`/`currency` from the location *at booking time* and
never recomputes them from the location's current price — a host changing their rate tomorrow
does not change what an existing booking shows today. `platform_fee_minor_units`/
`tax_minor_units`/`discount_minor_units` exist now (always `0`) so Phase 7 can populate real
values without a schema change; `total_amount_minor_units` has its own `CHECK` tying it to the
other four, so the snapshot can never become internally inconsistent.

### `instant_booking_enabled`

`locations.instant_booking_enabled boolean not null default false` — honored immediately, not
just stored for later: `POST /v1/bookings` creates as `confirmed` right away when set, `requested`
otherwise. A pure host preference (skip approval), not payment-dependent — every booking goes
through the identical atomic conflict-prevention path regardless of which status it starts in.

### Why `bookings.location_id` doesn't cascade-delete

Every other foreign key to `locations` in this schema cascades (categories, amenities, media,
availability rules, blocks). `bookings` is the one deliberate exception: deleting a location
with booking history would silently destroy financial/historical records. Attempting to delete a
location that has any bookings now fails with a foreign-key violation, which
`locations.service.ts` maps to a clean `409 CONFLICT` ("Cannot delete a location with existing
bookings") instead of leaking a raw database error as a `500`.

### RLS

- **`SELECT`**: `booker_id = auth.uid() or exists (select 1 from locations where host_id =
  auth.uid() and id = location_id) or has_role(auth.uid(),'admin')` — a booker sees their own
  bookings, a host sees bookings on locations they own, an admin sees everything.
- **`INSERT`**: `booker_id = auth.uid() and has_role(auth.uid(),'booker')` — the same
  "create a new resource for yourself" shape `locations`' own `INSERT` policy uses for
  `host_id`/`has_role(...,'host')`; the app layer also gates `POST /v1/bookings` with
  `requireRole('booker')`, since there's no existing row yet to check ownership against.
- **`UPDATE`**: same three-way visibility condition as `SELECT` — RLS only answers "can this
  caller touch this row at all." *Which* specific transition (confirm/reject/cancel/complete) a
  given caller may perform is enforced in `bookings.service.ts`, not RLS, the same
  separation-of-concerns Phase 2 already established for location status transitions.
- No `DELETE` policy at all — bookings are never hard-deleted.

### Payment is a separate concept (Phase 7)

Booking `status` (lifecycle: requested/confirmed/cancelled/completed/rejected) and payment status
are kept as entirely separate concerns — Phase 7 added a standalone `payments` table (see below)
rather than a `payment_status` column on `bookings` itself. A payment is a bolt-on financial
record attached to an existing booking; nothing about `bookings` — its schema, its RLS, or its
lifecycle actions — changed to make Phase 7 possible, and booking creation still never depends on
any external payment API succeeding.

## Payment Architecture + Cashfree Integration (Phase 7)

**The explicit goal**: a provider-agnostic payment layer, not "Cashfree wired into the booking
flow." `payment.service.ts` never imports anything Cashfree-specific, and `bookings.service.ts`
never imports anything payment-specific — the two modules only meet at `bookings.total_amount_minor_units`/
`currency` (Phase 6/6A's own immutable price snapshot), which `payment.service.ts` reads and never
recomputes.

```
POST /v1/bookings/:id/payment
        |
PaymentService (src/modules/payments/payment.service.ts)
        |
PaymentProvider interface (src/modules/payments/providers/PaymentProvider.ts)
        |
CashfreeProvider (src/modules/payments/providers/CashfreeProvider.ts)  --  Cashfree TEST/sandbox
```

Adding a second provider (e.g. Razorpay) later means: one new value in `PaymentProviderName`, one
new adapter file implementing the same `PaymentProvider` interface, one small additive migration
extending the `provider` `CHECK` constraints on `payments`/`payment_webhook_events`, and wiring it
into `providers/index.ts` (which resolves the active provider from `PAYMENT_PROVIDER`). **Nothing
above the `PaymentProvider` interface — routes, service, database shape — changes.** Changing the
*active* provider requires implementing/configuring that provider's adapter and webhook
integration; Cashfree and Razorpay credentials are never interchangeable with each other.

### Booking status is not gated on payment

`POST /v1/bookings/:id/payment` works on any booking whose status is still `requested` or
`confirmed` — payment succeeding or failing never touches `bookings.status`. The existing
confirm/reject/cancel/complete actions remain the only things that change it, exactly as in
Phase 6A. This is a deliberate choice, not an oversight: `instant_booking_enabled` locations
already go straight to `confirmed` at creation, before any payment exists — `confirmed` there
means "host doesn't need to approve," not "paid." Coupling payment success to that same
transition for non-instant locations would give `confirmed` two different meanings depending on
which path produced it. A failed or never-attempted payment also doesn't auto-release the
booking's reserved interval — a booker can retry payment (a fresh `payments` row against the same
booking) or the booker/host/admin can cancel the booking through the existing lifecycle action,
exactly as before payment existed at all. Automatic expiry-driven booking cancellation is a clean,
isolated later extension (a lazy check against `payments.expires_at`-style bookkeeping on read,
not a cron job), not built in this phase.

### `public.payments`

One row per **payment attempt** against a booking — a retry after a failed/expired attempt
creates a new row rather than mutating the old one, preserving the full attempt history.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | generated in application code (`payment.service.ts`), not the DB default — used to derive `provider_order_id` before any provider call is made |
| `booking_id` | `uuid` | `references bookings(id)`, no cascade (mirrors `bookings.location_id`'s own precedent — bookings are already never hard-deleted anyway) |
| `provider` | `text` | `check in ('cashfree')` — extended by a later migration when a second provider ships |
| `provider_order_id` | `text` | the order id **we** generate and send the provider (`pb_<this row's id>`) |
| `provider_reference_id` | `text`, nullable | the provider's own id for that order/payment (Cashfree's `cf_order_id`/`cf_payment_id`), filled in once known |
| `status` | `text` | normalized, cross-provider (see below) — never a raw provider status string |
| `amount_minor_units`, `currency` | `integer`, `text` | copied from `bookings.total_amount_minor_units`/`currency` at creation, never recomputed |
| `failure_reason` | `text`, nullable | |
| `provider_raw` | `jsonb`, nullable | last known raw provider response/webhook payload — audit/debug only, **never** serialized into any API response |
| `created_at`, `updated_at` | `timestamptz` | existing `set_updated_at()` trigger |
| | | `unique (provider, provider_order_id)`; a **partial** `unique (booking_id) where status in ('created','pending')` — at most one in-flight attempt per booking at a time, the same partial-constraint idiom `bookings`' own `EXCLUDE` and `location_pricing`'s `unique` already established |

### Normalized payment status

`created | pending | success | failed | cancelled | refunded | partially_refunded` — never a raw
Cashfree status string. Mapping (documented here so a future provider's own mapping has a template
to follow):

| Cashfree order `order_status` | Normalized |
|---|---|
| `ACTIVE` | `pending` |
| `PAID` | `success` |
| `EXPIRED` | `failed` |
| `TERMINATED` / `TERMINATION_REQUESTED` | `cancelled` |

| Cashfree webhook `type` | Normalized event |
|---|---|
| `PAYMENT_SUCCESS_WEBHOOK` | `PAYMENT_SUCCESS` |
| `PAYMENT_FAILED_WEBHOOK` | `PAYMENT_FAILED` |
| `PAYMENT_USER_DROPPED_WEBHOOK` | `PAYMENT_FAILED` (retryable — a fresh `payments` row can be created for the same booking) |
| anything else (e.g. `PAYMENT_CHARGES_WEBHOOK`) | acknowledged (`200`), no state change applied |

A payment **never regresses out of a terminal status** (`success`/`failed`/`cancelled`/
`refunded`/`partially_refunded`) once reached — `payment.service.ts#nextPaymentStatus` is checked
before every status write, so a delayed/out-of-order webhook (e.g. a late `FAILED` arriving after
a `SUCCESS`) is always a safe no-op.

### `public.payment_refunds`

One row per refund attempt against a payment. Full vs. partial is just `amount_minor_units`
relative to the parent payment — there is no refund *policy* engine here (who gets refunded how
much on a cancellation is a separate, later product decision); this table only represents refund
*execution*, validated against the arithmetic of what's actually left to refund
(`payment.amount_minor_units - sum(prior pending/success refunds)`).

| Column | Type | Notes |
|---|---|---|
| `id`, `payment_id` | `uuid` | `payment_id references payments(id)` |
| `provider_refund_id` | `text` | merchant-supplied id we send the provider (`pbr_<this row's id>`) |
| `provider_reference_id` | `text`, nullable | Cashfree's `cf_refund_id` |
| `status` | `text` | `check in ('pending','success','failed','cancelled')` |
| `amount_minor_units` | `integer` | `check (> 0)` |
| `reason`, `provider_raw` | nullable | |
| | | `unique (payment_id, provider_refund_id)` |

A successful refund recomputes the parent payment's own status: `refunded` once the sum of
`success` refunds reaches the payment's full amount, `partially_refunded` if it's less.

**Refunds are admin-only in Phase 7** — hosts have no payout/fund-split mechanism yet (see the
extension point below), so only the platform can currently authorize giving money back.

### `public.payment_webhook_events` — idempotency ledger

Cashfree's webhook payloads don't expose one canonical event-id field the way some providers do,
so idempotency is keyed on `sha256(raw request body)` instead: `unique (provider, raw_body_hash)`
catches an exact redelivery (providers redeliver at-least-once) before any business logic runs.
This is a separate mechanism from the terminal-status guard above — this table stops the *same*
delivery being processed twice; the terminal-status guard handles a *different*, out-of-order
delivery arriving late. Internal only: no `authenticated`/`anon` access at all, never exposed
through any API.

### Raw body & signature verification

Cashfree signs `x-webhook-timestamp + <exact raw request bytes>` with HMAC-SHA256 using the
client secret, base64-encoded, compared to the `x-webhook-signature` header
(`CashfreeProvider#verifyAndParseWebhook`, using `crypto.timingSafeEqual` for a constant-time
comparison). Express's global `express.json()` (mounted in `app.ts`) would parse-and-discard the
raw buffer before a handler ever saw it — the well-known Stripe-webhook-style ordering gotcha — so
`POST /v1/payments/webhooks/cashfree` is registered directly on `app`, with
`express.raw({ type: "application/json" })`, **before** `app.use(express.json())` runs. Every
other route is unaffected; only that one path receives a raw `Buffer` instead of a parsed body.

### Checkout flow

`POST /v1/bookings/:id/payment` never trusts a client-supplied amount — the request body has no
amount field at all, and reads `bookings.total_amount_minor_units`/`currency` as the sole source
of what's charged. The response's `checkout` field is an intentionally opaque, provider-shaped
payload (`{ payment_session_id, order_id }` for Cashfree, consumed by Cashfree's native
Checkout SDK client-side) — not a fixed cross-provider contract. The backend remains authoritative
for whether a payment actually succeeded: `POST /v1/payments/:id/verify` re-checks status directly
against the provider's own API (never a client's "it succeeded" claim), using the identical
guarded status-transition logic the webhook handler uses — a webhook and a manual verify can never
disagree about what "reached success" means.

### RLS

Deliberately different from every other table in this schema: `payments`/`payment_refunds` get a
`SELECT` policy (booker via a join to `bookings.booker_id = auth.uid()`, host via the same
`locations.host_id = auth.uid()` join `bookings`' own RLS already uses, or admin) — but **no
`INSERT`/`UPDATE`/`DELETE` policy for `authenticated` at all**. A row's `status`/`amount_minor_units`
must never be directly settable by any client call, even a correctly-scoped one — the only truth
sources are a provider's signed webhook and a server-side status fetch. Every write goes through
`payment.service.ts` using the `service_role` client, with ownership/authorization checked in
application code first (the same way `assertLocationManageable` gates every other module's
writes). This is the first module whose request path genuinely depends on the `service_role`
client for a live write path — `docs/ARCHITECTURE.md` already names it as reserved for exactly
this. `payment_webhook_events` has no `authenticated`/`anon` access whatsoever.

### Commission / host earnings / payout — extension point, not built yet

No `platform_fee`/`host_earning`/payout schema was added this phase. `bookings.platform_fee_minor_units`
(Phase 6, always `0`) remains the gross-amount source; `payments` records actual money movement. A
later phase can add a `host_payouts` table keyed off both without touching anything documented
here — this is a structural extension point, not a schema pre-commitment, consistent with not
building for a requirement that hasn't been asked for yet.

## Notification Infrastructure + APNs Push (Phase 8)

**The explicit goal**: a provider-agnostic notification layer — in-app notification records,
per-device push delivery, user preferences — as a *downstream* effect of booking/payment events
that already exist (Phases 6/6A/7). Nothing about booking or payment state machines changed to
build this; `notification.service.ts` is the only new dependency `bookings.service.ts`/
`payment.service.ts` picked up, and the dependency runs one direction only.

```
bookings.service.ts / payment.service.ts   (unmodified state machines)
        |  small, best-effort, non-blocking notify*() calls after a commit
        v
notification.service.ts
        |
        +--> notifications (in-app record, idempotent via source_event_id)
        |
        +--> for each of the recipient's active devices ->
                 NotificationProvider interface (src/modules/notifications/providers/)
                       |                              \
                  APNsProvider                    DisabledProvider (default)
```

A `notify*()` call is a plain async function call, not an event bus/queue — this repo has no
queue infrastructure, and none was warranted for this. Every exported `notify*()` function
(`notification.service.ts`) catches its own errors internally and never throws, so a notification
bug or transient failure can never fail the booking/payment operation that triggered it.

**A big constraint this phase conforms to rather than invents**: the ProdBnb iOS app already ships
a fully-built, unconnected notification client (`Models/NotificationPayload.swift`,
`Services/Notifications/*`, a `NotificationTypeKey` enum) with an exact documented push payload
contract. This phase matches that contract exactly rather than inventing a new one, so the iOS
team can wire up real push with zero client-side changes later.

### Which event produces which notification, and why some don't exist yet

| Backend moment | Recipient | `type` |
|---|---|---|
| `createBooking()`, always | the location's host | `booking_request_received` |
| `createBooking()`, additionally if the resulting status is `confirmed` (instant booking) | the booker | `booking_confirmed` |
| `confirmBooking()` | the booker | `booking_confirmed` |
| `rejectBooking()` | the booker | `booking_declined` |
| `cancelBooking()` | whichever party did **not** cancel | `booking_cancelled` |
| a payment reaching `success` | the booker | `payment_success` |
| a payment reaching `failed` | the booker | `payment_failed` |
| a payment first moving away from `success` into any refunded state | the booker | `refund_processed` |

Two deliberate string translations happen here, not accidents: a booking's own `status` value
`rejected` becomes notification type **`booking_declined`**, and a payment reaching `refunded`/
`partially_refunded` becomes **`refund_processed`** — these are the exact raw values the iOS
app's `NotificationTypeKey` enum already expects; the booking/payment tables' own status vocabulary
is untouched. `completeBooking()` and a refund reaching `created`/`failed` deliberately produce
**no** notification — iOS's enum has no corresponding case for either, and inventing one
unilaterally on the backend would create a type the client can't parse.

### `public.user_devices`

One row per (user, physical device/app-install). `device_token` is **globally unique**, not
scoped per user — a push token identifies a device+app-install, not a person. Registering a token
that already belongs to a *different* user (logout, someone else logs in on the same phone)
reassigns that row via a plain `upsert(..., { onConflict: "device_token" })` rather than erroring,
so a shared device correctly stops notifying the previous owner. Never hard-deleted —
`DELETE /v1/devices/:id` sets `is_active = false`, preserving `notification_delivery_attempts`
history. `platform` already models `ios`/`android`/`web` even though only `ios` has a real
adapter this phase (see below).

### `public.notifications`

One row per logical notification per **recipient**, never per device (see delivery below).
`type` is `CHECK`-constrained to exactly the seven values in the table above — deliberately not a
free-text column, matching every other enum-shaped column in this schema. `entity_type` is
similarly constrained to `('booking')` only: every event this phase produces traces back to
exactly one booking (confirmed by the iOS app's own `NotificationRouter`, which deep-links all
seven types via a booking id specifically, even the payment/refund ones). `data jsonb` is a small
forward-compatible bag for anything beyond `entity_id` a push payload wants to carry (e.g.
`payment_id`), mirroring the iOS payload's own `raw: [String:String]` bag. `source_event_id` is
the idempotency key (see below); a partial `unique (user_id, source_event_id) where
source_event_id is not null` is the actual guarantee.

**Why delivery status lives in its own table, not a column here**: a notification is one row per
user-event; delivery is inherently *per device*, and a user can have several. Putting delivery
status on `notifications` would either force one row per device (breaking the idempotency/
read-state model) or collapse multiple devices' distinct outcomes into one field (losing real
information — "worked on the iPhone, invalid token on the old iPad").

### `public.notification_preferences`

One row per `(user_id, category)` — the same "one row per (owner, type)" idiom `location_pricing`
(Phase 6A) already established. Only `booking` and `payment` exist as categories — the only two
with a real notification-producing event this phase. **A missing row means enabled** — the safe
default, so a user who never opens settings still gets transactional push delivery.

**Preferences gate push delivery only, never notification creation.** The in-app `notifications`
list is always complete regardless of this table; a disabled category only means no push attempt
is made for that category's events. This resolves a real tension: a critical transactional
notification must never accidentally vanish just because a preference toggle is off, but the iOS
app already ships user-facing Booking/Payment notification toggles that need to mean *something*.
The something they mean is "don't buzz my phone for this," not "don't tell me at all."

### `public.notification_delivery_attempts`

One row per (notification, device) push attempt, append-only like `payment_webhook_events` — a
retry (not implemented this phase, see below) would be a new row, never a mutation of an old one.
`status` includes an explicit **`skipped`** outcome, distinct from both `sent` and `failed` — used
whenever `NOTIFICATION_PROVIDER=disabled` (the default with no Apple credentials configured).
This is a deliberate, load-bearing design choice: **a push is never silently reported as
delivered when nothing was actually attempted.** `invalid_token` immediately flips the owning
`user_devices` row to `is_active = false`.

### Idempotency

`source_event_id` format: `"<entity_type>:<entity_id>:<type>"`, e.g.
`"booking:<uuid>:booking_confirmed"`, `"payment:<uuid>:payment_success"` — fully deterministic
from the triggering entity + event type, no separate counter needed. Calling the same `notify*()`
twice for the same logical event (a bug, or two code paths racing) collides on insert (`23505`)
and the second call is a safe no-op — no second notification row, and critically, **no second
round of delivery attempts either**, since delivery only ever runs after a *successful* insert.

### `NotificationProvider` and APNs

Mirrors `PaymentProvider` (Phase 7) deliberately — the identical "one internal concept, swappable
external provider" shape, already proven out. `APNsProvider` uses Apple's token-based (JWT)
HTTP/2 API (`node:http2` + `node:crypto`'s ES256 signing via `dsaEncoding: "ieee-p1363"`, zero new
npm dependencies — the same zero-extra-HTTP-dependency pattern R2/Cashfree already established),
caching the signed provider JWT for ~50 minutes rather than re-signing per request (Apple's own
recommendation). Apple's actual HTTP response is normalized before it ever reaches
`notification.service.ts`: `BadDeviceToken`/`Unregistered`/`DeviceTokenNotForTopic` → `invalid_token`
(device deactivated), any other non-`200` → `failed`, `200` → `sent` with the `apns-id` response
header captured as `provider_message_id`. Sandbox only this phase — `APNS_ENVIRONMENT`'s schema
(`src/config/env.ts`) only accepts `"sandbox"`, the same enum-of-one pattern `CASHFREE_ENV` uses,
so a future production switch is a conscious two-line change (schema + host map), never an
accidental config typo.

**Push payload** (`{"aps": {"alert": {"title","body"}, "sound":"default"}, "prodbnb_type": ...,
"prodbnb_entity_type": "booking", "prodbnb_entity_id": ..., "prodbnb_booking_id": ...}`) matches
`NotificationPayload.swift`'s already-documented top-level custom-key convention exactly. No
private booking/payment detail (amounts, location names) is put in the title/body — copy is
deliberately generic; the client looks up full detail via `entity_id`/`prodbnb_booking_id` once
opened.

### Developing and testing without an Apple Developer account

`NOTIFICATION_PROVIDER` defaults to `"disabled"` — unlike `PAYMENT_PROVIDER`, which requires real
Cashfree credentials unconditionally, this phase must remain fully testable with zero Apple
configuration. With the default `DisabledProvider`, every push attempt is honestly recorded as
`skipped`; the full notification pipeline — creation, idempotency, multi-device fan-out,
preferences, the booking/payment integration — is exercised end-to-end against real Postgres with
no network call involved at all. `APNsProvider`'s own JWT/payload construction and HTTP
response-mapping logic is separately unit-tested with `http2` mocked at the boundary (the same
"mock the network, keep the database real" approach `tests/payments.test.ts` already established
for Cashfree). Real push delivery to a physical device is the one thing this cannot cover — that
requires the Apple configuration below.

### Manual Apple configuration (only for real push delivery — not required to build or test this)

1. An Apple Developer Program membership (paid) — obtains the Team ID and lets you generate
   credentials; not required for anything in this repository to build or pass its tests.
2. Register the iOS app's App ID/bundle identifier with the **Push Notifications** capability.
3. Generate an **APNs Authentication Key** (`.p8`) in the Apple Developer portal — produces the
   Key ID.
4. Add the Push Notifications entitlement to the iOS app in Xcode (client-side, outside this repo).
5. Real APNs tokens are only issued on a **physical device** — the iOS Simulator cannot register
   for remote push at all.
6. Sandbox (development-signed builds) and production (TestFlight/App Store builds) get different
   tokens, valid only against the matching Apple host — `APNS_ENVIRONMENT`/`user_devices.environment`
   exist specifically to keep these from being conflated.

### RLS

| Table | `SELECT` | `INSERT`/`UPDATE`/`DELETE` |
|---|---|---|
| `notifications` | `user_id = auth.uid()` only — no host/admin override; nothing in this phase establishes a legitimate product need for admin visibility into another user's notifications | `UPDATE` only (the client only ever sets `read_at`), same scope. **No `INSERT` grant** — a client must never fabricate a notification for itself or anyone else, the same reasoning Phase 7 applied to `payments`. |
| `user_devices` | `user_id = auth.uid()` | `UPDATE` only (the soft-delete toggle on a row the caller already owns). **No `INSERT` grant** — registration always goes through `device.service.ts`'s `service_role` client, since a token collision with a *different* user's existing row (reassignment) is something RLS structurally cannot allow a normal user-scoped client to do. This is the second module (after `payments`) whose request path genuinely depends on `adminClient`. |
| `notification_preferences` | `user_id = auth.uid()` | ordinary self-service (mirrors `location_pricing`'s owner-write shape) — no cross-user concern here at all |
| `notification_delivery_attempts` | none for `authenticated`/`anon` | `service_role` only — internal audit table, mirrors `payment_webhook_events` exactly |

### Error/retry strategy

No retry queue this phase — each notification triggers exactly one delivery attempt per active
device, synchronously, at creation time. A `failed`/`invalid_token` result is recorded and left
there; a future phase could re-scan failed attempts, but that's an isolated, additive extension,
not built now, and this repo has no existing queue to plug one into anyway.

## Admin Control + Admin Panel (Phase 11)

**The core finding**: most of what this phase needs already existed. `updateLocation()` already
let admin set any of the 8 lifecycle statuses; `cancelBooking()` already accepted an admin caller
regardless of ownership; `createRefund()` was already admin-only; RLS on `bookings`/`payments`/
`payment_refunds`/`locations`/`profiles` already had a `has_role(auth.uid(),'admin')` branch
granting an admin's own request-scoped client full read access. Phase 11 is a purpose-built
`/v1/admin/*` namespace over that existing capability, plus one genuinely new thing: an immutable
audit log. No booking/payment/availability invariant changed.

### `public.admin_audit_log`

Append-only, like `payment_webhook_events`/`notification_delivery_attempts` — no `updated_at`, no
trigger, never mutated after insert.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `admin_id` | `uuid` | `references profiles(id)` |
| `action` | `text` | `check in (...)` — a closed set matching exactly the 8 mutating admin actions this phase implements: `ADMIN_APPROVED_LOCATION`, `ADMIN_REJECTED_LOCATION`, `ADMIN_SUSPENDED_LOCATION`, `ADMIN_RESTORED_LOCATION`, `ADMIN_SUSPENDED_USER`, `ADMIN_RESTORED_USER`, `ADMIN_CANCELLED_BOOKING`, `ADMIN_CREATED_REFUND` (extended to 9 actions in Phase 12 — see "RLS/grant hardening (Phase 12)" below) |
| `target_type` | `text` | `check in ('location','user','booking','payment')` |
| `target_id` | `uuid` | |
| `reason`, `metadata` | nullable / `jsonb` | |
| `created_at` | `timestamptz` | |

**No `INSERT`/`UPDATE`/`DELETE` grant to `authenticated` at all** — every entry is written by
`writeAuditLog()` (`src/modules/admin/audit.service.ts`) using `adminClient`, as the last step of
a successful privileged mutation. There is no client-writable path to create, edit, or erase an
entry through any API — not even for the admin who performed the action, verified directly in
`tests/admin-audit-log.test.ts` by attempting raw inserts/updates/deletes with an admin's own
bearer token against PostgREST and confirming they're rejected. `SELECT` is admin-only, RLS-scoped
(`has_role(auth.uid(),'admin')`, no per-admin restriction — every admin sees every entry, since
accountability across the whole admin team is the point).

### Location moderation and the `approved` status decision

`approve`/`reject`/`suspend`/`restore` (`src/modules/admin/locations.service.ts`) are thin,
validated wrappers around the same `locations.status` `UPDATE` the generic `PATCH
/v1/locations/:id` admin path already used — no duplicate status system, no new lifecycle states.
**Decision**: `approve` moves `submitted`/`under_review` directly to `published` — there is no
separate `approved`-then-`publish` two-step (the `approved` status value still exists in the
`CHECK` constraint for schema compatibility, simply unused by this phase's own actions). Each
action validates its source status (e.g. `reject` only from `submitted`/`under_review`, `suspend`
only from `published`) and throws `400` otherwise. `reject`/`suspend` require a `reason`;
`approve`/`restore` do not (undoing/advancing a state positively doesn't need justification the
way a rejection/suspension does).

`locations.moderation_reason` (new, nullable column) holds the *current* explanation shown to the
owning host — set on reject/suspend, cleared on approve/restore. The full historical record of
every reason ever given lives in `admin_audit_log`; this column is not a second status system,
just one explanatory field alongside the existing `status` column. It is safe to include in the
shared `LOCATION_COLUMNS`/public detail select (rather than a separate admin-only query) because
of an invariant enforced at every call site: it is only ever non-null in the *same* `UPDATE` that
moves `status` away from `published`, and cleared in the *same* `UPDATE` that moves it back — a
publicly-visible (`published`) row therefore always has `moderation_reason: null` by construction,
verified explicitly in `tests/admin-locations.test.ts`.

### Host suspension and `locations.suspended_by_host_suspension`

Suspending a user (`src/modules/admin/users.service.ts#suspendUser`) sets `profiles.status =
'suspended'` and, as a cascade, moves every one of that host's *currently-`published`* locations
to `suspended`, marking each with the new boolean column `suspended_by_host_suspension = true` and
a generic `moderation_reason`. Locations already in any other state — draft, submitted,
independently-suspended, rejected, archived — are **never touched**. Restoring the user reverses
this: only locations where `suspended_by_host_suspension = true` are moved back to `published`
(flag and reason cleared); a location an admin independently suspended for its own reason (flag
stays `false`) is never touched by a host restore, even if it happens to be `suspended` at the
same time. The per-location `suspend`/`restore` actions always set the flag to `false` — any
deliberate admin action on a specific location marks it as independent, so it's both skipped by a
later host-suspend cascade (it's no longer `published`) and never auto-restored by a later
host-restore. `approveLocation()` additionally refuses to approve a submitted location whose host
is currently suspended (`400`) — otherwise a location could be approved straight into "published,
but the host who'd manage it can't be reached." Existing confirmed bookings, payments, and
availability history are never touched by either suspend or restore — a suspended host's
locations simply stop being `published` (and therefore stop being bookable, since booking
creation already requires `status = 'published'` — no new check needed there), nothing about
already-existing rows changes. See `tests/admin-locations.test.ts`'s "host suspension cascade"
tests for the exact behavior verified.

### `profiles.status` is now enforced

Phase 1's `profiles.status` (`active`/`suspended`/`deleted`) existed but was checked nowhere.
`requireAuth` (`src/middleware/auth.ts`) now fetches it alongside identity resolution and rejects
(`403`) a non-`'active'` caller before any route-specific authorization runs. Every existing user
defaults to `'active'`, so this was a no-op for the entire pre-Phase-11 test suite (verified: all
225 prior tests passed unmodified with this check in place before any new admin code existed).
`profiles.status` itself has no column-level `UPDATE` grant to `authenticated` at all (Phase 1: "so
profile updates can never self-escalate account status") — only `service_role` can write it, for
any user including an admin's own row, which is why suspend/restore go through `adminClient`
rather than the admin's own request-scoped client.

### RLS/service-layer summary

| Data | Read path | Write path |
|---|---|---|
| `admin_audit_log` | caller's own client (RLS: admin-only) | `adminClient` only (`writeAuditLog`) |
| `bookings`/`payments`/`payment_refunds` listings | caller's own client (existing `has_role(admin)` RLS branch — no new policy needed) | thin wrappers around existing, unmodified service functions |
| `locations` moderation | caller's own client (existing `locations_update_own_or_admin` RLS already covers admin) | caller's own client |
| `profiles.status` (suspend/restore) | caller's own client | `adminClient` (no column grant exists for `authenticated`) |
| `notification_delivery_attempts` | `adminClient` only (Phase 8: zero `authenticated` access on this table) | n/a (read-only diagnostics) |
| Email/last-sign-in (`GET /v1/admin/users/:id`) | Supabase Admin Auth API (`adminClient.auth.admin.getUserById`) — `profiles` has no email column by design | n/a |

No existing RLS policy was weakened anywhere in this phase.

### Admin router mounting — a real gotcha worth documenting

`adminRouter` is mounted at `app.use("/v1/admin", adminRouter)`, **not** `app.use("/v1",
adminRouter)`, even though every route inside it is written without the `/admin` prefix (e.g.
`adminRouter.get("/dashboard", ...)`). The router-level `adminRouter.use(requireAuth,
requireRole("admin"))` gate has no path restriction, so it runs for *every* request that reaches
this router at all — mounting it at the bare `/v1` prefix would have made that gate intercept
every request for every router registered after it in `app.ts` (including public ones like
`catalogRouter`), since Express only skips a sub-router entirely when the request path doesn't
match its own mount prefix, not when no route inside it matches. This was caught during Phase 11's
own implementation (all public catalog endpoints started 401ing) before it ever shipped, but is
exactly the kind of subtle Express composition bug worth a permanent comment, not just a fixed
diff.

### Admin API contract (OpenAPI)

`/v1/admin/*`'s zod schemas (`src/modules/admin/admin.schema.ts` and the admin-relevant schemas
reused from `bookings`/`locations`/`payments`/`users`) are the source for a generated OpenAPI 3.0
document — see `docs/admin-openapi.json` and `scripts/generate-openapi.ts`. Not retrofitted across
the other ~50 existing endpoints from Phases 1–8; scoped to the admin surface only, since that's
the one with a new, separate frontend consumer that benefits from generated types. The Admin
Panel project generates its own TypeScript request/response types from this document rather than
hand-copying shapes between the two repositories.

## RLS/grant hardening (Phase 12)

A security audit found that `bookings`, `locations`, and `location_media` shared a gap: RLS
checked row *ownership* only ("is this your row"), never *which columns* or *values* a write
could touch. `profiles.status` (Phase 1) and `payments`/`payment_refunds` (Phase 7) already got
this right — this phase extends the same pattern to the three tables that were missed. No booking/
pricing/payment/notification/location-lifecycle architecture changed; every fix is a grant
restriction plus routing the affected write through `adminClient` from the same service function
that already fully enforced authorization in application code (nothing about *who* may perform an
action changed, only *where* the write executes from).

**`bookings`** — `authenticated` now has **`SELECT` only**; `INSERT`/`UPDATE` are revoked
entirely. Every write goes through `adminClient` from `bookings.service.ts` (`createBooking()`,
`transitionBooking()`), exactly mirroring how `payments` has worked since Phase 7. Before this,
a booker holding a real Supabase session (every legitimate client already has one) could
`PATCH .../rest/v1/bookings?id=eq.<own booking>` directly and rewrite their own booking's
`total_amount_minor_units` to near-zero before paying for it — the "immutable price snapshot"
`payment.service.ts#createPayment` trusts was never actually immutable at the database layer. The
same gap let a booker self-set `status` to `confirmed` (skipping host approval) or insert a
fabricated `completed` booking directly, which sits outside the EXCLUDE constraint's guarded-status
set (`requested`/`confirmed` only) and so evaded the double-booking guarantee entirely. Verified
closed in `tests/hardening.test.ts` via real PostgREST calls with a real booker session, not just
API-level assertions.

**`locations`** — `authenticated` keeps `INSERT`/`UPDATE`, but the column grant excludes `status`,
`moderation_reason`, `suspended_by_host_suspension`, and `host_id`. A host's own content edits
(title/description/address/...) are unaffected — still a single statement via their own scoped
client. Any write touching `status` — a host's own `draft→submitted`/`submitted→draft`/
`published→archived`, or an admin's moderation/override — now goes through `adminClient` from
`updateLocation()` (`locations.service.ts`) or the four dedicated moderation functions
(`admin/locations.service.ts`, which previously used the caller's own scoped client for this and
had to switch). `createLocation()`'s `INSERT` never included `status` to begin with (it always
takes the column default, `'draft'`) — the same column exclusion now makes that true even for a
raw PostgREST insert, not just the app's own schema. Before this, a host could self-publish a
draft directly via PostgREST, bypassing admin moderation entirely, or self-clear
`moderation_reason`/restore a location an admin had suspended.

**`location_media`** — `authenticated` loses `INSERT` entirely (kept: `UPDATE (position)` for
reordering, and `DELETE`, both already ownership-gated and unaffected). Only
`completeUpload()` (`media.service.ts`) may create a row now, via `adminClient`, and only after
its existing `headObject()` verification against the real uploaded R2 object. Before this, a host
could insert a `location_media` row directly, pointing `storage_key` at any string — including
another location's real, already-uploaded object (its key is derivable from that location's own
public media URLs) — bypassing the content-type/size verification `completeUpload()` performs and
effectively "stealing" another host's media into their own listing.

**New audit action: `ADMIN_UPDATED_LOCATION_STATUS`.** The generic `PATCH /v1/locations/:id`
retains its existing admin capability to set *any* of the 8 statuses (unlike the four dedicated
moderation actions, this path can reach `approved`/`under_review`, which no dedicated endpoint
produces) — now routed through `adminClient` like everything else above, and audited under this
new action (`previous_status`/`new_status` in `metadata`) so it's no longer a silent, unaudited
path. `admin_audit_log.action`'s `CHECK` constraint was extended (looked up and dropped
dynamically in the migration, rather than hardcoding Postgres's auto-generated constraint name) to
add it — the set is now 9 actions, not 8.

**Two other pre-existing routes also used to leave zero audit trail when an admin used them**:
the generic `POST /v1/bookings/:id/cancel` and `POST /v1/payments/:id/refunds` (both predate
Phase 11 and already accepted an admin-bypass caller) never called `writeAuditLog` — only the
dedicated `/v1/admin/bookings/:id/cancel` / `/v1/admin/payments/:id/refunds` wrappers did. Both
legacy routes now log the same `ADMIN_CANCELLED_BOOKING`/`ADMIN_CREATED_REFUND` actions their
dedicated counterparts already used, so which route an admin happens to call no longer determines
whether the action is auditable. Verified in `tests/admin-audit-log.test.ts` and
`tests/payments.test.ts`.

**Two new DB-level backstops**, both mirroring `payments_one_inflight_per_booking`'s existing
"atomic backstop under an application-level pre-check" shape:

- `payments_one_settled_per_booking` — a partial unique index on `payments (booking_id) where
  status in ('success','partially_refunded','refunded')`. `createPayment()` already rejects a
  second payment attempt once one has succeeded (payment success deliberately never mutates
  booking status, so nothing else stopped a retried `POST .../payment` from creating a second,
  fully separate, fully charged payment) — this index makes that guarantee atomic under a genuine
  concurrent double-submit, the same relationship the existing in-flight index already has to its
  own pre-check.
- `enforce_refund_balance()` — a `BEFORE INSERT` trigger on `payment_refunds` that locks the
  parent `payments` row (`SELECT ... FOR UPDATE`) and re-validates the exact balance rule
  `createRefund()` already applies (sum of `pending`+`success` prior refunds plus the new one must
  not exceed the payment's amount) before allowing the insert. Closes a TOCTOU race the
  application's own check-then-insert couldn't close on its own: two concurrent refund requests
  against the same payment could otherwise both read the same "remaining balance" before either
  committed.

**Four new indexes** for query patterns that already existed in the service layer but had no
matching index: `bookings (location_id, start_at desc)` and `bookings (status, start_at desc)`
(the existing partial GiST EXCLUDE index only covers active-status *overlap* checks, not plain
listing/filtering across all statuses — `listBookings()`/`GET /v1/admin/bookings` needed these);
`payments (status, created_at desc)` and `payment_refunds (status, created_at desc)` (the admin
payments/refunds dashboard filters and sorts on exactly these columns).

**`optionalAuth`** (`src/middleware/optionalAuth.ts`) now checks `profiles.status` too, matching
`requireAuth` — a suspended/deleted caller's token now falls back to anonymous (never a rejection,
matching this middleware's existing behavior for an invalid/expired token) instead of retaining
owner-level visibility on the four `optionalAuth`-gated read routes (`GET /v1/locations/:id`,
`/media`, `/pricing`, `/availability`).

**`transitionBooking()`** (`bookings.service.ts`) gained a compare-and-swap guard — its `UPDATE`
now also matches on the exact status each caller (`confirmBooking`/`rejectBooking`/
`completeBooking`/`cancelBooking`) already validated against, returning a clean `409` instead of
silently applying if two concurrent transitions race on the same booking (e.g. a host reject
racing an admin confirm). Doesn't affect the double-booking guarantee (no transition here changes
the reserved interval) — it closes a smaller, separate lifecycle race that could otherwise fire
two contradictory notifications for the same booking. Verified with a genuine `Promise.all`
concurrency test in `tests/hardening.test.ts`, matching the existing shape of the booking-creation
concurrency tests.

## Messaging data model (Phase 27-1)

Booker ↔ Host conversations. **Phase 27-1 is the schema foundation only** — there is no messaging
API, no Realtime transport and no notification integration yet; those are later Phase 27
sub-phases. Purely additive: no existing table, column, policy, grant or trigger changed.

### Conversation identity: `unique (booker_id, location_id)`

One durable thread per **booker + listing**, deliberately not per booking. Three alternatives were
rejected for concrete reasons:

- **Per booking** would make the app's primary entry point impossible — "Contact Host" from a
  listing page has no booking by definition, and the pre-booking availability enquiry is the most
  common first message in the product.
- **Per (booker, host)** would merge a host's three separate listings into one thread.
- **Per (booker, location, booking)** fragments: a booker who books the same studio four times
  ends up with five threads about the same place with the same person, splitting the unread count
  four ways.

`booking_id` is therefore optional, **mutable context** — which booking the thread is currently
about, for the conversation header and deep-linking. It is never part of identity and never
consulted for authorization: a thread stays fully readable *and writable* after its booking is
rejected, cancelled or completed, which is exactly when the two parties most need to talk.

The **host side is derived**, never stored: the counterparty is `locations.host_id` for
`conversations.location_id`. A denormalized copy could only ever become a second, weaker source of
truth, and `locations.host_id` has had no `authenticated` grant since Phase 12, so it cannot drift.

### `public.conversations`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | `gen_random_uuid()` |
| `booker_id` | `uuid` | `references profiles(id) on delete cascade` |
| `location_id` | `uuid` | `references locations(id)` — **no cascade**, see below |
| `booking_id` | `uuid` | nullable, mutable context — `references bookings(id)`, no cascade |
| `last_message_at` | `timestamptz` | `not null default now()` — what the Inbox sorts by |
| `last_message_id` | `uuid` | nullable — `references messages(id) on delete set null` |
| `created_at` / `updated_at` | `timestamptz` | `updated_at` via the shared `set_updated_at()` trigger |
| | | `unique (booker_id, location_id)` |

`last_message_at`/`last_message_id` are a **denormalized cache** so the Inbox list can sort and
render a preview without a per-row aggregate over `messages`. `messages` is always the authority;
neither column is ever read to decide what a conversation contains.

**The circular foreign key.** `conversations.last_message_id → messages.id` and
`messages.conversation_id → conversations.id` reference each other, so the second table's
constraint cannot exist before the first table does. The column is declared inline with its
siblings (keeping one readable definition of the row shape) and only the FK is deferred to an
`ALTER TABLE ... ADD CONSTRAINT` at the foot of the same migration — which runs in one
transaction, so there is no window where the column exists unconstrained. `ON DELETE SET NULL`,
never `CASCADE`: deleting the message a conversation happens to point at must clear the cache, not
delete the conversation and the rest of its history with it.

### `public.messages`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | `gen_random_uuid()` |
| `conversation_id` | `uuid` | `references conversations(id) on delete cascade` |
| `sender_id` | `uuid` | `references profiles(id) on delete cascade` |
| `body` | `text` | `check (char_length(btrim(body, E' \t\r\n\f\v')) between 1 and 4000)` |
| `client_message_id` | `uuid` | client-generated idempotency key |
| `created_at` | `timestamptz` | `not null default now()` — the ordering key, with `id` |
| | | `unique (conversation_id, sender_id, client_message_id)` |

**Immutable.** No `updated_at`, no `set_updated_at` trigger, and no `INSERT`/`UPDATE`/`DELETE`
grant to `authenticated` at all — there is no edit, unsend or delete in V1, and a column nothing
can ever change would misrepresent the model. Ordering is `(created_at, id)`; `created_at` is
always server-assigned.

> **The trim set is spelled out on purpose.** Single-argument `btrim()` strips **spaces only**, so
> the obvious `char_length(btrim(body)) >= 1` happily accepts a body consisting entirely of
> newlines or tabs — precisely the empty message the constraint exists to reject, and which the
> iOS composer (trimming `.whitespacesAndNewlines`) already treats as empty. This was caught by
> the Phase 27-1 tests against the first draft of the constraint, not in review; the regression
> guard for it lives in `tests/messaging-schema.test.ts`.

**Why idempotency is scoped to `(conversation_id, sender_id, client_message_id)`** and not to
`(conversation_id, client_message_id)`: without `sender_id` in the key, one participant could pick
a `client_message_id` that collides with the other's, their insert would be rejected as a
duplicate, and the idempotent re-read would hand them *the other party's message* as if it were
their own — silently losing what they actually typed. Same role as
`notifications.source_event_id`, but supplied by the client rather than derived server-side,
because only the client knows that two requests are the same tap.

### `public.conversation_reads`

One read cursor per `(conversation_id, user_id)` — surrogate `id` PK plus a unique constraint, the
same "one row per (owner, thing)" shape as `notification_preferences`/`user_roles`. Stores
`last_read_at` (null = nothing read yet) and `last_read_message_id`
(`on delete set null`), so a client can draw a "new messages" divider at a precise point rather
than inferring one from a timestamp.

Deliberately **not** a `messages.is_read` boolean: read state is per-user, so it cannot live on the
shared message row at all, and a boolean would mean updating N rows per read instead of one.

Deliberately **not** a `conversation_participants` table either. Membership is fully derivable
(`conversations.booker_id` + `locations.host_id`), so a membership table could only drift out of
sync with what it mirrors. Holding a row here is **not** what makes someone a participant and its
absence never denies access — this table is read *state*, nothing more.

### `public.admin_message_access`

ProdBnb messaging is not end-to-end encrypted, and administrators are able to read conversation
content for legitimate platform purposes (dispute resolution, fraud, abuse investigation, support,
marketplace integrity, suspected off-platform transactions). That capability is deliberately **not**
expressed as `participant or has_role(auth.uid(), 'admin')` on the policies below: an admin
reading someone's private correspondence must be a distinct, recorded act with a stated reason,
not an invisible widening of an ordinary read.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `admin_user_id` | `uuid` | `references profiles(id)` — **no cascade**, as `admin_audit_log.admin_id` |
| `conversation_id` | `uuid` | `not null`, **no foreign key** — a bare reference, as `admin_audit_log.target_id` |
| `action` | `text` | `check (action in ('view_conversation'))` |
| `reason` | `text` | **`not null`** + `check (char_length(btrim(reason)) > 0)` |
| `created_at` | `timestamptz` | |

Modelled on `admin_audit_log`: append-only, no `updated_at`, no trigger, no client-writable path —
so no admin can create, edit or erase an entry, including their own. It holds **no message
content**. Two deliberate divergences from `admin_audit_log`: `reason` is mandatory *and*
`CHECK`-constrained non-blank (without the CHECK, `reason: ""` would satisfy `NOT NULL` and defeat
the whole point), and `action` uses lowercase snake_case like every other enum-shaped column in
this schema rather than `admin_audit_log.action`'s outlier SCREAMING_SNAKE — this is a separate
table with its own vocabulary, for a *read* rather than a mutation.

**`conversation_id` carries no foreign key** (corrected in Phase 27-2). 27-1 modelled it as
`references conversations(id) on delete cascade`, which gave the audit record the wrong lifetime —
the log of an admin reading someone's private correspondence vanished the moment that
correspondence was deleted. The cascade was itself avoiding the opposite failure: a *restricting*
FK would have let a single access record permanently block deletion of the booker's account
(profile → conversations → blocked), so an admin doing their job could make a user undeletable.
Dropping the FK resolves both, and matches `admin_audit_log.target_id`, which has referenced
bookings/locations/users as a bare `uuid not null` since Phase 11 for exactly this reason.
Consequently this column may point at a conversation that no longer exists — intended behaviour,
not a dangling reference to repair. `admin_message_access_conversation_id_idx` is retained.

The Admin Messaging authorization/service layer that writes this table, and the admin read path it
gates, is a **later Phase 27 sub-phase**. Nothing reads or writes it yet.

### Deletion behaviour

Every profile FK above uses `on delete cascade`, this schema's existing convention for the profile
that *owns* a row (`bookings.booker_id`, `notifications.user_id`, `locations.host_id`,
`notification_preferences.user_id`). Phase 27-1 followed that convention rather than inventing a
retention policy, and Phase 27-2 deliberately left it alone. What it actually does was verified
against the local stack, not inferred:

| Deleting… | Outcome |
|---|---|
| a **booker**'s profile | **Succeeds, and takes the whole thread with it** — the conversation, every message in it *including the host's own*, and both read cursors. The host loses their side of the correspondence. |
| a **host**'s profile | **Fails outright.** `locations.host_id` cascades, so the delete tries to remove their listings, and `conversations.location_id` (`NO ACTION`) blocks it. A host is undeletable as soon as any conversation exists on any of their listings. |
| any **sender**'s profile | Their messages are removed from threads that otherwise survive, leaving the counterparty holding one side of a dialogue. |

The host case is not new *in kind* — `bookings.location_id` has had the same blocking effect for
hosts with bookings since Phase 6 — but messaging widens the trigger from "has a booking" to "has
a booking **or** a conversation".

**None of this is settled.** The approved direction is not to casually destroy the counterparty's
communication history, and to preserve or anonymise where appropriate — but that is a retention
and erasure policy with legal weight, interacting with account deletion and data-subject erasure
requests. `profiles.status` already carries an unused `'deleted'` value a soft-delete design would
build on. Deliberately deferred: messaging authorization is expressed entirely through RLS
policies and the participant helper, none of which reference a deletion action, so whatever
retention model is approved lands as its own later migration without revisiting any of it.

`conversations.location_id` and `conversations.booking_id` deliberately **do not** cascade, exactly
as `bookings.location_id` and `payments.booking_id` don't: deleting a location or booking that has
conversation history would silently destroy that history. A location with a conversation therefore
cannot be deleted (`23503`), the same shape `locations.service.ts` already maps to a clean `409`
for bookings.

### `is_conversation_participant()`

```sql
public.is_conversation_participant(_conversation_id uuid) returns boolean
```

`SECURITY DEFINER`, `set search_path = public`, `stable` — the same technique as
`public.has_role()` (Phase 1), for the same reason: an ordinary policy cannot join
`conversations → locations` without dragging both of those tables' own RLS into every row check.

It takes **no user id**, on purpose. `has_role()` takes one and every policy passes `auth.uid()`,
which is safe there but leaves a function that will answer about anybody — and any function in
`public` is callable as a PostgREST RPC by anyone holding `EXECUTE`. Reading `auth.uid()`
internally means there is no caller-supplied identity to trust: the worst an attacker can do by
calling it directly is learn whether *they* are in a conversation, which they already know. It
fails closed via an explicit `auth.uid() is not null` guard rather than relying on
null-comparison semantics.

### RLS

RLS is enabled on all four tables, and **no messaging migration grants anything to `anon`** — none
of this data is ever public.

> ⚠️ That is a statement about what these migrations *do*, not about the grants a real database ends
> up with. Supabase ships `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon,
> authenticated, service_role`, so a newly created table in `public` arrives with full privileges
> already granted and a migration's `grant select` is *additive on top of them*. Verified on staging:
> `conversations`, `messages` and `admin_message_access` all carry `GRANT ALL` to both `anon` and
> `authenticated`. **RLS is what actually denies those writes** — these tables have no
> INSERT/UPDATE/DELETE policy, and `anon` matches no policy at all, so such attempts fail as silent
> zero-row no-ops rather than privilege errors. The grant layer is not carrying its share of the
> defence in depth. See the Phase 27-8 note below for the full picture; correcting it across the
> schema is a separate hardening pass in the Phase 12 style.

| Table | `authenticated` | Policy |
|---|---|---|
| `conversations` | `SELECT` only | participant: `booker_id = auth.uid()` **or** the caller hosts `location_id` (the same shape as `bookings_select_own_or_hosted_or_admin`, minus the admin arm) |
| `messages` | `SELECT` only | `is_conversation_participant(conversation_id)` |
| `conversation_reads` | **`SELECT` only** (since Phase 27-7) | select-own + write-own. 27-1 granted `INSERT`/`UPDATE` here, modelling the table on `notification_preferences`; **Phase 27-7 revoked `INSERT`, `UPDATE` and `DELETE`** after measuring that a client could move its own read cursor *backwards*, and delete the row outright, defeating the monotonicity the cursor exists to provide. The `conversation_reads_write_own` policy is deliberately **kept** as dormant defence in depth — its `WITH CHECK` still requires participation *and* (Phase 27-2) that `last_read_message_id` belongs to the same conversation, so those rules are still standing if a future phase ever re-grants. Writes now go exclusively through `public.mark_conversation_read()` |
| `admin_message_access` | `SELECT` only | `has_role(auth.uid(), 'admin')`, mirroring `admin_audit_log_select_admin_only` — accountability across the whole admin team, not a private per-admin log |

`messages` having **no** `INSERT`/`UPDATE`/`DELETE` grant and no policy for any of them is what
makes `sender_id` and `created_at` unforgeable rather than merely validated: a client holding a
real Supabase session cannot fabricate, edit, backdate or delete a message through direct
PostgREST, only read what it is already entitled to. This is the Phase 12 hardening shape applied
from the start rather than retrofitted, and it is verified the same way — against real user
sessions talking to PostgREST, bypassing Express entirely (`tests/messaging-schema.test.ts` and
`tests/messaging-authorization.test.ts`).

Conversations are likewise `SELECT`-only for `authenticated`: creating or re-pointing one requires
checks RLS cannot express (the location must be `published`; a supplied `booking_id` must belong to
the caller *and* to the same location), so it goes through the backend's service-role client.

**Admins get nothing from these policies.** `conversations_select_participant` has no admin arm, so
an admin who is not a participant sees zero conversations and zero messages through their own
scoped client — asserted directly, because it is the property most easily broken by a
well-meaning future edit. Admin access to private correspondence goes through a dedicated Admin
Messaging service that writes an `admin_message_access` record, never through an invisible
widening of an ordinary participant read.

**The read cursor is not an authorization mechanism.** Holding a `conversation_reads` row grants
nothing and its absence denies nothing — participation alone decides access, and a cursor planted
for a non-participant leaves the conversation and its messages just as invisible. Phase 27-2 added
one clause to `conversation_reads_write_own`'s `WITH CHECK`: `last_read_message_id` must belong to
the same conversation as the cursor. Before it, a participant could point their cursor in one
thread at a message in an unrelated one — verified accepted. Low severity (the FK already required
the message to exist, and nothing is disclosed by the write), but the success/`23503` distinction
was a message-existence oracle for a guessed UUID, and a cursor outside its own thread is simply
wrong state for the "new messages" divider it positions. The subquery runs under the caller's own
RLS, so it can only ever match a message they are already entitled to read.

### `get_conversations_for_viewer()` (Phase 27-3)

```sql
public.get_conversations_for_viewer(_cursor_last_message_at timestamptz,
                                    _cursor_id uuid,
                                    _limit integer,
                                    _conversation_id uuid)   -- null = list mode
```

The Inbox read model, backing both `GET /v1/conversations` and `GET /v1/conversations/:id`.
`SECURITY DEFINER`, `set search_path = public`, `stable`, granted to `authenticated` and
`service_role` only — the `PUBLIC` default is explicitly **revoked**, so `anon` cannot call it at
all (a narrow departure from the other functions here, which leave the default in place; an Inbox
has no anonymous use case).

**Why `SECURITY DEFINER` is unavoidable.** The Phase 27-3 inspection probed the local stack with
real participant sessions and found three things that together make an ordinary PostgREST query
unable to render an Inbox row:

1. **A host can never learn the booker's name.** `profiles` RLS is own-row-or-admin, so a host
   selecting the booker's profile gets zero rows — and `get_host_public_profile(booker)` returns
   nothing, because a booker has no published location. There was no existing path at all.
2. **The booker's view of the host's name is conditional.** `get_host_public_profile()` only
   answers while that host still has a published listing, so archiving one silently removes the
   host's name from a thread the booker may still read.
3. **The listing itself disappears once unpublished.** `locations` SELECT RLS restricts a
   non-published row to its owner and admins, and `location_media` follows the parent. Verified: a
   booker in an active conversation about an archived listing still reads the conversation and its
   messages, but an embedded `locations` resolves to `null` — the row loses its title and thumbnail.

Phase 27-2 deliberately keyed conversation access on **participation, not publication**, so that a
thread survives its listing being archived. This function is what makes that surviving thread
renderable. It is the same technique and the same narrow-slice discipline as
`get_host_public_profile()`.

**It is not an authorization bypass.** It returns exactly the set
`conversations_select_participant` already permits — `c.booker_id = auth.uid() or l.host_id =
auth.uid()` — reads `auth.uid()` itself, accepts **no** user id (so it cannot be used to enumerate
anyone else's Inbox), fails closed when `auth.uid()` is null, and has **no admin branch**. Admin
access to correspondence remains the separate, audited `admin_message_access` path.

**What it exposes, and nothing more:** conversation `id`, `booking_id`, `last_message_at`,
`created_at`, `updated_at`, a computed `viewer_role`; listing `id`, `title`, `city`, `status` and
the primary media **storage key**; counterparty `id`, `first_name`, `last_name`, `avatar_url`.
Never phone, email, address, profile status, booking detail, message content, or any other
profile/listing column. Widening it is a security decision, not a convenience one.

Two implementation notes. The media key is returned raw and converted by `publicUrlFor()` in the
service layer, matching `toPublicMediaItem()` and the search module — SQL never builds URLs. And
the `limit` clamp is `101`, not `100`: the user-facing maximum of 100 is enforced in
`messaging.schema.ts`, while the service requests `limit + 1` rows to detect `has_more` without a
second query, so the SQL ceiling is the defensive backstop for a direct RPC caller rather than the
product limit.

### Message APIs (Phase 27-4)

Migration `20260912220000_phase27_4_messages.sql` adds exactly two objects — one trigger function
plus its trigger, and one read function. **No table, column, index, policy or grant changes, and
no new privilege.**

#### `touch_conversation_on_message()` — the last-message cache

An `AFTER INSERT ... FOR EACH ROW` trigger on `messages` that advances
`conversations.last_message_id` / `last_message_at`.

**Why a trigger.** The invariant is *a message exists ⟺ the conversation's cache reflects it*.
This backend has no multi-statement transaction facility at all — only `@supabase/supabase-js`,
where each PostgREST request is one implicit transaction — so the update has to happen inside the
INSERT's own transaction or not atomically at all. Doing it as a second statement from Express
would leave a window where a committed message is invisible in the Inbox list. Same technique as
`enforce_refund_balance_before_insert` (Phase 12).

**Why the `last_message_at <= new.created_at` guard.** Without it the cache can move *backwards*.
Two messages inserted concurrently into one conversation can commit in either order; if the older
one commits second, its trigger would overwrite the newer one's cache and the conversation would
sort to the wrong place in the Inbox. Row-level locking serializes the two UPDATEs, and this
predicate makes the outcome independent of arrival order — the newest message always wins.
Verified against a real out-of-order insert and against five concurrent sends.

`<=` rather than `<` so the very first message still lands: a conversation's `last_message_at`
defaults to `now()` at creation, and a message created in that same transaction would share it.

`updated_at` is deliberately **not** set here — the existing `set_conversations_updated_at` BEFORE
UPDATE trigger already maintains it for any update to the row, including this one. Verified to
advance across separate transactions (it appears not to within a single transaction only because
`now()` is the transaction timestamp).

`SECURITY INVOKER` (the default), matching `set_updated_at()` and `enforce_refund_balance()`.
Every message insert runs through the backend's service-role client, which holds `UPDATE` on
`conversations` and bypasses RLS, and `authenticated` has no INSERT grant on `messages` at all, so
there is no other path in. Non-recursive.

#### `get_conversation_messages()` — message history

```sql
public.get_conversation_messages(_conversation_id uuid,
                                 _cursor_created_at timestamptz,
                                 _cursor_id uuid,
                                 _limit integer)
```

**`SECURITY INVOKER`, `STABLE`, `set search_path = public`.** This is the important difference from
Phase 27-3: `get_conversations_for_viewer()` had to be `SECURITY DEFINER` because ordinary RLS
structurally could not produce an Inbox row. Message history has no such problem — every field the
API returns lives on the `messages` row itself, and `messages_select_participant` already grants
exactly the right rows. **RLS remains the authorization boundary; this function grants nothing and
has no admin branch.** A non-participant, an admin who is not a participant, and an
unauthenticated caller all get zero rows from it.

It exists for one reason: to keep the keyset predicate in typed SQL. Expressing
`created_at < c1 OR (created_at = c1 AND id < c2)` through PostgREST means building an `.or()`
filter *string* containing an ISO timestamp — whose `:`, `.` and `+` are all PostgREST-reserved
characters needing careful quoting. Same shape and reasoning as `search_locations()` (Phase 4),
which is likewise `SECURITY INVOKER` and called via `.rpc()`.

Ordering is `created_at DESC, id DESC` — newest first, an exact match for the **existing**
`messages_conversation_id_created_at_id_idx (conversation_id, created_at DESC, id DESC)` from
Phase 27-1. **No index was added**; the query is a pure index range scan on the one already there.

Returns exactly the six columns of `messages`, which is exactly the public DTO. The `limit` clamp
is `101` for the same reason as `get_conversations_for_viewer()`: the product maximum of 100 lives
in `messaging.schema.ts`, while the service requests `limit + 1` to detect `has_more` without a
second query.

`EXECUTE` is revoked from `PUBLIC` and granted only to `authenticated` and `service_role` —
matching Phase 27-3, though here RLS would filter the rows regardless.

#### Idempotency, unchanged

Message sending relies entirely on the Phase 27-1 constraint
`UNIQUE (conversation_id, sender_id, client_message_id)`. There is no idempotency table and no
application-side dedupe: the service inserts, catches `23505`, and returns the row that already
exists. `sender_id` is in the key deliberately — without it one participant could pick a key
colliding with the other's and be handed the counterparty's message.

### Message cursor index alignment (Phase 27-5)

Migration `20260912230000_phase27_5_message_cursor_index_alignment.sql` — a single
`create or replace function` on `get_conversation_messages()`. No schema, index, trigger, RLS or
grant change, and no change to the function's signature, security mode, results or ordering. The
cursor **wire format is unchanged**, so this is invisible to every client.

Phase 27-4 wrote the keyset predicate in the conventional expanded form —
`_cursor_created_at is null or created_at < _cursor_created_at or (created_at = _cursor_created_at
and id < _cursor_id)`. That is logically correct but PostgreSQL cannot turn an OR-chain into an
index range start condition, so it landed in `Filter`: the scan began at the newest message and
discarded everything down to the cursor. Measured on a 5,000-message conversation at a
4,000-row-deep cursor: `Rows Removed by Filter: 4001`, 86 buffers, against 3 for the first page.
O(offset) — exactly what keyset pagination exists to eliminate.

**The obvious fix does not work**, and this is the part worth remembering. Keeping the null guard
and swapping only the OR-chain for a row comparison plans perfectly with *literal* values, because
the planner folds `'…'::timestamptz is null` to false and drops the branch. But PostgREST invokes
the function with **parameters**, so the generic plan is the one that matters — and there the
branch cannot be folded. Measured under `plan_cache_mode = force_generic_plan`:
`Filter: (($2 IS NULL) OR (ROW(created_at, id) < ROW($2, $3)))`, `Rows Removed by Filter: 4001`,
85 buffers. No better than before.

The fix removes the branch entirely, folding the null case into the comparison with per-type
maximum sentinels:

```sql
(m.created_at, m.id) < (
  coalesce(_cursor_created_at, 'infinity'::timestamptz),
  coalesce(_cursor_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)
)
```

`'infinity'` is greater than every real `timestamptz` and `'ffffffff-…'` is the maximum `uuid`, so
a null cursor compares as "older than everything" and yields the first page. Under the same
generic plan the predicate now appears inside `Index Cond` on the **existing** Phase 27-1
`messages_conversation_id_created_at_id_idx` — 6 buffers at a 4,000-deep cursor, nothing discarded.
**No new index was required.**

Semantics are identical: row comparison `(a, b) < (c, d)` is defined as `a < c or (a = c and
b < d)`, which is the predicate it replaces, and both columns are `NOT NULL` so no
three-valued-logic difference can arise. Verified against the old predicate on a 5,000-message
fixture across all six boundary cases — first page, mid page, a cursor sitting on a four-way
timestamp tie, a cursor past the end, an empty conversation, and a cursor from a different
conversation: **identical row sets in every case**.

`tests/messaging-messages.test.ts` carries the regression guard. It asserts the *structural*
property — the predicate appears in `Index Cond` and not in `Filter` — rather than any timing or
buffer count, because `EXPLAIN` of a call to this function only ever shows `Function Scan` (the
body's `LIMIT` blocks SQL-function inlining) and that node's buffer count folds in first-call
planning and catalog reads.

### Realtime message delivery (Phase 27-6)

Migration `20260912235900_phase27_6_realtime_broadcast.sql`. Four objects, and **no change to any
existing table, column, index, grant, policy or trigger** — and no source-code, API or DTO change.

```
INSERT into public.messages   (service-role, after API authorization)
   ├── on_message_created            → touch_conversation_on_message()   last-message cache (27-4/27-5, UNCHANGED)
   └── on_message_created_broadcast  → broadcast_message_created()       realtime.send() on conversation:<uuid>, private
```

**Why a separate trigger, not an extension of the existing one.**
`touch_conversation_on_message()` maintains a *data invariant*; a broadcast is a *delivery side
effect*. Phase 27-5 showed how subtle that function is (its monotonic guard, its behaviour under
EvalPlanQual re-checks), so leaving it byte-identical preserves that verification. More concretely:
the cache update is **conditional** (`last_message_at <= new.created_at`) and legitimately does
nothing for an out-of-order insert, whereas the broadcast must fire **unconditionally** — two
functions make that impossible to confuse. PostgreSQL fires `AFTER INSERT` triggers in **name
order**, so `on_message_created` runs before `on_message_created_broadcast`: cache first, publish
second.

**Transactional by construction.** `realtime.send()` writes a row into `realtime.messages`, so it
participates in the message INSERT's own transaction: *a message exists ⟺ its event was published*,
and **a rolled-back message produces no event** (verified — the broadcast row is visible inside the
transaction and gone after `rollback`). This is why the publish belongs in a trigger rather than in
Express: the backend has no multi-statement transaction facility, so an API-side publish could
commit a message and then fail to announce it, with no way to undo either.

Conversely `realtime.send()` wraps its own body in `EXCEPTION WHEN OTHERS THEN RAISE WARNING`, so a
Realtime malfunction can never fail a message insert — **and the backend is never told a broadcast
failed.** Client reconciliation against the history endpoint is therefore mandatory (see
`docs/API.md`).

**Broadcast is delivery, not storage.** `realtime.messages` is a **daily-partitioned** table that
Supabase reclaims by dropping partitions. Nothing durable may ever live only there; message content
is persisted in `public.messages` and read back through `GET /v1/conversations/:id/messages`.

#### Authorization

| Object | Role |
|---|---|
| `public.can_access_conversation_topic(_topic text)` | `SECURITY DEFINER`, `STABLE`, `search_path = public`. Parses `conversation:<uuid>` and delegates to `is_conversation_participant()` |
| `messaging_broadcast_participant_select` on `realtime.messages` | **SELECT only**, `authenticated`, `extension = 'broadcast'` + the helper |

`is_conversation_participant()` is **reused, not re-implemented**, so Realtime authorization and API
authorization cannot drift — it is the same predicate `messages_select_participant` uses, it reads
`auth.uid()` internally and accepts no caller-supplied identity.

**Fail-closed topic parsing.** The policy cannot do this inline safely:
`split_part(realtime.topic(), ':', 2)::uuid` **raises** on a malformed topic, and PostgreSQL does
not guarantee `AND` short-circuits, so a regex guard in the same expression is not reliably
protective — and a raise surfaces as a subscribe error rather than a clean deny. The helper is
`plpgsql` with an explicit exception handler, so "malformed" and "not a participant" are the same
answer: `false`. Verified for a null, empty, wrongly-prefixed, prefix-only, malformed-UUID and
injection-shaped topic — all `false`, none raising.

Private channels are **mandatory**: Realtime consults this table's RLS only for channels subscribed
with `private: true`. A non-private channel bypasses it entirely.

No admin arm — an admin who is not a participant is refused exactly like any third party. Admin
access to correspondence remains the separate, audited `admin_message_access` path.

> ### ⚠️ NEVER ADD AN INSERT POLICY TO `realtime.messages`
>
> `authenticated` already holds table-level **INSERT, SELECT and UPDATE grants** on
> `realtime.messages` (Supabase ships them) and already holds `EXECUTE` on `realtime.send()` plus
> `USAGE` on the `realtime` schema. The **only** thing preventing any logged-in user from publishing
> a forged `message.created` event into someone else's conversation is that this table has no INSERT
> policy — RLS with zero matching policies denies everything.
>
> For the same reason: **never create a `public` wrapper around `realtime.send()`.** Clients cannot
> reach it today only because PostgREST exposes `public` and `graphql_public`, not `realtime`. A
> wrapper would hand every authenticated client a publish path.
>
> Both invariants are asserted in `tests/messaging-realtime.test.ts`.

**Not touched:** the `supabase_realtime` publication stays empty (it drives Postgres Changes, which
this phase does not use), no new index, no new grant on the `realtime` schema.

### Read / unread state (Phase 27-7)

The first consumer of `conversation_reads`, which Phase 27-1 created and nothing had ever written
to. Three objects: a monotonic write function, `unread_count` on the conversation read model, and a
grant revocation. No new table, index or trigger, and no Realtime object of any kind.

#### The cursor is `(last_read_at, last_read_message_id)` — one composite value

Both columns are written together and read together. `last_read_at` is the authoritative half;
`last_read_message_id` is the tiebreaker that makes the cursor a **total order** over the same
`(created_at, id)` key messages are indexed and paginated by, and the anchor a client draws its
"new messages" divider at.

**`last_read_at` is the `created_at` of a real message — never `now()`, never client-supplied.**
This is the phase's central correctness property and it was measured, not assumed. A message's
`created_at` is its transaction's start time, so a message whose transaction begins before a
mark-read and commits after it carries an *earlier* timestamp than the wall clock did. A
`now()` cursor therefore marks it read even though it was uncommitted and invisible when the reader
marked read, and it is lost from unread permanently. A cursor derived from a message the reader
could actually see has no such window.

**`last_read_message_id` alone is not sufficient**, which is why both columns exist. It is
`ON DELETE SET NULL`, so deleting the message it points at — what a sender-profile cascade does —
leaves `last_read_at` standing with a null id. Resolving a message-id-only cursor would then find
nothing and flip the whole conversation back to unread. That **half-null** state is legitimate and
reachable, which is why there is deliberately **no CHECK** tying the two columns together and why
every comparison coalesces the two halves independently.

#### `mark_conversation_read(_conversation_id, _message_id)`

`SECURITY DEFINER`, `search_path` pinned, returns `SETOF public.conversation_reads`. Takes **no user
id** — identity is `auth.uid()` read internally — so it cannot move anyone else's cursor, the same
argument-free shape as `is_conversation_participant()`.

It authorizes **independently of Express**, via `is_conversation_participant()`, and writes nothing
for a non-participant, a nonexistent conversation, a nonexistent message, or a message belonging to
another conversation. An admin who is not a participant is refused like any third party; there is no
admin branch, and an admin can never acquire or advance a participant's cursor.

Monotonicity is a compare-and-swap in the `ON CONFLICT DO UPDATE` guard:

```sql
where (excluded.last_read_at, excluded.last_read_message_id)
    > (coalesce(conversation_reads.last_read_at,         '-infinity'::timestamptz),
       coalesce(conversation_reads.last_read_message_id, '00000000-0000-0000-0000-000000000000'::uuid))
```

The `COALESCE` sentinels are load-bearing and are the mirror of Phase 27-5's maximum sentinels.
Without them the comparison against an existing **NULL** cursor evaluates to `NULL` rather than
`true`, `DO UPDATE … WHERE` skips the row, and the user's *first* mark-read is silently discarded —
leaving that thread permanently unread. Measured: the naive form returns `INSERT 0 0` with the
cursor still null.

Under concurrency, `ON CONFLICT DO UPDATE` takes a row lock and re-evaluates its guard against the
**latest committed** row version rather than the transaction's snapshot, so two racing calls cannot
interleave into a backwards move. No `SERIALIZABLE`, no advisory lock, no retry loop. Verified with
real overlapping transactions: the older writer blocked, re-evaluated, and became a no-op.

The function deliberately does **not** `RETURNING` from the upsert. When the guard correctly refuses
an older cursor the statement affects zero rows, and "you asked to mark an older message read" must
still answer with the cursor that stands — so it re-selects.

Two functions are `RETURNS SETOF <table>` rather than `RETURNS TABLE (...)` for a concrete reason: a
`RETURNS TABLE` declares OUT parameters, those become plpgsql variables, and they **shadow** the
identically-named columns — which makes `on conflict (conversation_id, user_id)` fail outright with
*"column reference conversation_id is ambiguous"*, since a conflict target cannot be qualified.

#### `unread_count` on `get_conversations_for_viewer()`

A message is unread for user U when it is in the conversation, `sender_id <> U` (your own messages
are never unread — sending is reading), and its `(created_at, id)` is greater than U's cursor. With
no cursor row, or a null one, the `-infinity`/minimum-uuid sentinels make everything from the
counterparty unread.

**Derived, never stored.** A denormalized counter would mean touching a column on the hot
message-insert path and recomputing on every mark-read — a second source of truth that can drift
from `messages`, which is the authority. Phase 27-1 rejected a denormalized participant table for
the same reason.

**Capped at 100** (`limit 101` inside, then `least(…, 100)`): `100` means "100 or more". The cap is
what bounds the work, not merely the display — an uncapped count is O(unread) per conversation and a
single long unread thread would dominate an entire Inbox page.

The predicate is a **single unconditional row comparison with `COALESCE` sentinels**, exactly the
Phase 27-5 shape, so PostgreSQL can use it as an index **range condition** under a generic
parameterized plan. Measured on a fresh build with 400 conversations / 13,000 messages, under
`plan_cache_mode = force_generic_plan`:

```
Index Cond: ((conversation_id = c.id)
             AND (ROW(created_at, id) > ROW(COALESCE(r.last_read_at, '-infinity'),
                                            COALESCE(r.last_read_message_id, '0000…'))))
```

`Index Cond`, not `Filter`, on the existing `messages_conversation_id_created_at_id_idx`. **No index
was added.** A 20-row page cost 26 buffers / 0.31 ms without the column, 89 / 0.70 ms in the
steady state, and 547 / 1.19 ms with *everything* unread including a 5,020-message thread — the last
two differ by far less than the unread volume does, which is the cap doing its job.

#### `conversation_reads` — `authenticated` writes revoked

Phase 27-1 modelled this table on `notification_preferences` as ordinary self-service, which left it
the **only** messaging table an authenticated client could write. Measured consequences: a client
moved its own cursor **backwards** through a plain authenticated session, and **deleted** its cursor
row outright — which resets the thread to "nothing read", the maximal backwards move. A monotonicity
guarantee living only in Express or only in the function would be bypassed by either.

`INSERT`, `UPDATE` and `DELETE` are therefore revoked from `authenticated`, bringing the table into
line with `conversations` and `messages`. `SELECT` is untouched — a user still reads their own cursor
and nobody else's, which is how a client positions its "new messages" divider. `service_role` is
unaffected.

> ⚠️ **The explicit revokes matter, and `grant select` is not the whole story.** Supabase ships
> `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES/FUNCTIONS TO anon, authenticated,
> service_role`, so a newly created object in `public` arrives with full privileges already granted
> and a migration's `grant select` is *additive on top of them*. Phase 12 knew this and revoked
> explicitly — `bookings` is `rdDxtm` to this day. The Phase 27-1/27-2 migrations did not, so their
> "SELECT only" comments describe an intent the grants did not enforce. RLS still denies those
> writes (the messaging tables have no INSERT/UPDATE/DELETE policies, so they fail as silent
> zero-row no-ops rather than privilege errors), so data integrity was never at risk — but the
> grant layer was not carrying its share. `conversation_reads` was the exception where it mattered,
> because its `FOR ALL` policy *did* permit the DELETE.
>
> The same applies to functions: `REVOKE … FROM public` does **not** remove the **direct** `anon`
> grant that default privileges create. Phase 27-3 and 27-4 revoked only from `PUBLIC`, so `anon`
> has held EXECUTE on those functions in every freshly built database. Phase 27-7 revokes from both
> `public` **and** `anon` on the two functions it owns, and a test asserts the resulting ACL —
> necessary because `DROP FUNCTION` (required to add `unread_count`, since PostgreSQL cannot change
> a `RETURNS TABLE` return type in place) discards the ACL entirely.

The `conversation_reads_write_own` policy is deliberately **kept** even though no reachable write
can now reach it: RLS is consulted only once a table-level grant is held, so if a future phase ever
re-grants `INSERT`/`UPDATE`, the participation check and the Phase 27-2 clause requiring the cursor
to point *into* its own conversation are still standing rather than silently absent.

#### No Realtime read event

Decision D-6. `message.created` remains the only messaging Realtime event, and
`conversation_reads` carries no broadcast trigger. Unread is derived from durable rows, so a missed
or duplicated event cannot corrupt it and no reconciliation protocol of its own is needed.
Broadcasting read state would only enable read receipts, which changes the privacy model — one
participant's read state becoming visible to the other — and is a product decision in its own right,
not something to acquire as a side effect of unread counts.

### Message notifications (Phase 27-8)

Messaging reuses the Phase 8 notification system wholesale — the provider, `user_devices`, the
preference gate, `notification_delivery_attempts`, and the iOS token lifecycle from Phase 26-K all
already existed. **The only schema change is three widened CHECK constraints**, which is what the
27-8 inspection found actually blocked a message notification (proven by attempting the inserts,
not by reading the DDL):

| Constraint | Before | After |
|---|---|---|
| `notifications_type_check` | 7 booking/payment types | `+ new_message` |
| `notifications_entity_type_check` | `in ('booking')` | `in ('booking','conversation')` |
| `notification_preferences_category_check` | `in ('booking','payment')` | `+ message` |

Each is purely widening, so no existing row can be invalidated and no backfill is needed. Because a
missing preference row means **enabled**, adding the `message` category opted every existing user in
without touching a single row.

No new table, index, trigger, policy or grant. No foreign key from `notifications.entity_id` to
`conversations.id` — it has always been a bare uuid (it points at bookings with no FK either), and
adding one would let a deleted conversation either block the delete or erase the notification
history describing it, the same conclusion Phase 27-2 reached for `admin_message_access`.

#### Where the notification happens, and why not in a trigger

```
POST /v1/conversations/:id/messages
  └─ INSERT messages                          ← DURABLE, authoritative
       ├─ on_message_created            → last-message cache        (27-4)
       └─ on_message_created_broadcast  → Realtime message.created  (27-6)
  └─ notifyNewMessage()                       ← AFTER commit, in the service layer
```

The two triggers are inside the insert's transaction because both maintain state that must commit
with the message. **The push deliberately is not.** It is an outbound call to Apple: it cannot join
a Postgres transaction, a slow or failed response must never hold or roll back a stored message, and
a trigger cannot make an HTTPS request at all without new infrastructure. It is also **awaited**
rather than fire-and-forget, because a serverless function may be frozen the moment it responds.

`notifyNewMessage()` routes through `safeNotify()` like every other notification helper, so the
invariant is unconditional: **a message is durable whether or not anyone was ever told about it.**
A lost push is recoverable because the client reconciles against the history endpoint anyway (the
Phase 27-6 contract).

#### Recipient and idempotency

The recipient is *computed* as the participant who is not the sender — the host when the booker
sends, the booker when the host sends — so a sender cannot be notified of their own message by any
code path. `conversations` does not store the host; it is derived through `locations.host_id`, which
has had no `authenticated` grant since Phase 12, so resolution goes through the service-role client.
That is necessary rather than convenient: a host frequently cannot read a booker's profile at all
(Phase 27-3).

`source_event_id` is `message:<message_id>:new_message` — keyed on the **message**, not the
conversation. The documented convention is `<trigger>:<trigger id>:<type>`, and the trigger is the
message; `notifyPaymentSuccess` has always keyed on `payment:<payment_id>:…` while its entity is the
booking. Keying on the conversation instead would collapse an entire thread into **one notification,
forever** — under `UNIQUE (user_id, source_event_id)` the second message would be a silent no-op.
This composes with Phase 27-4's send idempotency: a retried `POST` returns the same message id, so
it yields the same key.

#### Privacy

The push carries the sender's **name** and a fixed body. It never carries message text — the notify
function receives a message *id*, not the body, so a leak is prevented by the signature rather than
by remembering. A push is rendered on a locked screen and mirrored to paired devices, and ProdBnb
messages carry rates, addresses, schedules and client names. This is the same deliberately generic
copy Phase 8 chose for bookings and payments.

#### Per-device APNs environment (Phase 27-8)

An APNs token belongs to exactly one environment, decided by the `aps-environment` entitlement in
the build that produced it, and iOS records which in `user_devices.environment`. Before this phase
that value was passed to the provider and **ignored** — every push went to whatever
`APNS_ENVIRONMENT` said. Harmless while only sandbox exists; a real bug the moment production tokens
appear, because one user can hold a TestFlight (sandbox) and an App Store (production) token
simultaneously and a single fan-out must reach both. Sending a token to the wrong host returns
`DeviceTokenNotForTopic`, which the provider classifies as `invalid_token` — so the old behaviour
would have **deactivated a perfectly good device**.

The host is now chosen per send, falling back to the configured default when a device recorded no
environment, so every pre-existing device behaves exactly as before. **Production remains
unconfigured**: `APNS_ENVIRONMENT` still accepts only `sandbox` and no production credentials exist.
Only the host constant was added.

#### Delivery failures are isolated per device

The fan-out loop body was previously unguarded, so a failed `notification_delivery_attempts` INSERT
threw, unwound to `safeNotify()`, and every device **later in the list** silently received nothing —
nothing user-visible broke, which is what made it hard to notice. Each iteration is now wrapped:
logging is best-effort, deactivation is best-effort, and one device's bookkeeping failure can no
longer suppress another device's push. Messaging is what makes multi-device fan-out routine rather
than rare.

### Deliberately absent in V1

No conversation status/state machine, no message `kind`/`type` column, no `messages.updated_at`, no
attachments, no system messages, no support conversations, no group threads, no read receipts, and
no per-message read flag (read state is a per-user cursor — see Phase 27-7 above). There is also no index on `messages.sender_id`, `conversations.booking_id`,
`conversations.last_message_id` or `conversation_reads.last_read_message_id`: each is a FK whose
parent-side delete therefore scans, but bookings and messages are never hard-deleted by any code
path, and profile deletion is a rare administrative operation rather than a request path. Recorded
as a decision, not an oversight.

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
