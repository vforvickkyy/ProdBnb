# API

Base path: `/v1` (except `/health`). All request/response bodies are JSON.

## Conventions

- **Field naming**: `snake_case` everywhere in JSON, matching the columns in Postgres. No
  case-conversion layer.
- **Timestamps**: ISO-8601 strings (`created_at`, `updated_at`), e.g. `"2026-09-03T12:00:00Z"`.
- **Authentication**: `Authorization: Bearer <supabase_access_token>` on every request that
  requires it. The token comes from the client's own Supabase Auth sign-in — this backend never
  issues tokens itself.
- **IDs**: stable UUIDs (Postgres `uuid`, same value as the Supabase Auth user ID for a profile).

### Success envelope

```json
{ "data": { "...": "..." } }
```

A paginated list additionally includes `meta`:

```json
{
  "data": [ { "...": "..." } ],
  "meta": { "page": 1, "pageSize": 20, "total": 42 }
}
```

### Error envelope

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request body.",
    "details": { "...": "optional, e.g. zod field errors" }
  }
}
```

| HTTP status | `code` | Meaning |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Request body/query/params failed validation |
| 401 | `UNAUTHENTICATED` | Missing, malformed, or invalid/expired bearer token |
| 403 | `FORBIDDEN` | Authenticated, but lacks the required role/permission |
| 404 | `NOT_FOUND` | No matching resource or route |
| 409 | `CONFLICT` | Request conflicts with current state (e.g. role already held) |
| 500 | `INTERNAL_ERROR` | Unexpected server error — message is generic; details are logged server-side only, never returned to the client |

### Pagination

Offset-based via query params, demonstrated on `GET /v1/admin/users`:

`?page=1&pageSize=20` (defaults: `page=1`, `pageSize=20`, max `pageSize=100`) →
`meta: { page, pageSize, total }` alongside `data`.

## Endpoints

### `GET /health`

No authentication. Liveness check.

```json
{ "data": { "status": "ok" } }
```

### `GET /v1/me`

Requires authentication. Returns the caller's profile and the marketplace roles they hold.

```json
{
  "data": {
    "profile": {
      "id": "b1f2...",
      "first_name": "Alex",
      "last_name": "Producer",
      "avatar_url": null,
      "status": "active",
      "created_at": "2026-09-01T12:00:00Z",
      "updated_at": "2026-09-01T12:00:00Z"
    },
    "roles": ["booker", "host"]
  }
}
```

### `PATCH /v1/me`

Requires authentication. Updates the caller's own profile. Only `first_name`, `last_name`, and
`avatar_url` are accepted — any other field (including `status`) is rejected as a validation
error, and the database's own column grants would refuse it even if it weren't. At least one
field is required.

Request:

```json
{ "first_name": "Alex", "last_name": "Producer" }
```

Response: `{ "data": { "profile": { "...": "updated profile" } } }`

### `POST /v1/me/roles`

Requires authentication. Self-assigns a marketplace role.

Request: `{ "role": "booker" }` (`"booker"` or `"host"` — `"admin"` is rejected with `403`,
see [`docs/DATABASE.md`](DATABASE.md#granting-the-admin-role))

Response (`201`): `{ "data": { "roles": ["booker"] } }`

- `409 CONFLICT` if the caller already holds the role.
- `403 FORBIDDEN` if `role` is `"admin"`.

### `DELETE /v1/me/roles/:role`

Requires authentication. Removes a role the caller self-assigned (`booker` or `host`).

Response (`200`): `{ "data": { "roles": ["host"] } }`

- `404 NOT_FOUND` if the caller doesn't hold that role.
- `403 FORBIDDEN` for `:role = admin` (not removable via self-service).

### `GET /v1/admin/users`

Requires authentication **and** the `admin` role. Lists every profile — proves the
admin-authorization foundation end-to-end (gated by `requireRole`, backed by the
`profiles_select_own_or_admin` RLS policy rather than a service-role bypass).

Query: `?page=1&pageSize=20`

Response: `{ "data": [ { "...": "profile" } ], "meta": { "page": 1, "pageSize": 20, "total": 2 } }`

- `403 FORBIDDEN` if the caller doesn't hold the `admin` role.

### `GET /v1/locations` — search & discovery

No authentication. The public marketplace discovery feed — always `status = published` only,
regardless of whether the caller happens to be signed in (a host's own drafts never leak into
this feed). Text search, geographic search, and filters (Phase 4) all live on this one endpoint
— see [`docs/DATABASE.md`](DATABASE.md#search--discovery-phase-4) for how it's implemented
(PostgreSQL full-text + PostGIS, one `search_locations()` function, no external search engine).

**Query parameters** (all optional, all combinable):

| Param | Notes |
|---|---|
| `search` | Full-text search over title/city/description (title weighted highest). Tolerant of normal typed queries, e.g. `search=modern loft london`. |
| `city`, `region`, `country` | Case-insensitive exact match. |
| `category_ids`, `use_case_ids` | Comma-separated UUIDs (from `GET /v1/categories`/`/v1/use-cases`) — matches **any** of the given ids. |
| `amenity_ids` | Comma-separated UUIDs (from `GET /v1/amenities`) — matches **all** of the given ids (a location must have every one). |
| `capacity_min`, `capacity_max` | Positive integers; `capacity_min` must be ≤ `capacity_max`. |
| `lat`, `lng` | Must be provided together. Annotates each result with `distance_km` and enables `sort=nearest`. |
| `radius_km` | Optional add-on to `lat`/`lng` (≤500) — restricts results to within that radius; without it, `lat`/`lng` alone just annotates/sorts by distance with no cutoff. |
| `north`, `south`, `east`, `west` | Map-viewport bounding box — all four required together or none. `north` must be `>` `south`, `east` must be `>` `west` (bounding boxes crossing the antimeridian aren't supported). |
| `sort` | `newest` \| `relevant` (default) \| `nearest`. `relevant` behaves like `newest` when no `search` term is given (no other relevance signal exists yet). `nearest` requires `lat`+`lng`. |
| `page`, `pageSize` | Same convention as every other list endpoint — `pageSize` capped at 100 (`400` if exceeded, not silently capped). |

**Response** — a compact card per result, intentionally smaller than the detail endpoint's
object (no `host_id`, `status`, address lines, or full media list):

```json
{
  "data": [
    {
      "id": "6e2c...",
      "title": "East London Film Studio",
      "excerpt": "A versatile studio with natural light for shoots.",
      "city": "London",
      "region": "Greater London",
      "country": "UK",
      "latitude": 51.5285,
      "longitude": -0.0775,
      "capacity": 40,
      "categories": [{ "id": "...", "name": "Studio" }],
      "use_cases": [{ "id": "...", "name": "Film" }],
      "primary_media_url": "https://media.prodbnb.com/locations/6e2c.../a1b2.../original",
      "created_at": "2026-09-03T12:00:00Z",
      "distance_km": 1.4
    }
  ],
  "meta": { "page": 1, "pageSize": 20, "total": 12 }
}
```

`excerpt` is `description` truncated to 240 characters. `primary_media_url` is `null` if the
location has no media yet. `distance_km` is only present when `lat`/`lng` were supplied.

**Examples**

```
GET /v1/locations?search=villa
GET /v1/locations?city=Mumbai
GET /v1/locations?category_ids=9c1e...
GET /v1/locations?city=Mumbai&capacity_min=20
GET /v1/locations?lat=19.0596&lng=72.8295&radius_km=10
GET /v1/locations?north=19.2&south=18.9&east=73.0&west=72.7
GET /v1/locations?lat=19.0596&lng=72.8295&sort=nearest
```

- `400 VALIDATION_ERROR` for any out-of-range coordinate, an over-limit `radius_km`, a partial
  bounding box, `north <= south`/`east <= west`, `capacity_min > capacity_max`, `sort=nearest`
  without coordinates, an invalid UUID in a tag filter, or an oversized `pageSize`.

Full location detail (host info, all media, full description) is still `GET
/v1/locations/:id`, unchanged by this phase.

### `GET /v1/locations/:id`

Optional authentication. A `published` location is visible to anyone; any other status is
visible only to the owning host or an admin — otherwise `404` (existence isn't revealed).

```json
{
  "data": {
    "id": "6e2c...",
    "host_id": "b1f2...",
    "title": "East London Film Studio",
    "description": "A versatile studio space.",
    "address_line1": null,
    "address_line2": null,
    "city": "London",
    "region": null,
    "country": "UK",
    "postal_code": null,
    "latitude": 51.5285,
    "longitude": -0.0775,
    "capacity": 40,
    "timezone": "Europe/London",
    "status": "published",
    "created_at": "2026-09-03T12:00:00Z",
    "updated_at": "2026-09-03T12:00:00Z",
    "categories": [{ "id": "...", "name": "Studio" }],
    "amenities": [{ "id": "...", "name": "Parking" }],
    "use_cases": [{ "id": "...", "name": "Film" }],
    "media": [
      { "id": "...", "media_type": "photo", "url": "https://media.prodbnb.com/locations/6e2c.../a1b2.../original", "position": 0, "created_at": "...", "updated_at": "..." }
    ],
    "host": { "id": "b1f2...", "first_name": "Alex", "last_name": "Producer", "avatar_url": null }
  }
}
```

`host` is `null` until that host has at least one `published` location — see
[`docs/DATABASE.md`](DATABASE.md#get_host_public_profile). Each `media` item exposes a computed
`url`, never the internal `storage_key` — see the media endpoints below for how it gets there.

### `POST /v1/locations`

Requires authentication **and** the `host` role. Creates a location as `status = "draft"` —
`status` cannot be set at creation. Accepts every field from the detail response except
`id`/`host_id`/`status`/timestamps/`categories`/`amenities`/`use_cases`/`media`/`host`, plus
optional `category_ids`/`amenity_ids`/`use_case_ids` (arrays of UUIDs from
`GET /v1/categories`/`/v1/amenities`/`/v1/use-cases`). `timezone` (Phase 5) is an IANA identifier
(e.g. `"Asia/Kolkata"`, never an abbreviation like `IST`) — defaults to `"UTC"` if omitted, and
is what every availability window (`GET /v1/locations/:id/availability`) is interpreted against.

Request:

```json
{
  "title": "East London Film Studio",
  "description": "A versatile studio space.",
  "city": "London",
  "country": "UK",
  "latitude": 51.5285,
  "longitude": -0.0775,
  "capacity": 40,
  "category_ids": ["..."],
  "amenity_ids": ["..."],
  "use_case_ids": ["..."]
}
```

Response (`201`): the full detail object, as above.

- `400 VALIDATION_ERROR` for a missing/invalid field, or a `category_id`/`amenity_id`/`use_case_id`
  that doesn't exist.
- `403 FORBIDDEN` if the caller doesn't hold the `host` role.

### `PATCH /v1/locations/:id`

Requires authentication. The owning host or an admin may update any of the same fields `POST`
accepts, plus `status` — all optional, at least one required. `host_id` can never be set through
this endpoint.

**Ownership vs. existence**: if the location isn't visible to the caller at all, `404`. If it's
visible (e.g. published) but not owned and the caller isn't admin, `403`.

**Status transitions**: a host may only request `draft → submitted` or `published → archived` —
anything else is `403`. `→ submitted` additionally requires `title`, `description`, `city`,
`country`, `latitude`, and `longitude` to already be set (on the row or in the same request), or
`400`. An admin may set any of the 8 statuses freely.

Response (`200`): the full detail object.

### `DELETE /v1/locations/:id`

Requires authentication. Owning host or admin only — same 404-vs-403 rule as `PATCH`. Hard
delete (cascades to this location's category/amenity/use-case/media rows).

Response (`200`): `{ "data": { "id": "6e2c...", "deleted": true } }`

### `GET /v1/me/locations`

Requires authentication. Every location the caller owns, any status (the host's own dashboard
view — as opposed to `GET /v1/locations`, which is always published-only).

Query: `?page=1&pageSize=20`

### `GET /v1/admin/locations`

Requires authentication **and** the `admin` role. Every location regardless of status —
the review queue.

Query: `?page=1&pageSize=20&status=submitted` (`status` optional, one of the 8 lifecycle values)

### `GET /v1/categories`, `GET /v1/amenities`, `GET /v1/use-cases`

No authentication. The full lookup list for each, `{ "data": [ { "id": "...", "name": "..." } ] }`.
No write endpoint — see [`docs/DATABASE.md`](DATABASE.md#categories--amenities--use_cases).

## Media (Cloudflare R2 — Phase 3)

Binary files are never routed through this backend — see
[`docs/DATABASE.md`](DATABASE.md#media-storage-phase-3-cloudflare-r2) for the full architecture.
Every endpoint below requires the caller to own `:id` or be admin, using the same 404-vs-403 rule
as `PATCH`/`DELETE /v1/locations/:id`.

### `POST /v1/locations/:id/media/upload`

Requires authentication (owner or admin). Requests authorization for a direct-to-R2 upload —
does **not** write anything to the database yet.

Request: `{ "media_type": "photo", "content_type": "image/jpeg", "size_bytes": 2048576 }`
(`media_type` is `"photo"` or `"video"`; `content_type` must be one of the allowed types for
that `media_type`; `size_bytes` must be within the configured limit.)

Response (`201`) — **only temporary, safe information, nothing else**:

```json
{
  "data": {
    "media_id": "a1b2...",
    "upload_url": "https://<account>.r2.cloudflarestorage.com/<bucket>/locations/6e2c.../a1b2.../original?X-Amz-...",
    "method": "PUT",
    "headers": { "Content-Type": "image/jpeg", "Content-Length": "2048576" },
    "expires_at": "2026-09-03T12:15:00Z"
  }
}
```

The client then issues a raw `PUT` to `upload_url` with **exactly** those headers and the file
bytes as the body — the URL's signature only validates if the actual request matches.

- `400 VALIDATION_ERROR` for a disallowed `content_type`/`media_type` pairing or an over-limit
  `size_bytes`.

### `POST /v1/locations/:id/media/:mediaId/complete`

Requires authentication (owner or admin). Call this after the `PUT` above succeeds. The backend
verifies directly with R2 that the object exists (never trusts the client's word for it) before
recording it.

Request: `{ "position": 0 }` (optional — defaults to appended-at-the-end)

Response (`201`): `{ "data": { "id": "a1b2...", "media_type": "photo", "url": "https://...", "position": 0, "created_at": "...", "updated_at": "..." } }`

- `404 NOT_FOUND` if nothing has actually been uploaded to the expected object yet.
- `400 VALIDATION_ERROR` if the uploaded object's real content-type/size don't pass validation.

### `GET /v1/locations/:id/media`

Optional authentication — same visibility as `GET /v1/locations/:id` (published is public,
otherwise owner/admin only). Returns the location's media, ordered by `position`.

### `PATCH /v1/locations/:id/media/:mediaId`

Requires authentication (owner or admin). Only `{ "position": <integer> }` is accepted — nothing
else about a media item is mutable after creation. Sets the raw position; it does not
automatically renumber sibling items, so a clean reorder means patching every item that moved.

### `DELETE /v1/locations/:id/media/:mediaId`

Requires authentication (owner or admin). Deletes the R2 object and the metadata row.

Response (`200`): `{ "data": { "id": "a1b2...", "deleted": true } }`

## Availability & Calendar (Phase 5)

**Availability is not booking** — nothing here reserves a slot; it only answers "is this
location available at this time?" See
[`docs/DATABASE.md`](DATABASE.md#availability--calendar-phase-5) for the full architecture
(weekly schedules, date overrides, blocked periods, precedence, and timezone handling).

Every management endpoint below (everything except the first) requires the caller to own `:id`
or be admin, using the same 404-vs-403 rule as the rest of the API.

### `GET /v1/locations/:id/availability`

Optional authentication — same visibility as `GET /v1/locations/:id` (published is public,
otherwise owner/admin only). Computed availability windows for a date range.

Query: `?from=2026-10-10&to=2026-10-15` (both required; `to` must not be before `from`; the
range is capped at 90 days)

```json
{
  "data": [
    { "date": "2026-10-10", "windows": [{ "start": "2026-10-10T09:00:00+05:30", "end": "2026-10-10T18:00:00+05:30" }] },
    { "date": "2026-10-11", "windows": [] }
  ],
  "meta": { "from": "2026-10-10", "to": "2026-10-15", "timezone": "Asia/Kolkata" }
}
```

One entry per requested date, even fully-unavailable ones (`windows: []`), so a client can
render a full calendar grid without inferring gaps. Timestamps are absolute (real UTC offset) —
unambiguous regardless of which timezone the requesting device is in. `meta.timezone` is the
location's own IANA timezone (see `PATCH /v1/locations/:id`, which now also accepts a
`timezone` field — defaults to `"UTC"` if never set).

- `400 VALIDATION_ERROR` for a malformed date, `to` before `from`, or a range over 90 days.
- `404 NOT_FOUND` if the location doesn't exist or isn't visible to the caller.

### Weekly rules — `.../availability/rules`

`GET`/`POST /v1/locations/:id/availability/rules`, `PATCH`/`DELETE .../rules/:ruleId`.

```json
{ "day_of_week": "monday", "start_time": "09:00", "end_time": "18:00" }
```

`day_of_week` is `sunday`..`saturday`. Times are wall-clock, interpreted in the location's own
timezone. Half-open `[start, end)` — `end_time` must be strictly after `start_time`; overnight
windows (`22:00`–`02:00`) aren't supported and are rejected. A location can have multiple windows
on the same day (e.g. `09:00–12:00` and `14:00–18:00`), but they can't overlap each other.

- `409 CONFLICT` if the window overlaps an existing rule for that day.

### Date overrides — `.../availability/overrides`

`GET`/`POST /v1/locations/:id/availability/overrides`, `PATCH`/`DELETE .../overrides/:overrideId`.

An override **replaces** that date's weekly schedule entirely, rather than merging with it.

```json
{ "date": "2026-10-05", "status": "unavailable" }
{ "date": "2026-10-11", "status": "available", "start_time": "10:00", "end_time": "14:00" }
```

`status: "unavailable"` is always a full-day closure — it can't carry `start_time`/`end_time`.
`status: "available"` must always specify both (there's no "same hours as normal" shorthand —
ambiguous on a day with no base rule at all). `date` is immutable once created — delete and
recreate to move an override to a different date.

- `409 CONFLICT` if an override already exists for that date.

### Blocked periods — `.../blocks`

`GET`/`POST /v1/locations/:id/blocks`, `PATCH`/`DELETE .../blocks/:blockId`.

```json
{ "start_at": "2026-10-05T13:00:00+05:30", "end_at": "2026-10-05T15:00:00+05:30", "reason": "Owner using property" }
```

`start_at`/`end_at` are absolute timestamps (can span multiple days). `reason` is optional and
**private** — it's only ever visible through these management endpoints (owner/admin), never
through the public `GET .../availability` response, and this table has no public read access at
all (not even indirectly via a raw REST call with the anon key).

- `409 CONFLICT` if the period overlaps an existing block for this location.

## What's intentionally not here yet

Bookings, payments, reviews, messaging, notifications, and availability-aware search are later
phases — see the main project brief. `GET /v1/locations` (search) does not filter by
availability yet; a client currently checks a candidate location's availability separately via
`GET /v1/locations/:id/availability`. Video transcoding, image processing, and AI analysis remain
out of scope for the R2 integration.
