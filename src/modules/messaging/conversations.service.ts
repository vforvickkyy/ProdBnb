import { SupabaseClient } from "@supabase/supabase-js";
import { NotFoundError, ValidationError } from "../../errors/AppError";
import { publicUrlFor } from "../../lib/r2";
import { adminClient } from "../../lib/supabase";
import { getVisibleLocationOrNull } from "../locations/locations.service";
import { Cursor, decodeCursor, encodeCursor } from "./cursor";
import { CreateConversationInput, ListConversationsQuery } from "./messaging.schema";

const UNIQUE_VIOLATION = "23505";

// ---------------------------------------------------------------------------
// DTO
//
// One shape for both GET /v1/conversations and GET /v1/conversations/:id, so
// the list and the detail view cannot drift. Deliberately narrow — see the
// header of 20260912210000_phase27_3_conversation_views.sql for what is
// excluded and why. No messages, no unread count, no read cursor (those are
// later sub-phases), and no phone/email/address/profile-status ever.
// ---------------------------------------------------------------------------

export type ViewerRole = "booker" | "host";

export interface ConversationLocationSummary {
  id: string;
  title: string;
  city: string;
  /** Reported honestly even when no longer 'published' — see toConversation(). */
  status: string;
  primary_media_url: string | null;
}

export interface ConversationCounterparty {
  id: string;
  first_name: string | null;
  last_name: string | null;
  avatar_url: string | null;
}

export interface ConversationDetail {
  id: string;
  location: ConversationLocationSummary;
  counterparty: ConversationCounterparty | null;
  viewer_role: ViewerRole;
  booking_id: string | null;
  last_message_at: string;
  created_at: string;
  updated_at: string;
}

/** Exactly the columns `get_conversations_for_viewer()` returns. */
interface ConversationViewRow {
  id: string;
  booking_id: string | null;
  last_message_at: string;
  created_at: string;
  updated_at: string;
  viewer_role: ViewerRole;
  location_id: string;
  location_title: string;
  location_city: string;
  location_status: string;
  location_primary_media_key: string | null;
  counterparty_id: string | null;
  counterparty_first_name: string | null;
  counterparty_last_name: string | null;
  counterparty_avatar_url: string | null;
}

function toConversation(row: ConversationViewRow): ConversationDetail {
  return {
    id: row.id,
    location: {
      id: row.location_id,
      title: row.location_title,
      city: row.location_city,
      // The listing's real status, including 'archived'/'suspended'. An
      // existing conversation stays readable after its listing is unpublished
      // (Phase 27-2 keys access on participation, not publication), so the
      // client needs to know the listing is no longer live rather than being
      // told nothing.
      status: row.location_status,
      // Key -> URL happens here, never in SQL, matching toPublicMediaItem()
      // and the search module. The raw storage key is an internal R2 detail
      // and is never returned.
      primary_media_url: row.location_primary_media_key ? publicUrlFor(row.location_primary_media_key) : null,
    },
    counterparty: row.counterparty_id
      ? {
          id: row.counterparty_id,
          first_name: row.counterparty_first_name,
          last_name: row.counterparty_last_name,
          avatar_url: row.counterparty_avatar_url,
        }
      : null,
    viewer_role: row.viewer_role,
    booking_id: row.booking_id,
    last_message_at: row.last_message_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Reads
//
// Both go through get_conversations_for_viewer() on the CALLER'S OWN scoped
// client, so auth.uid() inside the function is the authenticated user. The
// function is SECURITY DEFINER only to reach across the `profiles` and
// `locations` RLS boundaries that would otherwise make an Inbox row
// unrenderable (see the migration header) -- it is not an authorization
// bypass, and it has no admin branch.
// ---------------------------------------------------------------------------

async function fetchConversationView(
  supabase: SupabaseClient,
  args: { cursor?: Cursor; limit?: number; conversationId?: string }
): Promise<ConversationViewRow[]> {
  const { data, error } = await supabase.rpc("get_conversations_for_viewer", {
    _cursor_last_message_at: args.cursor?.timestamp ?? null,
    _cursor_id: args.cursor?.id ?? null,
    _limit: args.limit ?? 20,
    _conversation_id: args.conversationId ?? null,
  });
  if (error) {
    throw error;
  }
  return (data ?? []) as ConversationViewRow[];
}

export interface PaginatedConversations {
  data: ConversationDetail[];
  has_more: boolean;
  next_cursor: string | null;
}

export async function listConversations(
  supabase: SupabaseClient,
  query: ListConversationsQuery
): Promise<PaginatedConversations> {
  const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;

  // One extra row is the whole `has_more` mechanism: if the database can
  // produce limit+1, another page exists. Cheaper and more accurate than a
  // second COUNT, which under a keyset predicate would only ever count the
  // post-cursor remainder anyway.
  const rows = await fetchConversationView(supabase, { cursor, limit: query.limit + 1 });

  const has_more = rows.length > query.limit;
  const page = rows.slice(0, query.limit).map(toConversation);
  const last = page[page.length - 1];

  return {
    data: page,
    has_more,
    next_cursor: has_more && last ? encodeCursor(last.last_message_at, last.id) : null,
  };
}

/**
 * 404 for a conversation that does not exist AND for one the caller is not a
 * participant of — deliberately indistinguishable, matching getBooking(). A
 * 403 would confirm the id exists and hand out a free enumeration oracle.
 * This is also what an admin gets: there is no admin branch anywhere in this
 * module.
 */
export async function getConversation(supabase: SupabaseClient, conversationId: string): Promise<ConversationDetail> {
  const rows = await fetchConversationView(supabase, { conversationId, limit: 1 });
  const row = rows[0];
  if (!row) {
    throw new NotFoundError("Conversation not found.");
  }
  return toConversation(row);
}

// ---------------------------------------------------------------------------
// Get-or-create
// ---------------------------------------------------------------------------

/**
 * Validates optional booking context against the caller's own RLS-scoped
 * client. A booking that is not the caller's is invisible to that client and
 * so reads back as null — the same 400 as a booking that doesn't exist, which
 * keeps this from confirming another user's booking id.
 */
async function assertBookingContext(
  supabase: SupabaseClient,
  bookerId: string,
  bookingId: string,
  locationId: string
): Promise<void> {
  const { data, error } = await supabase
    .from("bookings")
    .select("id, booker_id, location_id")
    .eq("id", bookingId)
    .maybeSingle();
  if (error) {
    throw error;
  }
  if (!data || data.booker_id !== bookerId) {
    throw new ValidationError("The referenced booking does not belong to you.");
  }
  if (data.location_id !== locationId) {
    throw new ValidationError("The referenced booking is not for this location.");
  }
}

/**
 * Get-or-create, keyed on the database's own `unique (booker_id, location_id)`
 * from Phase 27-1 — which is the authority here, not this function.
 *
 * Every authorization decision is made FIRST, against the caller's own
 * RLS-scoped client: the location must be visible to them and published, any
 * supplied booking must be theirs and for that location, and they must not be
 * the host. Only then does the insert run through `adminClient`, because
 * `conversations` deliberately has no `authenticated` INSERT grant (Phase
 * 27-2). That changes WHERE the write executes, never WHO may write — exactly
 * the reasoning createBooking() and registerDevice() already apply.
 */
export async function getOrCreateConversation(
  supabase: SupabaseClient,
  bookerId: string,
  input: CreateConversationInput
): Promise<ConversationDetail> {
  const location = await getVisibleLocationOrNull(supabase, input.location_id);
  // A conversation may only ever be STARTED against a live, published listing
  // — the same rule createBooking() applies, and 404 rather than 403 for the
  // same reason: never confirm that someone else's draft exists. Note this is
  // creation only. An EXISTING conversation stays fully readable and writable
  // after the listing is unpublished (Phase 27-2), which is the deliberate
  // asymmetry.
  if (!location || location.status !== "published") {
    throw new NotFoundError("Location not found.");
  }

  // API-level business rule, not a database constraint. The schema accepts a
  // self-conversation and Phase 27-1/27-2 are left untouched; messaging a
  // listing you own has no product meaning, so it is refused here.
  if (location.host_id === bookerId) {
    throw new ValidationError("You cannot start a conversation about your own listing.");
  }

  if (input.booking_id) {
    await assertBookingContext(supabase, bookerId, input.booking_id, input.location_id);
  }

  const { data: inserted, error } = await adminClient
    .from("conversations")
    .insert({
      booker_id: bookerId,
      location_id: input.location_id,
      booking_id: input.booking_id ?? null,
    })
    .select("id")
    .single();

  if (!error && inserted) {
    return getConversation(supabase, inserted.id as string);
  }

  // A concurrent request won the race, or the caller already had this
  // conversation. Either way the correct answer is the existing row — the
  // unique constraint is what guarantees there is exactly one, so N
  // simultaneous identical requests all succeed and all describe the same
  // conversation.
  if (error?.code === UNIQUE_VIOLATION) {
    const { data: existing, error: lookupError } = await supabase
      .from("conversations")
      .select("id")
      .eq("booker_id", bookerId)
      .eq("location_id", input.location_id)
      .maybeSingle();
    if (lookupError) {
      throw lookupError;
    }
    if (existing) {
      // Deliberately NOT an upsert and deliberately no write of any kind
      // here: re-opening an existing thread must never re-point its
      // `booking_id`. A "get" that mutates would let a later call silently
      // rewrite the context a conversation was created with. Whether opening
      // from a different booking should move that pointer is an open product
      // question, not something to settle by accident.
      return getConversation(supabase, existing.id as string);
    }
    // 23505 with nothing to find means the collision was not the identity
    // constraint — surface it rather than inventing a result.
  }

  throw error ?? new Error("Failed to create conversation.");
}
