-- Phase 27-3: Conversation read model
--
-- One additive function. No table, column, policy, grant or trigger from
-- Phase 27-1 (20260912190000) or Phase 27-2 (20260912200000) is altered, and
-- nothing that already works changes meaning.
--
-- ============================================================================
-- WHY THIS FUNCTION HAS TO EXIST
--
-- The Phase 27-3 inspection probed the local stack with real participant
-- sessions rather than reasoning from the policy text, and found three things
-- that together make an ordinary PostgREST query unable to render an Inbox at
-- all:
--
--   1. A HOST CAN NEVER LEARN THE BOOKER'S NAME. `profiles` RLS is
--      own-row-or-admin (Phase 1), so a host selecting the booker's profile
--      gets zero rows, and get_host_public_profile(booker) returns nothing
--      because a booker has no published location. There is no existing path
--      by which the host side of a conversation list can show a name.
--
--   2. THE BOOKER'S VIEW OF THE HOST'S NAME IS CONDITIONAL AND CAN VANISH.
--      get_host_public_profile() only answers while that host still has at
--      least one published location, so archiving a listing silently removes
--      the host's name from a conversation the booker is still entitled to
--      read.
--
--   3. THE LISTING ITSELF DISAPPEARS ONCE UNPUBLISHED. `locations` SELECT RLS
--      restricts a non-published row to its owner and admins, and
--      `location_media` follows the parent. Verified: a booker in an active
--      conversation about an archived listing still reads the conversation
--      and its messages, but an embedded `locations` resolves to null -- the
--      Inbox row loses its title and thumbnail entirely.
--
-- Phase 27-2 deliberately keyed conversation authorization on PARTICIPATION
-- rather than publication, precisely so a thread survives a listing being
-- archived, a booking being rejected, and so on. This function is what makes
-- that surviving thread actually renderable. It is the same technique, and
-- the same narrow-slice discipline, as get_host_public_profile() (Phase 2).
--
-- ============================================================================
-- WHAT IT DELIBERATELY IS NOT
--
-- Not a general-purpose cross-user data accessor. It answers exactly one
-- question -- "render the Inbox rows this caller is already a participant
-- of" -- and exposes only what an Inbox row draws:
--
--   conversation   id, booking_id, last_message_at, created_at, updated_at,
--                  viewer_role
--   location       id, title, city, status, primary media storage key
--   counterparty   id, first_name, last_name, avatar_url
--
-- It never exposes phone, email, address, profile status, booking details,
-- message content, or any other profile/listing column. Widening it is a
-- security decision, not a convenience one.
--
-- No admin branch. An admin who is not a participant matches nothing here,
-- exactly as they match nothing under `conversations_select_participant`.
-- Admin access to private correspondence goes through the separate, audited
-- Admin Messaging path (`admin_message_access`) in a later sub-phase.
-- ============================================================================

create function public.get_conversations_for_viewer(
  _cursor_last_message_at timestamptz default null,
  _cursor_id uuid default null,
  _limit integer default 20,
  _conversation_id uuid default null
)
returns table (
  id uuid,
  booking_id uuid,
  last_message_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  viewer_role text,
  location_id uuid,
  location_title text,
  location_city text,
  location_status text,
  location_primary_media_key text,
  counterparty_id uuid,
  counterparty_first_name text,
  counterparty_last_name text,
  counterparty_avatar_url text
)
language sql
security definer
set search_path = public
stable
as $$
  select
    c.id,
    c.booking_id,
    c.last_message_at,
    c.created_at,
    c.updated_at,

    -- Computed server-side so a client never has to re-derive host ownership
    -- (it cannot: `locations.host_id` is invisible to a booker once the
    -- listing is unpublished). A row where the caller is neither party is
    -- filtered out by the participant predicate below, so this case
    -- expression is never reached for a third party. A self-conversation
    -- (booker_id = host_id) resolves to 'booker' deterministically -- the API
    -- refuses to create one, but an older row would still render.
    case when c.booker_id = auth.uid() then 'booker' else 'host' end as viewer_role,

    l.id as location_id,
    l.title as location_title,
    l.city as location_city,
    l.status as location_status,

    -- Same selection rule as search_locations()'s own primary_media_key:
    -- lowest `position`, no media_type filter. Returned as the storage key,
    -- not a URL -- turning a key into a public URL is publicUrlFor()'s job in
    -- the service layer, consistently with every other media response in this
    -- codebase.
    (
      select lm.storage_key
      from public.location_media lm
      where lm.location_id = l.id
      order by lm.position asc
      limit 1
    ) as location_primary_media_key,

    p.id as counterparty_id,
    p.first_name as counterparty_first_name,
    p.last_name as counterparty_last_name,
    p.avatar_url as counterparty_avatar_url

  from public.conversations c
  join public.locations l on l.id = c.location_id
  -- The other party: the listing's host when the caller is the booker, the
  -- conversation's booker when the caller is the host. LEFT so a missing
  -- profile could never drop an otherwise-valid conversation from the Inbox
  -- (both FKs make that impossible today; this is belt and braces).
  left join public.profiles p
    on p.id = case when c.booker_id = auth.uid() then l.host_id else c.booker_id end

  where
    -- Fails closed. Redundant with the participant predicate below (comparing
    -- to a null auth.uid() yields null, not true) but stated explicitly so the
    -- guarantee does not rest on null-comparison semantics.
    auth.uid() is not null

    -- The participant rule, identical to `conversations_select_participant`
    -- and to public.is_conversation_participant(). No admin arm.
    and (c.booker_id = auth.uid() or l.host_id = auth.uid())

    -- Detail mode. Null means list mode.
    and (_conversation_id is null or c.id = _conversation_id)

    -- Keyset predicate for (last_message_at desc, id desc). Ignored entirely
    -- in detail mode. A cursor is all-or-nothing: the service layer only ever
    -- passes both halves or neither, because a half-cursor would compare
    -- against a null id and silently drop every row.
    and (
      _conversation_id is not null
      or _cursor_last_message_at is null
      or c.last_message_at < _cursor_last_message_at
      or (c.last_message_at = _cursor_last_message_at and c.id < _cursor_id)
    )

  order by c.last_message_at desc, c.id desc

  -- Hard ceiling of 101, not 100, on purpose: the user-facing maximum is 100
  -- and is enforced in messaging.schema.ts, but the service requests
  -- `limit + 1` rows so it can tell whether another page exists without a
  -- second query. This clamp is the defensive backstop for a direct RPC
  -- caller, not the product limit.
  limit greatest(least(coalesce(_limit, 20), 101), 1);
$$;

comment on function public.get_conversations_for_viewer(timestamptz, uuid, integer, uuid) is
  'The Inbox read model: the conversations the CURRENT caller participates in, '
  'with the narrow listing and counterparty summary an Inbox row needs. '
  'SECURITY DEFINER because ordinary RLS cannot supply it -- a host cannot '
  'read the booker''s profile at all, and neither party can read the listing '
  'once it is unpublished (see the header comment). Reads auth.uid() itself '
  'and accepts no user id, so it cannot be used to enumerate anyone else''s '
  'conversations. Exposes no phone, email, address, profile status, booking '
  'detail or message content, and has no admin branch.';

-- EXECUTE is granted to PUBLIC by default for a new function, which would
-- leave `anon` able to call this. It fails closed for an unauthenticated
-- caller regardless (auth.uid() is null -> zero rows), but an Inbox read
-- model has no anonymous use case at all, so the default is revoked rather
-- than relied upon. This is a deliberate, narrow departure from the other
-- functions in this schema, which leave the PUBLIC default in place.
revoke execute on function public.get_conversations_for_viewer(timestamptz, uuid, integer, uuid) from public;
grant execute on function public.get_conversations_for_viewer(timestamptz, uuid, integer, uuid) to authenticated, service_role;
