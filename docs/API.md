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

> **One documented exception: the messaging module.** `GET /v1/conversations` (Phase 27-3) and
> `GET /v1/conversations/:id/messages` (Phase 27-4) use **keyset (cursor) pagination** —
> `?limit=&cursor=` → `meta: { limit, has_more, next_cursor }`, with no `total`. Both share one
> opaque `(timestamp, id)` cursor codec (`src/modules/messaging/cursor.ts`), and both order
> descending with `id` breaking timestamp ties. Unlike every other list here, a conversation list
> *reorders while you page* — a new message moves a thread to the head — and message history grows
> at the head, so offset paging would hand a client duplicates and skip rows. See the Messaging
> sections below for the full rationale. Every other endpoint in this document remains
> offset-paginated.

## Endpoints

### `GET /health`

No authentication. Liveness check — unconditional, does not check Supabase connectivity.

```json
{ "data": { "status": "ok" } }
```

### `GET /health/ready`

No authentication. Readiness check (Phase 13) — confirms real Supabase connectivity, bounded to
3s. On Vercel this is a manual/external-monitoring check rather than a platform-enforced deploy
gate (Vercel promotes on successful build, not a runtime probe) — see `docs/PRODUCTION_RUNBOOK.md`.

```json
{ "data": { "status": "ready" } }
```

`503` (`{ "error": { "code": "SERVICE_UNAVAILABLE", "message": "Not ready to accept traffic." } }`)
if the connectivity check fails or times out — never leaks the underlying error/connection detail.

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
      "phone": "+91 98765 43210",
      "address_line1": "12 Hill Road",
      "address_line2": null,
      "address_city": "Mumbai",
      "address_region": "Maharashtra",
      "address_country": "India",
      "address_postal_code": "400050",
      "status": "active",
      "created_at": "2026-09-01T12:00:00Z",
      "updated_at": "2026-09-01T12:00:00Z"
    },
    "roles": ["booker", "host"]
  }
}
```

### `PATCH /v1/me`

Requires authentication. Updates the caller's own profile. Accepted fields:

| Field | Type | Notes |
|---|---|---|
| `first_name` | string, 1–100 | |
| `last_name` | string, 1–100 | |
| `avatar_url` | URL or `null` | |
| `phone` | string, 5–32, or `null` | Phase 26-MB |
| `address_line1` | string, 1–200, or `null` | Phase 26-MB |
| `address_line2` | string, 1–200, or `null` | Phase 26-MB |
| `address_city` | string, 1–120, or `null` | Phase 26-MB |
| `address_region` | string, 1–120, or `null` | Phase 26-MB |
| `address_country` | string, 1–120, or `null` | Phase 26-MB |
| `address_postal_code` | string, 1–20, or `null` | Phase 26-MB |

Any other field (including `status` and `email`) is rejected as a validation error, and the
database's own column grants would refuse it even if it weren't. At least one field is required.

**Partial by design.** Omit a field to leave it alone; send an explicit `null` to clear it. An
empty string is a validation error rather than a silent clear, so an accidentally-blank form field
can't erase stored data.

**Phone validation is deliberately international.** It accepts digits plus the punctuation people
actually type (`+ ( ) - . ` and spaces), requires at least five digits, and permits `+` only at the
start. It is stored exactly as entered apart from trimming — no E.164 normalisation, so a user
reads back what they typed. This is intentionally *not* the `/^\d{10}$/` rule in
`payment.schema.ts`, which is Cashfree's India-only requirement for an order payload.

`phone` is the profile's own field and is **not** synchronised with `auth.users.phone`, which is
only populated by the phone-OTP sign-in flow and so is absent for email, Apple and Google users.

Request:

```json
{ "first_name": "Alex", "last_name": "Producer", "phone": "+91 98765 43210" }
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
    "instant_booking_enabled": false,
    "status": "published",
    "created_at": "2026-09-03T12:00:00Z",
    "updated_at": "2026-09-03T12:00:00Z",
    "categories": [{ "id": "...", "name": "Studio" }],
    "amenities": [{ "id": "...", "name": "Parking" }],
    "use_cases": [{ "id": "...", "name": "Film" }],
    "media": [
      { "id": "...", "media_type": "photo", "url": "https://media.prodbnb.com/locations/6e2c.../a1b2.../original", "position": 0, "created_at": "...", "updated_at": "..." }
    ],
    "host": { "id": "b1f2...", "first_name": "Alex", "last_name": "Producer", "avatar_url": null },
    "booking_options": [
      { "type": "hourly", "amount_minor_units": 10000, "currency": "INR" },
      { "type": "half_day", "amount_minor_units": 30000, "currency": "INR" },
      { "type": "day", "amount_minor_units": 40000, "currency": "INR" },
      { "type": "multi_day", "amount_minor_units": 15000, "currency": "INR" }
    ]
  }
}
```

`host` is `null` until that host has at least one `published` location — see
[`docs/DATABASE.md`](DATABASE.md#get_host_public_profile). Each `media` item exposes a computed
`url`, never the internal `storage_key` — see the media endpoints below for how it gets there.
`booking_options` (Phase 6A) lists only the location's *active* `location_pricing` rows — see
[`docs/DATABASE.md`](DATABASE.md#booking-types--pricing-phase-6a) and the pricing endpoints
below; it can be empty if the host hasn't configured any pricing yet, in which case the location
is visible but not yet bookable.

### `POST /v1/locations`

Requires authentication **and** the `host` role. Creates a location as `status = "draft"` —
`status` cannot be set at creation. Accepts every field from the detail response except
`id`/`host_id`/`status`/timestamps/`categories`/`amenities`/`use_cases`/`media`/`host`/
`booking_options`, plus optional `category_ids`/`amenity_ids`/`use_case_ids` (arrays of UUIDs
from `GET /v1/categories`/`/v1/amenities`/`/v1/use-cases`). `timezone` (Phase 5) is an IANA
identifier (e.g. `"Asia/Kolkata"`, never an abbreviation like `IST`) — defaults to `"UTC"` if
omitted, and is what every availability window (`GET /v1/locations/:id/availability`) is
interpreted against. `instant_booking_enabled` (default `false`) skips host approval when set.
Pricing is **not** set at location creation (or via `PATCH`) — it's configured afterward via the
`location_pricing` endpoints below, one `booking_type` at a time — see
[`docs/DATABASE.md`](DATABASE.md#booking-types--pricing-phase-6a).

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

Response (`201`) on the call that records the row; **`200`** for an idempotent replay of a media id
already recorded against this location, returning that row exactly as first stored (no second R2
check, no position change, no timestamp touched):
`{ "data": { "id": "a1b2...", "media_type": "photo", "url": "https://...", "position": 0, "created_at": "...", "updated_at": "..." } }`

Appending is concurrency-safe (Phase 29.5): the next position is resolved and the row inserted under
a per-location lock, so two uploads completing at the same moment cannot be given the same position.

- `404 NOT_FOUND` if nothing has actually been uploaded to the expected object yet, **or** if the
  media id is already recorded against a different location — deliberately the same response body in
  both cases, so a media id cannot be probed for existence.
- `400 VALIDATION_ERROR` if the uploaded object's real content-type/size don't pass validation.

### `GET /v1/locations/:id/media`

Optional authentication — same visibility as `GET /v1/locations/:id` (published is public,
otherwise owner/admin only). Returns the location's media, ordered by `position`.

### `PUT /v1/locations/:id/media/order`

Requires authentication (owner or admin). **The supported way to reorder a gallery.**

Request: `{ "ordered_ids": ["a1b2...", "c3d4...", "e5f6..."] }`

`ordered_ids` must be the gallery's **complete** order — every photo in it, exactly once. The
backend owns the renumbering: it renumbers to exactly `0..n-1` in the order given, in one
transaction, and returns the resulting rows. Nothing is ever left partially renumbered, and the
response cannot disagree with what was committed. Sending the same list twice is a no-op.

Response (`200`): the location's media in the new order, with positions `0..n-1`.

- `400 VALIDATION_ERROR` if `ordered_ids` omits a photo, repeats one, contains an id that does not
  belong to this gallery, is empty, or exceeds 100 ids (a request-size guard, not a limit on how
  many photos a location may have). The "unknown id" message deliberately does not reveal whether
  that id exists somewhere else.
- `404 NOT_FOUND` if the location isn't visible to the caller; `403 FORBIDDEN` if it is visible but
  not theirs.

> **Removed in Phase 29.5:** `PATCH /v1/locations/:id/media/:mediaId`, which set one item's raw
> position and renumbered no siblings. Expressing even a two-item swap took two requests and left
> the gallery on a duplicate position in between. It now returns `404 NOT_FOUND` like any other
> unknown route. There is deliberately no single-item replacement — use the atomic reorder above.

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

## Location pricing (Phase 6A)

A location doesn't accept bookings of a given type until pricing for that `booking_type` has
been configured — see [`docs/DATABASE.md`](DATABASE.md#booking-types--pricing-phase-6a) for the
full model (the four types, the half-day duration setting, and how `day`/`multi_day` derive their
reserved interval from real availability). Every write endpoint below requires the caller to own
`:id` or be admin, the same 404-vs-403 rule as `PATCH`/`DELETE /v1/locations/:id`.

### `GET /v1/locations/:id/pricing`

Optional authentication — same visibility as `GET /v1/locations/:id`. A non-owning/public caller
sees only `is_active: true` rows; the owner or an admin sees every row, active or not.

```json
{
  "data": [
    { "id": "...", "location_id": "...", "booking_type": "hourly", "amount_minor_units": 10000, "currency": "INR", "half_day_duration_hours": null, "is_active": true, "created_at": "...", "updated_at": "..." },
    { "id": "...", "location_id": "...", "booking_type": "half_day", "amount_minor_units": 30000, "currency": "INR", "half_day_duration_hours": 4, "is_active": true, "created_at": "...", "updated_at": "..." }
  ]
}
```

### `POST /v1/locations/:id/pricing`

Requires authentication. Owning host or admin only.

Request: `{ "booking_type": "half_day", "amount_minor_units": 30000, "currency": "INR", "half_day_duration_hours": 4 }`
(`currency` defaults to `"INR"`; `half_day_duration_hours` is required when `booking_type` is
`"half_day"` and rejected for every other type.)

Response (`201`): the created row.

- `400 VALIDATION_ERROR` — `half_day_duration_hours` missing for `half_day`, or present for a
  different type.
- `409 CONFLICT` — this location already has a row for that `booking_type` (deactivate or update
  the existing one instead — `unique (location_id, booking_type)`).

### `PATCH /v1/locations/:id/pricing/:pricingId`

Requires authentication. Owning host or admin only. Any of `amount_minor_units`/`currency`/
`half_day_duration_hours`/`is_active`, at least one required. Setting `is_active: false` is how a
rate is disabled without losing it — a booker can no longer see or book that type, but the row
(and its history) stays.

Response (`200`): the updated row.

### `DELETE /v1/locations/:id/pricing/:pricingId`

Requires authentication. Owning host or admin only. Hard delete — prefer `PATCH
{"is_active": false}` unless the rate was a mistake.

Response (`200`): `{ "data": { "id": "...", "deleted": true } }`

## Bookings (Phase 6, extended by Phase 6A)

**Availability is not booking.** `GET /v1/locations/:id/availability` (above) tells a client what
times are open; the endpoints below actually reserve one. See
[`docs/DATABASE.md`](DATABASE.md#booking-engine--pricing-foundation-phase-6-extended-by-phase-6a)
for the full architecture — the atomic double-booking guarantee, the multi-day check-in/check-out
model, and the four booking types' pricing/interval-derivation rules.

**Timezone**: any `start_at`/`end_at`/`start_date` field is either a full ISO-8601 timestamp
**with an explicit offset** (e.g. `"2026-10-05T13:00:00+05:30"`, the same convention
`location_blocked_periods` already uses) or a bare `YYYY-MM-DD` date, depending on the booking
type below. The client resolves "1pm at this location" to a real instant using the location's own
`timezone` field (in every location response) *before* sending it — the backend only ever
validates an already-unambiguous instant, it never guesses one from a device's local timezone.

### `POST /v1/bookings`

Requires authentication **and** the `booker` role. The request body's shape depends on
`booking_type` — each type only asks for the fields that actually mean something for it (an
`hourly` booking needs a start and end; a `day` booking just needs a date):

| `booking_type` | Request body | How the interval is resolved |
|---|---|---|
| `"hourly"` (default if omitted) | `{ "location_id", "booking_type": "hourly", "start_at", "end_at" }` | passed straight through, unchanged from Phase 6 |
| `"half_day"` | `{ "location_id", "booking_type": "half_day", "start_at" }` | `end_at = start_at +` the location's configured `half_day_duration_hours` |
| `"day"` | `{ "location_id", "booking_type": "day", "date": "2026-10-05" }` | the location's actual open span that date (earliest window start → latest window end) |
| `"multi_day"` | `{ "location_id", "booking_type": "multi_day", "start_date", "end_date" }` | check-in day's window start → check-out day's window end |

Omitting `booking_type` entirely is backward compatible with Phase 6: `{ "location_id",
"start_at", "end_at" }` is treated as `"hourly"`.

Response (`201`): the booking detail object (below), including `booking_type`. Created as
`status: "confirmed"` immediately if the location has `instant_booking_enabled: true`, otherwise
`"requested"` (host approval required).

- `400 VALIDATION_ERROR` — this location has no active pricing for the requested `booking_type`,
  the derived date has no availability at all, or the resolved interval isn't available (outside
  operating hours, a schedule gap that day, inside a blocked period, or conflicts with another
  active booking of *any* type — checked, but not the source of the actual guarantee, see
  `docs/DATABASE.md`).
- `403 FORBIDDEN` — caller doesn't hold the `booker` role.
- `404 NOT_FOUND` — the location doesn't exist or isn't published.
- `409 CONFLICT` — a concurrent request won the exact same (or an overlapping) interval first,
  regardless of which booking type either side used to get there. This is the real double-booking
  guarantee firing, not a bug — a well-behaved client should let the booker pick a different time
  and retry.

### `GET /v1/bookings`

Requires authentication. RLS-scoped automatically: a booker sees their own bookings, a host sees
bookings on locations they own, an admin sees all — no role param needed. Optional
`?location_id=`/`?status=` filters, standard `page`/`pageSize` pagination.

### `GET /v1/bookings/:id`

Requires authentication. Same RLS scoping as the list endpoint; `404` if not visible to the
caller.

```json
{
  "data": {
    "id": "...",
    "location": { "id": "...", "title": "East London Film Studio", "city": "London", "timezone": "Europe/London" },
    "booker_id": "...",
    "booking_type": "hourly",
    "start_at": "2026-10-05T09:00:00+00:00",
    "end_at": "2026-10-05T11:00:00+00:00",
    "status": "confirmed",
    "pricing": {
      "base_amount_minor_units": 20000, "platform_fee_minor_units": 0,
      "tax_minor_units": 0, "discount_minor_units": 0,
      "total_amount_minor_units": 20000, "currency": "INR"
    },
    "created_at": "...", "updated_at": "...",
    "cancelled_at": null, "cancelled_by": null, "cancellation_reason": null
  }
}
```

`location` is a compact summary, not the full location object. `pricing` is the snapshot taken
at booking time — it never changes even if the location's price does later. Amounts are integer
minor units (e.g. paise for `INR`), never floating point.

### Lifecycle actions

| Method | Path | Who | Valid from |
|---|---|---|---|
| POST | `/v1/bookings/:id/confirm` | host (own location) or admin | `requested` → `confirmed` |
| POST | `/v1/bookings/:id/reject` | host or admin | `requested` → `rejected` |
| POST | `/v1/bookings/:id/cancel` | booker (own), host (own location), or admin | `requested`/`confirmed` → `cancelled` |
| POST | `/v1/bookings/:id/complete` | host or admin | `confirmed` → `completed` |

`reject`/`cancel` accept an optional body `{ "reason": "..." }`, stored as
`cancellation_reason` — omit the body entirely, an empty object, or a `reason` are all valid.

- `400 VALIDATION_ERROR` if the booking isn't currently in a status the requested transition
  allows (e.g. confirming an already-cancelled booking).
- `403 FORBIDDEN` if the caller isn't authorized for that specific action (e.g. a booker trying
  to confirm their own booking — only a host/admin can).
- `404 NOT_FOUND` if the booking doesn't exist or isn't visible to the caller at all.

Cancelling releases the interval immediately — the same time can be booked again the instant the
`cancel` request completes, since the exclusion constraint stops considering a cancelled
booking's interval the moment its status changes.

## Payments (Phase 7 — Cashfree, TEST/sandbox only)

Provider-agnostic by design — see
[`docs/DATABASE.md`](DATABASE.md#payment-architecture--cashfree-integration-phase-7) for the full
`PaymentProvider` architecture. Paying for a booking never changes the booking's own `status` —
see the same doc's "Booking status is not gated on payment" note. A booking's own immutable
`total_amount_minor_units`/`currency` (Phase 6/6A) is always the amount charged; no endpoint here
ever accepts a client-supplied amount.

### `POST /v1/bookings/:id/payment`

Requires authentication; only the booking's own booker may call this, and only while its status
is `requested` or `confirmed`.

Request: `{ "customer_phone": "9876543210", "return_url": "https://..." }` (`customer_phone`
required — a 10-digit number, Cashfree's own minimum requirement for creating an order;
`return_url` optional, where a hosted/browser checkout redirects when it completes).

Response (`201`):

```json
{
  "data": {
    "payment_id": "...",
    "booking_id": "...",
    "provider": "cashfree",
    "status": "pending",
    "amount_minor_units": 25000,
    "currency": "INR",
    "checkout": { "payment_session_id": "session_...", "order_id": "pb_..." }
  }
}
```

`checkout` is an intentionally opaque, provider-shaped payload — for Cashfree it's fed directly
into Cashfree's native Checkout SDK client-side; a future Razorpay integration would return a
differently-shaped `checkout` object, not this same one.

- `400 VALIDATION_ERROR` — invalid `customer_phone`, an unknown field in the body (e.g. an
  attempted `amount_minor_units` — the schema is strict, so this is rejected outright, not
  silently ignored), or the booking isn't in a payable status (`cancelled`/`rejected`/`completed`).
- `403 FORBIDDEN` — the caller can see the booking (e.g. its host) but isn't its booker.
- `404 NOT_FOUND` — the booking doesn't exist or isn't visible to the caller at all.
- `409 CONFLICT` — the booking has already been paid for, or a payment is in progress whose
  provider order could not be reached right now (so a second order cannot safely be created).

**Resume-or-create (Phase 26-H).** Calling this endpoint again while an attempt is already
in flight no longer fails. The server asks the provider what actually happened to that order and:

- order still payable → returns the **same** `payment_id` and the **same** `checkout.order_id`
  with a **freshly minted** `checkout.payment_session_id`. This is a resume, not a second charge:
  exactly one provider order ever exists per attempt.
- order already paid → reconciles the payment to `success` first, then returns `409`.
- order expired/terminated → records that attempt terminally and creates a genuinely new one
  (a new `payment_id`; attempt history is preserved, never overwritten).

This makes the endpoint safe to retry after an ambiguous network failure, and is what stops an
abandoned checkout from permanently blocking a booking from ever being paid. The client must
still never retry automatically in a loop — `paymentCreationLimiter` (10 / 15 min / user) applies.

Before any payment is allowed to become `success`, the amount and currency the provider reports
are checked against `payments.amount_minor_units`/`currency`. A mismatch is recorded as `failed`
with the discrepancy captured server-side, never as a successful payment.

### `GET /v1/bookings/:id/payments`

Requires authentication. RLS-scoped list of every payment *attempt* against a booking (a retry
after a failed attempt creates a new row, not a new booking) — booker/host/admin see it, anyone
else gets an empty list.

### `GET /v1/payments/:id`

Requires authentication. RLS-scoped single record; `404` if not visible to the caller.

### `POST /v1/payments/:id/verify`

Requires authentication (booker/host/admin — same visibility as the `GET`). Re-checks status
directly against Cashfree's own API — never trusts a client's "it succeeded" claim. A no-op
(returns the current record unchanged) once the payment has already reached a terminal status
(`success`/`failed`/`cancelled`/`refunded`/`partially_refunded`).

**Attempt-level reconciliation (Phase 26-H.9D).** For an order the provider still reports as open,
the server additionally reads that order's individual payment *attempts*. A **successful** attempt
settles the payment immediately — subject to the same amount/currency verification — rather than
waiting for order-level status or a webhook.

An **unsuccessful** attempt (failed, abandoned, cancelled, voided) deliberately changes nothing:
the provider allows another attempt inside the same still-open order, so the payment stays
`pending` and resumable. A failed attempt is not a failed payment, and treating it as one would
permanently block a later success on that order. No attempt detail is exposed through this or any
other endpoint.

### `POST /v1/payments/:id/refunds`

Requires authentication **and** the `admin` role (hosts have no payout/fund-split mechanism yet —
see `docs/DATABASE.md`). Request: `{ "amount_minor_units": 5000, "reason": "..." }` — both
optional; omitting `amount_minor_units` refunds the full remaining (unrefunded) balance.

Response (`201`): the created refund record.

- `400 VALIDATION_ERROR` — the payment never succeeded, or the requested amount exceeds what's
  actually left to refund.
- `403 FORBIDDEN` — caller isn't an admin.

### `GET /v1/payments/:id/refunds`

Requires authentication, RLS-scoped list.

### `GET /v1/payments/return`

No authentication — this is where a provider redirects a payer's **browser** after a hosted/web
checkout completes, and it is the default `return_url` sent with every created order. Serves a
neutral HTML page and deliberately asserts no outcome: arriving here proves only that a redirect
happened, not that any money moved. The native iOS SDK flow never lands here; it reconciles via
`POST /v1/payments/:id/verify`. Registered ahead of `GET /v1/payments/:id` so it isn't matched as
`:id = "return"` (Phase 26-H).

### `POST /v1/payments/webhooks/cashfree`

No authentication — Cashfree has no bearer token to send; the webhook's own HMAC-SHA256 signature
(`x-webhook-timestamp` + `x-webhook-signature` headers, verified against the exact raw request
body) is the authentication. A `PAYMENT_USER_DROPPED_WEBHOOK` additionally terminates the
still-payable provider order before recording a terminal `failed`, so ProdBnb never treats a live,
payable order as dead (Phase 26-H); a plain `PAYMENT_FAILED_WEBHOOK` deliberately does not, since
the payer is likely still in checkout retrying. Not callable meaningfully by anything other than Cashfree itself —
an invalid or missing signature is rejected before any database write. See
[`docs/DATABASE.md`](DATABASE.md#raw-body--signature-verification) for the raw-body handling
detail and the idempotency/out-of-order-safety guarantees.

## Devices (Phase 8 — push registration)

Provider-agnostic by design — see
[`docs/DATABASE.md`](DATABASE.md#notification-infrastructure--apns-push-phase-8). A user may have
several devices (phone, tablet, a future Android/Web client); registering a token already
belonging to a different user reassigns it (handles logout/re-login on a shared device).

### `POST /v1/devices`

Requires authentication. Request: `{ "device_token": "...", "platform": "ios", "environment": "sandbox" }`
(`platform` one of `ios`/`android`/`web`; `environment` one of `sandbox`/`production`, optional —
meaningful for `ios`). Upserts by `device_token`, always attributed to the caller — there is no
`user_id` field in the request body, it can never be someone else's device.

Response (`201`): the device record. **The raw `device_token` is never echoed back or returned by
any endpoint** — the caller already has it.

### `GET /v1/devices`

Requires authentication. RLS-scoped list of the caller's own devices, including inactive
(soft-deleted) ones.

### `DELETE /v1/devices/:id`

Requires authentication, owner only (`404` otherwise). Soft delete (`is_active: false`) —
preserves delivery-attempt history for that device.

Response (`200`): `{ "data": { "id": "...", "deleted": true } }`

## Notifications (Phase 8)

In-app notification records and per-device push delivery, generated only as a downstream effect
of real booking/payment events — see
[`docs/DATABASE.md`](DATABASE.md#which-event-produces-which-notification-and-why-some-dont-exist-yet)
for exactly which backend event produces which notification `type`, and to whom.

### `GET /v1/notifications`

Requires authentication. RLS-scoped, paginated (`page`/`pageSize`), optional `?unread=true`.

```json
{
  "data": [
    {
      "id": "...", "type": "booking_confirmed", "title": "Booking confirmed",
      "body": "Your booking has been confirmed.",
      "entity_type": "booking", "entity_id": "...",
      "data": {}, "read_at": null, "created_at": "...", "updated_at": "..."
    }
  ],
  "meta": { "page": 1, "pageSize": 20, "total": 3 }
}
```

### `GET /v1/notifications/:id`

Requires authentication. RLS-scoped, `404` if not visible to the caller.

### `POST /v1/notifications/:id/read`

Requires authentication, owner only. Sets `read_at`; idempotent if already read.

### `POST /v1/notifications/read-all`

Requires authentication. Marks every one of the caller's unread notifications read.

Response (`200`): `{ "data": { "marked_read": 3 } }`

### `GET /v1/notification-preferences`

Requires authentication. Always returns every category, defaulting any missing row to `true`:

```json
{ "data": { "booking": true, "payment": true, "message": true } }
```

### `PATCH /v1/notification-preferences`

Requires authentication. Request: `{ "booking": true, "payment": false, "message": true }` (every
field optional, at least one required). **Disabling a category only suppresses push delivery for it
— the in-app notification list is never affected**, per `docs/DATABASE.md`'s explanation of why
critical transactional notifications can't accidentally disappear.

`message` (Phase 27-8) gates message push. Because a missing row means enabled, adding the category
needed no backfill and every existing user is opted in.

### Message notifications (Phase 27-8)

Sending a message notifies **the other participant** — the host when the booker sends, the booker
when the host sends. A sender is never notified of their own message: the recipient is *computed* as
the participant who is not the sender, not filtered afterwards.

The notification is created **after** the message row has committed, and it can never fail the send.
`POST /v1/conversations/:id/messages` returns `201` with the message whether the push succeeded,
failed, or was skipped because no provider is configured — the durable message is authoritative and
is always readable from `GET /v1/conversations/:id/messages`.

**The push never contains message content.** The title is the sender's name and the body is a fixed
string:

```json
{
  "aps": {
    "alert": { "title": "Priya Sharma", "body": "Sent you a message." },
    "sound": "default",
    "thread-id": "<conversation_id>"
  },
  "prodbnb_type":            "new_message",
  "prodbnb_entity_type":     "conversation",
  "prodbnb_entity_id":       "<conversation_id>",
  "prodbnb_conversation_id": "<conversation_id>",
  "prodbnb_message_id":      "<message_id>"
}
```

This is deliberate. A push is rendered on a locked screen and mirrored to paired devices, and
ProdBnb messages carry rates, addresses, schedules and client names — so the same generic-copy rule
Phase 8 applied to bookings and payments applies here. The client opens the thread and reads the
real message from this API. When a sender has no name recorded, the title falls back to
`"New message"`.

`thread-id` groups a conversation into one entry in the notification centre rather than one banner
per message. There is **one push per message** — no coalescing in V1.

**A push is always attempted; the client decides whether to show it.** The server has no way to know
whether the app is open or which screen is visible, so it cannot suppress on that basis. iOS already
hides the banner when the user is looking at that conversation. Read state (Phase 27-7) does **not**
suppress pushes — a push describes a message that is by definition newer than the recipient's
cursor.

**No badge count** is sent in V1, and there is still no total-unread endpoint.

## Admin (Phase 11)

Every endpoint below requires authentication **and** the `admin` role, enforced once at the
router level (`src/modules/admin/admin.routes.ts`) — a booker/host gets `403` from any of them,
verified explicitly in each `tests/admin-*.test.ts` file. See
[`docs/DATABASE.md`](DATABASE.md#admin-control--admin-panel-phase-11) for the full architecture,
the host-suspension cascade, and the audit log. An OpenAPI 3.0 document for this surface is
generated at `docs/admin-openapi.json` (`npm run generate:openapi`).

`GET /v1/admin/dashboard` — operational summary: `total_users`, `active_hosts`,
`published_locations`, `locations_awaiting_approval`, `upcoming_bookings`, `recent_bookings`,
`payment_activity_30d`/`refund_activity_30d` (`{count, total_amount_minor_units}`),
`recent_admin_actions`. Small bounded/indexed queries only — no analytics infrastructure.

**Users** — `GET /v1/admin/users` (existing endpoint, extended: `?search=&role=&status=&page=&pageSize=`,
each row now includes `roles: string[]`), `GET /v1/admin/users/:id` (profile + roles + `email`/
`last_sign_in_at` via the Supabase Admin Auth API + `locations_count`/`bookings_count` — never
passwords/tokens), `POST /v1/admin/users/:id/suspend` (`{"reason": "..."}`, required — cascades to
the host's currently-published locations only, see `docs/DATABASE.md`), `POST
/v1/admin/users/:id/restore` (no body).

**Locations** — `GET /v1/admin/locations` (existing endpoint, extended: `?host_id=&search=`), `GET
/v1/admin/locations/:id`, `POST /v1/admin/locations/:id/approve` (no body; `submitted`/
`under_review` → `published` directly), `POST /v1/admin/locations/:id/reject` (`{"reason"}`,
required; `submitted`/`under_review` → `rejected`), `POST /v1/admin/locations/:id/suspend`
(`{"reason"}`, required; `published` → `suspended`), `POST /v1/admin/locations/:id/restore` (no
body; `suspended` → `published`). Each validates its source status (`400` if invalid) and writes
an audit entry.

**Bookings** — `GET /v1/admin/bookings` (`?booker_id=&host_id=` in addition to the existing
`?location_id=&status=`), `GET /v1/admin/bookings/:id`, `POST /v1/admin/bookings/:id/cancel`
(`{"reason"?}`, optional — same body as the existing booker/host cancel action). All three are
thin wrappers around the unmodified booking engine (`bookings.service.ts`) — no new cancellation
logic, no bypass of the EXCLUDE constraint.

**Payments / refunds** — `GET /v1/admin/payments` (`?status=&provider=&booking_id=`), `GET
/v1/admin/payments/:id`, `GET /v1/admin/refunds` (`?status=`), `POST
/v1/admin/payments/:id/refunds` — identical body/behavior to the existing `POST
/v1/payments/:id/refunds` (Phase 7), routed through the same `PaymentService`/`PaymentProvider`
architecture; no Cashfree-specific code exists in the admin layer, and `CASHFREE_SECRET_KEY`/raw
provider payloads never appear in any admin response.

**Notification diagnostics** — `GET /v1/admin/notifications/delivery-attempts?notification_id=`
or `?booking_id=` (one required) — `status`/`provider`/`error_reason`/timestamps per device
attempt only. Never returns another user's notification title/body/content.

**Audit log** — `GET /v1/admin/audit-log?target_type=&target_id=&admin_id=&page=&pageSize=`. Every
mutating admin action writes exactly one entry as its last step; there is no endpoint to create,
edit, or delete an entry directly — see `docs/DATABASE.md` for why that's structurally impossible,
not just unimplemented. **Phase 12**: the generic (pre-Phase-11) `PATCH /v1/locations/:id`,
`POST /v1/bookings/:id/cancel`, and `POST /v1/payments/:id/refunds` also accept an admin caller —
using one of these instead of its `/v1/admin/*` counterpart now audits identically (a new
`ADMIN_UPDATED_LOCATION_STATUS` action for the generic location PATCH, since it can reach statuses
none of the four dedicated moderation actions produce; the existing `ADMIN_CANCELLED_BOOKING`/
`ADMIN_CREATED_REFUND` actions for the other two) — nothing privileged is reachable through any
route without leaving a trail.

## Messaging — conversations (Phase 27-3)

Booker ↔ Host conversations. **This phase is conversations only** — there is no endpoint to send
or read messages yet (Phase 27-4), no read/unread endpoint, and no Realtime. All three routes
require authentication.

A conversation's identity is `(booker_id, location_id)` — one durable thread per booker per
listing, enforced by a unique constraint. The host is **derived** from `locations.host_id` and is
never stored or accepted. No endpoint accepts `booker_id`, `host_id`, a participant list or a
sender id: the booker is always the authenticated caller. See
[`docs/DATABASE.md`](DATABASE.md#messaging-data-model-phase-27-1) for the schema and RLS.

**Participants** are exactly the booker and the listing's host. Anyone else — **including an
admin** — gets an empty list and `404` on detail. There is deliberately no admin branch here;
admin access to private correspondence is a separate, audited path (`admin_message_access`) in a
later sub-phase.

### The conversation object

One shape, used identically by both read endpoints:

```json
{
  "id": "uuid",
  "location": {
    "id": "uuid",
    "title": "East London Film Studio",
    "city": "London",
    "status": "published",
    "primary_media_url": "https://…/locations/…/original"
  },
  "counterparty": { "id": "uuid", "first_name": "Priya", "last_name": "Sharma", "avatar_url": null },
  "viewer_role": "booker",
  "booking_id": null,
  "last_message_at": "2026-09-12T09:14:02Z",
  "created_at": "2026-09-12T08:00:00Z",
  "updated_at": "2026-09-12T09:14:02Z",
  "unread_count": 3
}
```

`viewer_role` (`booker` | `host`) is computed server-side — a client cannot re-derive it, because
a booker cannot read `locations.host_id` once a listing is unpublished. `counterparty` is the
listing's host when `viewer_role` is `booker`, and the conversation's booker when it is `host`.

`unread_count` (Phase 27-7) is **this viewer's** count of messages from the counterparty that are
newer than their read cursor. The viewer's own messages never count — sending is reading — so the
two participants legitimately see different numbers for the same thread. It is **capped at 100**:
`100` means "100 or more", which a client may render as "99+". See
[Read state](#read-state-phase-27-7).

The object deliberately contains **no** messages, message body or read **cursor**, and **no**
`phone`, `email`, `address`, profile `status` or any other profile/listing column. The cursor
itself (`last_read_at` / `last_read_message_id`) is returned only by
`POST /v1/conversations/:id/read`, to the one user it belongs to. The object is produced by a narrow
`SECURITY DEFINER` function, not by returning database rows —
see [`docs/DATABASE.md`](DATABASE.md#get_conversations_for_viewer-phase-27-3).

**A conversation stays fully readable after its listing is unpublished**, with its listing and
counterparty summary intact. Access is keyed on participation, not publication (Phase 27-2), and
`location.status` reports the listing's real state (`archived`, `suspended`, …) rather than hiding
it. The deliberate asymmetry: *continuing* an existing conversation always works; *starting* a new
one requires a `published` listing.

### `GET /v1/conversations`

`?limit=20&cursor=<opaque>` — keyset pagination, ordered `last_message_at DESC, id DESC`.

- `limit`: 1–100, default 20.
- `cursor`: opaque; encodes the composite `(last_message_at, id)`. The composite is necessary, not
  decorative — `last_message_at` defaults to `now()`, which is the *transaction* timestamp, so
  conversations created together share it exactly and a timestamp-only cursor would skip or repeat
  rows across the tie.
- A malformed or tampered cursor is `400 VALIDATION_ERROR`, never a 500.
- There is no `page`, `pageSize`, `booker_id`, `host_id` or `user_id` parameter. Unknown query
  params are ignored (matching every other list endpoint) — the safety property is that **no
  parameter exists that could widen the result set**, not that unknown ones are rejected.

```json
{ "data": [ { "…": "conversation objects" } ],
  "meta": { "limit": 20, "has_more": true, "next_cursor": "MjAyNi0wOS0xMlQ…" } }
```

An empty Inbox is `200` with `{"data": [], "meta": {"limit": 20, "has_more": false, "next_cursor": null}}`.

A user who is both a booker and a host sees both sides of their Inbox in one list.

### `GET /v1/conversations/:id`

Returns the same object. **`404 NOT_FOUND` when the conversation does not exist *or* the caller is
not a participant** — deliberately indistinguishable, so the endpoint is not an id-enumeration
oracle. An admin who is not a participant gets the same `404`. A malformed UUID is `400`.

### `POST /v1/conversations`

Get-or-create. Requires the `booker` role. **A host cannot initiate a conversation in this phase** —
the identity is `(booker_id, location_id)` and there is no safe input from which a host could name
a booker (a host cannot read a booker's profile at all). Host-initiated threads are deferred.

```json
{ "location_id": "uuid", "booking_id": "uuid | null" }
```

The body is `.strict()`: any unknown field — `booker_id`, `host_id`, `participants`, `sender_id` — is
`400 VALIDATION_ERROR`.

Returns **`201`** with the conversation whether it was just created or already existed, matching
`POST /v1/devices`, this API's existing idempotent-create precedent. N concurrent identical
requests all succeed and all describe the same conversation — the unique constraint is the
concurrency authority, and a `23505` is resolved to the existing row rather than surfaced as an
error.

`booking_id` is optional context, validated against the caller's own bookings. **It is never
re-pointed**: if the conversation already exists, a different `booking_id` is ignored rather than
overwriting the context the thread was created with.

| Situation | Result |
|---|---|
| Not authenticated | `401 UNAUTHENTICATED` |
| Caller lacks the `booker` role | `403 FORBIDDEN` |
| Location missing, draft, archived, suspended, or not visible | `404 NOT_FOUND` — never confirms a private listing exists |
| Caller is the listing's host (self-conversation) | `400 VALIDATION_ERROR` |
| `booking_id` is not the caller's, or is for another location | `400 VALIDATION_ERROR` |
| Unknown body field / malformed UUID | `400 VALIDATION_ERROR` |
| Conversation already exists, or a concurrent create raced | `201` with the existing conversation |

## Messaging — messages (Phase 27-4)

Sending and reading messages within a conversation. Still **no Realtime, no read/unread state and
no notifications** — those are Phase 27-6 onward.

Both endpoints require authentication and **neither requires a role**: participation is a
relationship, not a role, so booker and host both read and send. `requireRole('booker')` applies
only to conversation *creation*.

Both are participant-gated by `public.is_conversation_participant()` — the same predicate the RLS
policy uses. A non-participant, a nonexistent conversation, and an **admin who is not a
participant** all produce the same `404 NOT_FOUND`, so neither endpoint is an id-enumeration
oracle. There is no admin branch.

### The message object

```json
{
  "id": "uuid",
  "conversation_id": "uuid",
  "sender_id": "uuid",
  "body": "Hi Priya, we're looking at 22–24 September…",
  "client_message_id": "uuid",
  "created_at": "2026-09-12T09:14:02.481233+00:00"
}
```

Exactly six fields — the columns of `public.messages`, nothing computed and nothing hidden.

**There is deliberately no sender profile.** A message's sender is always one of the two
participants, and the conversation object already carries `counterparty` and `viewer_role`, so a
client resolves display identity as `sender_id === counterparty.id ? them : me`. This is why the
phase needs no profile access at all — which matters, because a host structurally cannot read the
booker's profile (see the Phase 27-3 notes in [`docs/DATABASE.md`](DATABASE.md)).

Also absent: read/unread state (Phase 27-7), booking context, attachments, and any `updated_at` —
messages are immutable and the table has no such column.

> `created_at` is rendered by Postgres as `…+00:00` with microsecond precision, not JavaScript's
> `…Z` form. Same instant, different characters — compare instants, not strings.

### `GET /v1/conversations/:id/messages`

`?limit=50&cursor=<opaque>` — keyset pagination, ordered **`created_at DESC, id DESC`** (newest
first), paging backwards into history. That is how a chat client loads (open on the newest page,
scroll up for older) and it matches the existing
`messages_conversation_id_created_at_id_idx` index exactly, so no index was added.

- `limit`: 1–100, **default 50** (the conversation list defaults to 20 — a message page is a
  screenful of chat, an Inbox page a screenful of threads).
- `cursor`: opaque; encodes the composite `(created_at, id)`. The composite is required — where
  two messages share a `created_at`, `id DESC` breaks the tie deterministically; a
  timestamp-only cursor would skip or repeat rows.
- A malformed or tampered cursor is `400 VALIDATION_ERROR`, never a 500.
- A cursor is a *position*, not a capability: it only ever filters within the conversation named
  in the path.
- No `page`, `pageSize`, `sender_id` or `user_id` parameter exists. Unknown query params are
  ignored; the safety property is that none could widen the result set.

```json
{ "data": [ { "…": "message objects, newest first" } ],
  "meta": { "limit": 50, "has_more": true, "next_cursor": "MjAyNi0wOS0xMlQ…" } }
```

An empty conversation is `200` with `{"data": [], "meta": {"limit": 50, "has_more": false, "next_cursor": null}}`.

**Reading messages never marks them read.** No `conversation_reads` row is created or advanced —
reading and marking-read are separate concepts, and read state is Phase 27-7.

### `POST /v1/conversations/:id/messages`

```json
{ "body": "text, 1–4000 characters after trimming", "client_message_id": "uuid" }
```

The body is `.strict()`. Everything that identifies or orders a message is server-derived —
`sender_id` from the bearer token, `conversation_id` from the path, `id` and `created_at` from the
database — so supplying `sender_id`, `conversation_id`, `created_at`, `id` or any unknown field is
`400 VALIDATION_ERROR`, not silently ignored.

`body` is trimmed before validation and storage, so the API's 1–4000 bound is measured on the same
value as the database's `char_length(btrim(body, …))` CHECK. Interior newlines are preserved
verbatim. Content is stored literally and never interpreted — the API builds no markup from it.

Returns **`201`** with the message.

**Idempotency.** `client_message_id` is **required** and backed by the database's
`UNIQUE (conversation_id, sender_id, client_message_id)` — there is no separate idempotency
system. Generate it once when the user taps Send and reuse it for every retry of that tap.

| Scenario | Result |
|---|---|
| Same key, sent twice | `201` with the **same** message — same `id`, same `created_at` |
| Same key, **different body** | `201` with the **original** message. First write wins; a retry is not an edit |
| Same key, different conversation | A separate message |
| Same key, from the other participant | A separate message (`sender_id` is in the key) |
| N concurrent identical sends | All `201`, all describing the same message; **exactly one row exists** |

A replay never re-stamps `created_at`, so a client cannot bump its own message's position by
retrying.

| Situation | Result |
|---|---|
| Not authenticated | `401 UNAUTHENTICATED` |
| Not a participant / nonexistent conversation / admin | `404 NOT_FOUND` |
| Malformed conversation UUID, invalid/missing `client_message_id` | `400 VALIDATION_ERROR` |
| Empty, whitespace-only, or >4000-character body | `400 VALIDATION_ERROR` |
| Server-derived or unknown field in the body | `400 VALIDATION_ERROR` |
| Too many sends in a short window | `429` (see below) |

**Rate limited** per authenticated user — 60 sends per minute, an anti-abuse floor well above any
human typing rate. ⚠️ The store is in-memory and therefore **per serverless instance**, so under
scale-out the effective limit is (limit × live instances). It is a soft baseline, not a globally
distributed limiter.

**Listing publication does not affect messages.** An existing conversation stays fully readable
*and writable* after its listing is archived or suspended — access is keyed on participation, not
publication. Only *starting* a new conversation requires a `published` listing.

**Booking state does not affect messages** either. A thread works the same whether its booking is
pending, confirmed, cancelled, completed or rejected.

### Read state (Phase 27-7)

Read/unread is a **per-conversation, per-user cursor** — never a per-message flag. One row per
`(conversation, user)` records the newest message that user has read; unread is everything from the
counterparty after it. Nothing is stored as a counter, so a count can never drift from the messages
it describes.

#### `POST /v1/conversations/:id/read`

```json
{ "last_read_message_id": "uuid" }
```

Advances the caller's read cursor. Returns **`200`**:

```json
{
  "data": {
    "conversation_id": "uuid",
    "last_read_at": "2026-09-12T09:14:02Z",
    "last_read_message_id": "uuid",
    "unread_count": 0
  }
}
```

**The body takes a message id and nothing else, and it is `.strict()`.** Supplying `last_read_at`,
a timestamp of any kind, `user_id`, `conversation_id` or any unknown field is `400
VALIDATION_ERROR` — refused, never ignored.

That is not fussiness about shape. **`last_read_at` is derived server-side from the referenced
message's own `created_at`, and is never the wall clock.** A message's `created_at` is its
transaction's start time, so a message whose transaction begins before a mark-read but commits
after it carries an *earlier* timestamp than the clock did — a wall-clock cursor marks it read
although the reader could never have seen it, and it is lost from unread permanently. This was
measured, not theorised. Accepting a client timestamp has the same effect, and additionally lets a
client send `infinity` and zero its own unread count for good.

**The cursor only ever moves forwards.** Marking an older message read is a `200` no-op that
returns the cursor which actually stands — not an error, because "read up to at least X" is
intrinsically idempotent and a client retrying or racing itself has done nothing wrong. Ordering is
the full `(created_at, id)` tuple, the same total order as message pagination, so two messages
sharing a `created_at` exactly are still strictly ordered by id.

Monotonicity is enforced **in the database**, not in this API: `authenticated` holds no `INSERT`,
`UPDATE` or `DELETE` grant on the read-cursor table at all (Phase 27-7), so a client talking to
PostgREST directly cannot move its cursor backwards, and cannot delete the row to reset it either.

| Situation | Result |
|---|---|
| Not authenticated | `401 UNAUTHENTICATED` |
| Not a participant / nonexistent conversation / **admin who is not a participant** | `404 NOT_FOUND` |
| Message does not exist | `404 NOT_FOUND` |
| Message belongs to a **different** conversation | `404 NOT_FOUND` — never confirms another thread's ids |
| Message **older** than the current cursor | `200`, cursor unchanged |
| Message already the cursor | `200`, unchanged — idempotent |
| Newest message | `200`, `unread_count: 0` |
| N concurrent calls | All `200`; the highest `(created_at, id)` wins |
| Malformed UUID, missing id, `last_read_at`, or any unknown field | `400 VALIDATION_ERROR` |

Either participant may call it — there is no role requirement, and a host maintains their own
cursor exactly as a booker does. The two cursors are independent. There is no rate limit: a client
legitimately marks read on every conversation open, the call creates nothing, and it can only ever
move the caller's own cursor forwards.

**Reading messages does not mark them read.** `GET /v1/conversations/:id/messages` never touches
the cursor, and which page a client fetched has no effect on `unread_count`. Marking read is an
explicit act, because only the client knows what the user actually saw.

**When to call it.** With the id of the newest message you have actually rendered: on opening a
thread, and again when a new message arrives while it is on screen. Do **not** call it on a
background refresh or when a push notification arrives — neither means the user read anything.

**No Realtime event is emitted for read state** (see below). Read receipts / "Seen" indicators are
deliberately not part of V1: one participant's read state stays private to them.

**There is no total-unread endpoint.** A client sums `unread_count` across the conversation list.
A dedicated aggregate is deferred until the APNs badge in Phase 27-8 needs one.

### Live delivery over Realtime (Phase 27-6)

Messages are **also** delivered live over Supabase Realtime. **The REST contract above is
unchanged** — Realtime is delivery, PostgreSQL and this API remain the source of truth.

| | |
|---|---|
| Channel | `conversation:<conversation_id>` — **must** be subscribed with `private: true` |
| Event | `message.created` |
| Payload | **exactly the six-field message object above**, byte-for-byte identical to what `GET`/`POST .../messages` return |

Clients subscribe **directly to Supabase Realtime with their own Supabase session** — the backend is
not in the delivery path. Only the two conversation participants may subscribe; a third party, and
an **admin who is not a participant**, are refused by the Realtime service before any payload is
sent. A non-private channel bypasses authorization entirely and must never be used.

An event is published inside the message's own database transaction, so a message that never
committed never announces itself. The reverse does **not** hold: a Realtime failure is silent by
design and cannot fail the write, so a client must be able to reach correct state from this API
alone.

**Required client contract**

1. **Treat this API as authoritative.** Realtime events are hints that arrive sooner.
2. **Deduplicate by server `id`** — always, everywhere. This one rule covers the POST-response/event
   race, reconnect overlap, a retried POST, and the echo of a message sent from another device.
   `client_message_id` has exactly one job: reconciling your own optimistic bubble. It is useless for
   deduplicating the counterparty's messages, which carry *their* client id.
3. **Sort by `(created_at, id)`** after every insert. Realtime delivery order is not guaranteed to
   match database order — never rely on arrival order.
4. **Reconcile after subscribing and after every reconnect**: re-fetch
   `GET /v1/conversations/:id/messages?limit=50` and merge, paging backwards with `cursor` until a
   page overlaps an `id` you already hold. Doing this immediately *after* subscribing closes the gap
   between the initial fetch and the subscription.

Listing publication status is irrelevant here too: an existing conversation whose listing is
archived still delivers live to its participants.

Typing indicators, presence, read receipts and message notifications are **not** part of this — they
are later phases.

**Read state is not broadcast** (Phase 27-7, Option A). `message.created` remains the only messaging
Realtime event. A client updates its own unread badge locally when an event arrives and is corrected
by the next `GET /v1/conversations`; because unread is *derived* from durable rows rather than
accumulated from events, a missed, duplicated or out-of-order event cannot corrupt it, and the
mandatory reconciliation fetch above restores the true count on its own.

## What's intentionally not here yet

Reviews, favorites, and availability-aware search are later phases — see
the main project brief. Messaging is **partially** here: conversations (Phase 27-3), message
sending/reading (Phase 27-4), live Realtime delivery (Phase 27-6), read/unread state
(Phase 27-7) and message push notifications (Phase 27-8) exist, but read receipts, attachments,
edit/delete, badge counts and admin messaging access do not. `GET /v1/locations` (search) still does not filter by availability; a
client checks a candidate location's availability separately via `GET /v1/locations/:id/availability`
and books via `POST /v1/bookings`. Host payouts / commission splitting are a documented extension
point (`docs/DATABASE.md`) but not implemented — Cashfree funds currently settle into ProdBnb's
own merchant account, refunds are admin-only, and Razorpay support is a future provider adapter,
not built this phase. Real APNs push delivery requires Apple Developer configuration this project
doesn't have yet (`docs/DATABASE.md`'s Phase 8 section) — the notification system is fully built
and tested against an explicit `disabled` provider in the meantime. Message notifications ship in Phase 27-8. Booking reminders and
support notifications are not implemented — there is no scheduler and no support feature for them to
be a downstream effect of. Creating a conversation still produces no notification; sending a message
does. Android (FCM) and Web Push are future
`NotificationProvider` adapters, not built this phase. Video transcoding, image processing, and AI
analysis remain out of scope for the R2 integration.
