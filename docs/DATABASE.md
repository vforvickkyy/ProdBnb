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

### Phase 7 extension point: payment is a separate concept, not built yet

No `payment_status` column exists in this phase — not even an empty placeholder. Booking
`status` (lifecycle: requested/confirmed/cancelled/completed/rejected) and payment status are
kept as entirely separate concerns simply by both existing as independent column sets rather
than one conflated enum; Phase 7 will add its own `payment_status`, transaction ID, provider, and
refund columns to `bookings` without touching anything documented above. Booking creation in
this phase never depends on any external payment API.

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
