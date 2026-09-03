# Architecture

## Client → Backend → Supabase

```
   iOS app          Android app         Web app
      |                  |                 |
      |   (future)       |   (future)      |  Supabase Auth SDK/REST
      |                  |                 |  (sign up / sign in directly)
      +------------------+-----------------+
                         |
             Authorization: Bearer <supabase_access_token>
                         |
                         v
              ProdBnb Master Backend
           (Node/TypeScript, Express)
                         |
             request-scoped Supabase client
             (anon key + caller's JWT)
                         |
                         v
                   Supabase
        (Postgres + Auth + Row Level Security)
```

Three principles this backend is built around:

1. **One backend, one source of truth.** iOS, Android, and Web all call the same REST API. No
   client gets platform-specific business logic or platform-specific fields.
2. **Supabase Auth is the single authentication authority.** Clients authenticate directly
   against Supabase Auth (no custom password handling in this backend) and present the
   resulting access token as a bearer token on every request. The backend's job is to *identify*
   the caller and *authorize* what they can do — not to issue or manage credentials.
3. **Postgres Row Level Security is the real authorization boundary**, not just application
   code. Most request handlers build a Supabase client scoped to the caller's own JWT
   (`src/lib/supabase.ts` → `createUserScopedClient`), so a bug in a controller can't
   accidentally return another user's data — the database itself would refuse the query.

## Why a standalone API server, not just Supabase PostgREST/Edge Functions

Supabase can auto-expose a REST API directly from the database (PostgREST) or host business
logic in Deno Edge Functions. This project instead runs a standalone Node/Express server in
front of Supabase because:

- The existing iOS app is already built around a distinct, versioned API host
  (`https://dev-api.prodbnb.com/v1`, see `AppConfiguration.swift`) — a conventional REST
  contract, not raw PostgREST table endpoints.
- A standalone server gives one place for cross-cutting concerns (validation, consistent error
  shapes, future rate limiting, future business rules that span multiple tables) shared
  identically across iOS/Android/Web, using an ecosystem (Express + middleware) that's easy to
  extend without learning Supabase-specific runtime constraints.
- It keeps the door open to swap or add infrastructure later (e.g. Cloudflare R2 in Phase 3)
  without that decision being entangled with how the API itself is served.

## Module layout

```
src/modules/<feature>/
  <feature>.routes.ts       Express Router — wires middleware + handlers to paths
  <feature>.controller.ts   Reads req.user/req.valid, calls the service, writes the response
  <feature>.service.ts      Talks to Supabase (business logic lives here)
  <feature>.schema.ts       zod schemas for request validation
```

Phase 1 has two modules: `users` (profile read/update, admin listing) and `roles` (self-service
role assignment/removal). A future module (e.g. `locations`) follows the same shape and doesn't
require touching these.

## Request lifecycle

1. `middleware/auth.ts` (`requireAuth`) validates the bearer token against Supabase Auth,
   attaches `req.user` and a request-scoped `req.supabase` client.
2. `middleware/requireRole.ts` (where used) checks the caller holds a given marketplace role,
   reading through the same request-scoped client.
3. `middleware/validate.ts` parses/validates `body`/`query`/`params` with zod and stores the
   result on `req.valid` (never mutates the raw Express request objects).
4. The controller calls into the module's service, which talks to Supabase.
5. `middleware/errorHandler.ts` catches anything thrown anywhere in the chain — known
   `AppError`s are translated to their status/code/message; anything unexpected becomes a
   generic `500` (full detail is logged server-side only).

## Extension points left for later phases

- New modules (locations, bookings, payments, …) follow the existing module shape.
- `src/lib/supabase.ts` already exposes an `adminClient` (service-role) for future server-only
  operations (e.g. signed R2 uploads, admin tooling) — unused by any Phase 1 request path so its
  blast radius stays minimal today.
- The `profiles` and `user_roles` schema is intentionally minimal; both tables can grow new
  columns via ordinary migrations without breaking existing consumers.
