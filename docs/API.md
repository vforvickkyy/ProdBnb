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

## What's intentionally not here yet

Locations, bookings, payments, reviews, messaging, notifications, and media upload (Cloudflare
R2) are later phases — see the main project brief. This phase only proves the
identify-authenticate-authorize foundation those phases will build on.
