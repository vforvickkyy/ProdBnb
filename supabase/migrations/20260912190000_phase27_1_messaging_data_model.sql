-- Phase 27-1: Messaging Data Model (Booker <-> Host conversations)
--
-- The schema foundation only. No API, no Realtime, no notification change --
-- those are later Phase 27 sub-phases. Purely additive: no existing table,
-- column, policy, grant or trigger is altered, and nothing that already works
-- changes meaning.
--
-- A conversation is the durable thread between ONE booker and ONE listing --
-- `unique (booker_id, location_id)`. It is deliberately NOT keyed on a
-- booking: the app's primary entry point ("Contact Host" on a listing page)
-- has no booking at all, and a booker who books the same studio four times
-- should have one thread with that host about that place, not five. A
-- booking is therefore optional, mutable CONTEXT on the thread
-- (`booking_id`), never part of its identity and never part of its
-- authorization.
--
-- The host side is DERIVED (`locations.host_id`), never duplicated here.
-- `locations.host_id` has had no `authenticated` grant since Phase 12, so it
-- cannot drift, and a denormalized copy could only ever be a second, weaker
-- source of truth.
--
-- Messages are immutable in V1: no updated_at, no edit, no delete, no
-- `authenticated` INSERT/UPDATE/DELETE grant at all -- the Phase 12
-- hardening shape (`bookings`, `locations`, `location_media`) applied from
-- the start rather than retrofitted. Every legitimate write goes through the
-- backend's service-role client after it has already authorized the caller.

-- ============================================================================
-- conversations
--
-- `last_message_at` / `last_message_id` are a denormalized cache of the most
-- recent message, maintained by the backend (and, from a later sub-phase, a
-- trigger). They exist so the Inbox list can sort and render a preview
-- without a per-row aggregate over `messages`. They are a cache: `messages`
-- is always the authority.
--
-- `last_message_id`'s FOREIGN KEY is added by an ALTER at the bottom of this
-- file, not inline. `conversations.last_message_id` and
-- `messages.conversation_id` reference each other, and Postgres cannot
-- create the second table's FK before the first table exists. The column is
-- still declared here, in its natural position, so this CREATE TABLE remains
-- the single readable definition of the row shape -- only the constraint is
-- deferred. This whole migration runs in one transaction, so there is no
-- window in which the column exists without its constraint.
-- ============================================================================

create table public.conversations (
  id uuid primary key default gen_random_uuid(),

  -- `on delete cascade`, matching bookings.booker_id / notifications.user_id
  -- / locations.host_id -- the established convention for the profile that
  -- OWNS a row. See the deletion-behaviour note at the foot of this file:
  -- this is deliberately the existing convention, not a new retention policy,
  -- and it has a real consequence worth knowing about.
  booker_id uuid not null references public.profiles (id) on delete cascade,

  -- No `on delete cascade`, matching bookings.location_id exactly: deleting
  -- a location that has conversation history would silently destroy that
  -- history. locations.service.ts already maps the equivalent booking
  -- FK-violation to a clean 409 rather than a raw 500; a later sub-phase
  -- extends that same mapping to this constraint.
  location_id uuid not null references public.locations (id),

  -- Optional, MUTABLE booking context -- which booking this thread is
  -- currently "about", for the conversation header and for deep-linking.
  -- Never part of identity (see the unique constraint below) and never
  -- consulted for authorization: a thread stays fully readable and writable
  -- after its booking is rejected, cancelled or completed, which is exactly
  -- when the two parties most need to talk. No cascade, matching
  -- payments.booking_id.
  booking_id uuid references public.bookings (id),

  -- What the Inbox sorts by. Defaults to creation time so a brand-new thread
  -- with no messages yet still orders sensibly against older ones.
  last_message_at timestamptz not null default now(),
  last_message_id uuid,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Conversation identity. One durable thread per (booker, listing).
  unique (booker_id, location_id)
);

comment on table public.conversations is
  'One durable Booker <-> Host thread per (booker_id, location_id). The host '
  'is DERIVED from locations.host_id and is deliberately not stored here. '
  'booking_id is optional, mutable context -- never identity, never '
  'authorization: a thread survives every booking status, including '
  'rejected/cancelled/completed. authenticated has SELECT only; every write '
  'goes through the backend service-role client (the Phase 12 pattern).';

comment on column public.conversations.booking_id is
  'The booking this thread is currently about, if any. Nullable because the '
  'primary entry point ("Contact Host" from a listing) has no booking, and '
  'mutable because a later booking on the same listing re-points it. Two '
  'bookings on one listing share one conversation by design.';

comment on column public.conversations.last_message_at is
  'Denormalized cache of the newest message''s created_at, used purely for '
  'Inbox ordering. public.messages is always the authority; this is never '
  'read to decide what a conversation contains.';

comment on column public.conversations.last_message_id is
  'Denormalized cache of the newest message''s id, for rendering a list '
  'preview without a per-row aggregate. ON DELETE SET NULL (see the ALTER at '
  'the foot of this migration) so a deleted message can never leave a '
  'dangling reference, and can never take the conversation with it.';

create index conversations_booker_id_last_message_at_idx
  on public.conversations (booker_id, last_message_at desc);

-- Serves two distinct needs: the HOST side of the Inbox (join to locations
-- on host_id = me), and the parent-side lookup Postgres performs when
-- checking the no-cascade FK above on a location delete. Postgres does not
-- index the referencing side of a foreign key automatically -- the same
-- reason bookings_booker_id_idx and payments_booking_id_idx exist.
create index conversations_location_id_idx on public.conversations (location_id);

create trigger set_conversations_updated_at
  before update on public.conversations
  for each row
  execute function public.set_updated_at();

-- ============================================================================
-- messages
--
-- Append-only. No updated_at and no set_updated_at trigger, deliberately:
-- there is no edit, unsend or delete in V1, and adding a column that nothing
-- can ever change would misrepresent the model.
--
-- `created_at` is server-assigned (`default now()`) and is the ordering key
-- together with `id`. It is never client-supplied -- not merely because the
-- API will not accept one, but because `authenticated` has no INSERT grant
-- on this table at all, so a client holding a real Supabase session cannot
-- set it through direct PostgREST either.
-- ============================================================================

create table public.messages (
  id uuid primary key default gen_random_uuid(),

  -- Cascade: messages are wholly owned by their conversation, the same
  -- parent/child shape as location_media.location_id or
  -- location_availability_rules.location_id.
  conversation_id uuid not null references public.conversations (id) on delete cascade,

  -- `on delete cascade`, the same profile-owner convention as
  -- conversations.booker_id above. See the deletion-behaviour note at the
  -- foot of this file.
  sender_id uuid not null references public.profiles (id) on delete cascade,

  -- Plain text, 1-4000 characters after trimming. Enforced HERE and not only
  -- in Zod because the whole point of the Phase 12 pattern is that the
  -- database refuses what the API refuses, independently of it -- trimming is
  -- what makes "   " a rejected body rather than a 3-character one.
  --
  -- The trim set is spelled out deliberately. Single-argument btrim() strips
  -- SPACES ONLY, so `char_length(btrim(body)) >= 1` would happily accept a
  -- body consisting entirely of newlines or tabs -- which is exactly the
  -- empty message this constraint exists to reject, and which the iOS
  -- composer (trimming .whitespacesAndNewlines) already treats as empty.
  -- Covers the ASCII whitespace set; an exotic Unicode space is a display
  -- nuisance rather than a correctness or security problem.
  body text not null check (char_length(btrim(body, E' \t\r\n\f\v')) between 1 and 4000),

  -- Client-generated idempotency key, scoped below. Lets a retry after a
  -- lost response return the SAME message instead of creating a second one.
  -- Same role as notifications.source_event_id, but supplied by the client
  -- rather than derived server-side, because only the client knows that two
  -- requests are the same tap.
  client_message_id uuid not null,

  created_at timestamptz not null default now(),

  -- Scoped to (conversation, sender), NOT to (conversation) alone. Without
  -- sender_id in the key, one participant could pick a client_message_id
  -- that collides with the other's; their insert would be rejected and the
  -- idempotent re-read would hand them the OTHER party's message as if it
  -- were their own, silently losing what they actually typed.
  unique (conversation_id, sender_id, client_message_id)
);

comment on table public.messages is
  'One text message in a conversation. Immutable: no updated_at, and '
  'authenticated has SELECT only -- no INSERT/UPDATE/DELETE grant at all, so '
  'sender_id and created_at cannot be forged even through direct PostgREST. '
  'Ordering is (created_at, id); created_at is always server-assigned.';

comment on column public.messages.client_message_id is
  'Idempotency key generated once by the client when the user taps Send and '
  'reused for every retry of that same tap. Unique per (conversation_id, '
  'sender_id, client_message_id) -- a replay collides and the backend '
  'returns the already-created message rather than a duplicate.';

comment on column public.messages.body is
  'Message text, stored exactly as sent. Never interpreted as HTML and never '
  'used to build markup server-side. The 1-4000 bound is on the TRIMMED '
  'length, so a whitespace-only body is rejected by the database itself.';

-- The message-history query: `where conversation_id = $1 order by created_at
-- desc, id desc limit N`. The unique index above leads on conversation_id
-- too, but its second column is sender_id, so it cannot serve this ordering.
create index messages_conversation_id_created_at_id_idx
  on public.messages (conversation_id, created_at desc, id desc);

-- ============================================================================
-- conversation_reads -- one read cursor per (conversation, user).
--
-- Deliberately NOT a `messages.is_read` boolean: read state is per-user, so
-- it cannot live on the shared message row at all, and a boolean would mean
-- updating N rows per read instead of one.
--
-- Deliberately NOT a conversation_participants table either. Membership is
-- fully derivable (conversations.booker_id + locations.host_id), so a
-- membership table could only ever drift out of sync with the thing it
-- mirrors. This table stores read STATE and nothing else -- holding a row
-- here is not what makes someone a participant, and is never consulted to
-- decide access.
--
-- Surrogate `id` primary key plus a unique constraint, matching
-- notification_preferences / user_roles rather than a composite PK -- the
-- established shape in this schema for a "one row per (owner, thing)" table.
-- ============================================================================

create table public.conversation_reads (
  id uuid primary key default gen_random_uuid(),

  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,

  -- Null until the user has read anything in this thread. Unread is counted
  -- as "messages from the other party newer than this", so null correctly
  -- means "everything is unread".
  last_read_at timestamptz,

  -- Where exactly the cursor sits, so a client can draw a "new messages"
  -- divider at a precise point rather than inferring one from a timestamp.
  -- ON DELETE SET NULL for the same reason as conversations.last_message_id.
  last_read_message_id uuid references public.messages (id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (conversation_id, user_id)
);

comment on table public.conversation_reads is
  'One read cursor per (conversation_id, user_id). Read state only -- a row '
  'here never grants access to anything, and its absence never denies any: '
  'participation is derived from conversations.booker_id / locations.host_id '
  '(see public.is_conversation_participant). Replaces a per-message is_read '
  'boolean, which cannot express per-user state on a shared row.';

comment on column public.conversation_reads.last_read_at is
  'Null means nothing in this thread has been read yet. Advanced only '
  'forwards by the backend, so a stale second device can never resurrect '
  'unread state by reporting an older cursor.';

-- The reverse of the unique index above: "all of this user's read rows",
-- which is how an Inbox list resolves every unread count in one pass, and
-- how the profiles cascade finds this user's rows on account deletion.
create index conversation_reads_user_id_conversation_id_idx
  on public.conversation_reads (user_id, conversation_id);

create trigger set_conversation_reads_updated_at
  before update on public.conversation_reads
  for each row
  execute function public.set_updated_at();

-- ============================================================================
-- conversations.last_message_id -> messages.id
--
-- Deferred to here purely because `messages` did not exist yet when
-- `conversations` was created. ON DELETE SET NULL, not CASCADE: deleting the
-- message a conversation happens to point at must clear the cache, never
-- delete the conversation and the rest of its history with it.
-- ============================================================================

alter table public.conversations
  add constraint conversations_last_message_id_fkey
  foreign key (last_message_id) references public.messages (id) on delete set null;

-- ============================================================================
-- is_conversation_participant() -- SECURITY DEFINER helper for RLS
--
-- Answers "is the CURRENT caller a participant in this conversation", by
-- joining conversations -> locations, which an ordinary policy cannot do
-- without dragging both of those tables' own RLS into every row check. Same
-- technique and same shape as public.has_role() (Phase 1).
--
-- Takes NO user id, on purpose. has_role() takes one and every policy passes
-- auth.uid(), which is safe there but leaves a function that will happily
-- answer about anybody -- and any function in `public` is callable as a
-- PostgREST RPC by anyone holding EXECUTE. Reading auth.uid() internally
-- means there is no caller-supplied identity to trust: the worst an attacker
-- can do by calling this directly is learn whether THEY are in a
-- conversation, which they already know.
--
-- Fails closed: the explicit `auth.uid() is not null` guard means an
-- unauthenticated caller (auth.uid() -> null) gets false rather than
-- relying on null-comparison semantics to do the right thing.
-- ============================================================================

create function public.is_conversation_participant(_conversation_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.conversations c
    join public.locations l on l.id = c.location_id
    where c.id = _conversation_id
      and auth.uid() is not null
      and (c.booker_id = auth.uid() or l.host_id = auth.uid())
  );
$$;

comment on function public.is_conversation_participant(uuid) is
  'True when the CURRENT authenticated caller is the booker of, or the host '
  'of the listing behind, this conversation. Reads auth.uid() itself rather '
  'than accepting a user id, so it cannot be used to probe anyone else''s '
  'membership. Returns false for an unauthenticated caller.';

-- ============================================================================
-- admin_message_access -- append-only audit of admin access to private
-- message content.
--
-- ProdBnb messaging is not end-to-end encrypted and administrators are able
-- to read conversation content for legitimate platform purposes (dispute
-- resolution, fraud, abuse, support, marketplace integrity, suspected
-- off-platform transactions). That capability is deliberately NOT expressed
-- as `participant or has_role(auth.uid(), 'admin')` on the policies above:
-- an admin reading someone's private messages must be a distinct, recorded
-- act with a stated reason, not an invisible widening of an ordinary read.
--
-- This table is that record. It holds no message content. The Admin
-- Messaging authorization/service layer that writes it -- and the admin read
-- path it gates -- is a LATER Phase 27 sub-phase; nothing reads or writes
-- this table yet. Modelled directly on admin_audit_log (Phase 11): append
-- only, no updated_at, no trigger, no client-writable path at all, so no
-- admin can create, edit or erase an entry, including their own.
-- ============================================================================

create table public.admin_message_access (
  id uuid primary key default gen_random_uuid(),

  -- No cascade, exactly as admin_audit_log.admin_id: an accountability
  -- record must outlive the account it names.
  admin_user_id uuid not null references public.profiles (id),

  -- See the deletion-behaviour note at the foot of this file -- this is the
  -- one FK here whose ON DELETE action is a genuine open question.
  conversation_id uuid not null references public.conversations (id) on delete cascade,

  -- Lowercase snake_case, matching every other CHECK-constrained enum column
  -- in this schema (notifications.type, bookings.status, payments.status).
  -- admin_audit_log.action's SCREAMING_SNAKE is the outlier, and this is a
  -- separate table with its own vocabulary rather than a new action value on
  -- that one -- reading private messages is a read, not a mutation, and it
  -- carries a mandatory reason, which admin_audit_log.reason is not.
  action text not null check (action in ('view_conversation')),

  -- Mandatory, unlike admin_audit_log.reason. The whole purpose of this
  -- table is that an admin states why before reading private correspondence,
  -- so the CHECK also rejects a blank string -- without it, `reason: ""`
  -- would satisfy NOT NULL and defeat the requirement entirely.
  reason text not null check (char_length(btrim(reason)) > 0),

  created_at timestamptz not null default now()
);

comment on table public.admin_message_access is
  'Append-only record of every admin access to private conversation content, '
  'with a mandatory stated reason. Contains no message content itself. '
  'Written exclusively by the backend (service_role) -- no INSERT/UPDATE/'
  'DELETE grant to authenticated at all, so no admin can create, edit or '
  'erase an entry, including their own. The admin read path this gates is a '
  'later Phase 27 sub-phase; nothing writes here yet.';

comment on column public.admin_message_access.reason is
  'Why this admin needed to read this conversation. NOT NULL and CHECK-'
  'constrained non-blank, deliberately stricter than admin_audit_log.reason.';

create index admin_message_access_conversation_id_idx
  on public.admin_message_access (conversation_id);
create index admin_message_access_admin_user_id_idx
  on public.admin_message_access (admin_user_id);
create index admin_message_access_created_at_idx
  on public.admin_message_access (created_at desc);

-- ============================================================================
-- Row Level Security
--
-- Table-level grants must be explicit for every Data API role, including
-- service_role -- see the Phase 1 migration's comment for why. There is no
-- anon grant on anything in this file: none of this data is ever public.
-- ============================================================================

alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.conversation_reads enable row level security;
alter table public.admin_message_access enable row level security;

grant select, insert, update, delete on public.conversations to service_role;
grant select, insert, update, delete on public.messages to service_role;
grant select, insert, update, delete on public.conversation_reads to service_role;
grant select, insert, update, delete on public.admin_message_access to service_role;

grant execute on function public.is_conversation_participant(uuid) to authenticated, service_role;

-- --- conversations -----------------------------------------------------------
-- SELECT only. Creating or re-pointing a conversation goes through the
-- backend's service-role client, which validates the location is published
-- and that any booking_id actually belongs to the caller and to the same
-- location -- neither of which RLS can express.
--
-- The predicate is written out rather than calling
-- is_conversation_participant(id): inside this policy the row is already in
-- hand, so the booker check is a column comparison, and this is the exact
-- shape bookings_select_own_or_hosted_or_admin already uses.
--
-- No admin arm, deliberately -- see admin_message_access above.
grant select on public.conversations to authenticated;

create policy "conversations_select_participant"
  on public.conversations
  for select
  to authenticated
  using (
    booker_id = auth.uid()
    or exists (select 1 from public.locations l where l.id = location_id and l.host_id = auth.uid())
  );

-- --- messages ----------------------------------------------------------------
-- SELECT only, and nothing else -- no INSERT, UPDATE or DELETE grant and no
-- policy for any of them, so RLS denies every authenticated write regardless
-- of how it is attempted. This is what makes sender_id and created_at
-- unforgeable rather than merely validated.
grant select on public.messages to authenticated;

create policy "messages_select_participant"
  on public.messages
  for select
  to authenticated
  using (public.is_conversation_participant(conversation_id));

-- --- conversation_reads ------------------------------------------------------
-- Ordinary self-service, the same select-own + write-own pair
-- notification_preferences established. No DELETE grant: a read cursor is
-- reset by moving it, never by removing the row.
--
-- The WITH CHECK additionally requires participation, so a user cannot
-- litter the table with cursors for conversations they have nothing to do
-- with. USING stays a plain ownership test -- by the time a row exists, its
-- owner is the only one who can reach it anyway.
grant select, insert, update on public.conversation_reads to authenticated;

create policy "conversation_reads_select_own"
  on public.conversation_reads
  for select
  to authenticated
  using (user_id = auth.uid());

create policy "conversation_reads_write_own"
  on public.conversation_reads
  for all
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and public.is_conversation_participant(conversation_id));

-- --- admin_message_access ----------------------------------------------------
-- Readable by admins only, mirroring admin_audit_log_select_admin_only:
-- accountability across the whole admin team is the point, not a private
-- per-admin log. A non-admin holds the grant but matches no row, so they see
-- nothing -- and there is no INSERT/UPDATE/DELETE policy at all, so the
-- append-only guarantee holds for admins too.
grant select on public.admin_message_access to authenticated;

create policy "admin_message_access_select_admin_only"
  on public.admin_message_access
  for select
  to authenticated
  using (public.has_role(auth.uid(), 'admin'));

-- ============================================================================
-- Deletion behaviour -- recorded deliberately, not invented
--
-- Every profile FK above uses `on delete cascade`, which is this schema's
-- existing convention for the profile that owns a row (bookings.booker_id,
-- notifications.user_id, locations.host_id, notification_preferences.user_id).
-- This migration follows that convention rather than introducing a retention
-- policy of its own. Two consequences follow from it that are worth stating
-- plainly rather than discovering later:
--
--   1. Deleting a booker's auth.users row removes their profile, and with it
--      every conversation they were part of -- including the host's side of
--      those threads. Deleting any user also removes the messages they sent
--      from threads that otherwise survive, leaving the counterparty with a
--      one-sided history.
--
--   2. `admin_message_access.conversation_id` cascades for a specific
--      reason: with a restricting FK, a single admin access record would
--      permanently block deletion of the booker's account (profile ->
--      conversations -> blocked), i.e. an admin doing their job could make a
--      user undeletable. Cascading avoids that deadlock, at the cost of the
--      audit row disappearing along with the conversation. The alternative
--      that keeps both properties is to drop the FK entirely and store a
--      bare conversation_id, exactly as admin_audit_log.target_id does.
--
-- Whether messaging history should instead be anonymised or soft-deleted on
-- account closure (profiles.status already has a 'deleted' value that
-- nothing currently uses) is a product/legal decision, not a schema one. It
-- is flagged for approval, not settled here.
--
-- Deliberate index omissions, so they read as decisions rather than
-- oversights: there is no index on messages.sender_id,
-- conversations.booking_id, conversations.last_message_id or
-- conversation_reads.last_read_message_id. Each is a FK whose parent-side
-- delete would therefore scan -- but bookings and messages are never
-- hard-deleted by any code path, and profile deletion is a rare
-- administrative operation rather than a request path. Adding them now would
-- be speculative.
-- ============================================================================
