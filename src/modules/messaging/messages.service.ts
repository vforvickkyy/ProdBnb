import { SupabaseClient } from "@supabase/supabase-js";
import { NotFoundError } from "../../errors/AppError";
import { adminClient } from "../../lib/supabase";
import { notifyNewMessage } from "../notifications/notification.service";
import { decodeCursor, encodeCursor } from "./cursor";
import { ListMessagesQuery, SendMessageInput } from "./messaging.schema";

const UNIQUE_VIOLATION = "23505";

// ---------------------------------------------------------------------------
// DTO
//
// Exactly the six columns of `public.messages` -- nothing computed, nothing
// hidden, nothing borrowed from another table.
//
// Deliberately NO sender profile. A message's sender is always one of the two
// conversation participants, and the conversation DTO already carries
// `counterparty` plus `viewer_role`, so a client resolves identity as
// "sender_id === counterparty.id ? them : me". That is exactly what the iOS
// MessageBubble needs, and it means this phase requires no profile access at
// all -- which matters, because Phase 27-3 established that a host simply
// cannot read the booker's profile through any existing path.
//
// Also deliberately absent: read/unread state (Phase 27-7), booking context,
// attachments, and any `updated_at` -- messages are immutable and the table
// has no such column.
// ---------------------------------------------------------------------------

export interface MessageDetail {
  id: string;
  conversation_id: string;
  sender_id: string;
  body: string;
  client_message_id: string;
  created_at: string;
}

const MESSAGE_COLUMNS = "id, conversation_id, sender_id, body, client_message_id, created_at";

/**
 * Participation gate, shared by both endpoints.
 *
 * Reuses `public.is_conversation_participant()` (Phase 27-2) rather than
 * introducing a third participation check -- it is the same predicate
 * `messages_select_participant` itself uses, it takes no user id, and it reads
 * auth.uid() internally, so it must be called through the CALLER'S scoped
 * client.
 *
 * It returns false both for "not a participant" and for "conversation does not
 * exist", so both collapse to the same 404 -- matching
 * `GET /v1/conversations/:id` and leaving no id-enumeration oracle. An admin
 * who is not a participant gets that same 404; there is no admin branch here.
 */
async function assertParticipant(supabase: SupabaseClient, conversationId: string): Promise<void> {
  const { data, error } = await supabase.rpc("is_conversation_participant", {
    _conversation_id: conversationId,
  });
  if (error) {
    throw error;
  }
  if (data !== true) {
    throw new NotFoundError("Conversation not found.");
  }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export interface PaginatedMessages {
  data: MessageDetail[];
  has_more: boolean;
  next_cursor: string | null;
}

/**
 * Newest first (`created_at DESC, id DESC`), paging backwards into history --
 * how a chat client actually loads: open on the newest page, scroll up for
 * older. That ordering is also an exact match for the existing
 * `messages_conversation_id_created_at_id_idx`, so no index was added.
 *
 * Runs `get_conversation_messages()` on the caller's own scoped client. That
 * function is SECURITY **INVOKER**, so `messages_select_participant` filters
 * the rows -- it grants nothing. The participation check above is purely about
 * producing a 404 instead of a misleading empty page.
 *
 * Reading messages never touches `conversation_reads`. Reading and marking
 * read are separate concepts; read state is Phase 27-7.
 */
export async function listMessages(
  supabase: SupabaseClient,
  conversationId: string,
  query: ListMessagesQuery
): Promise<PaginatedMessages> {
  await assertParticipant(supabase, conversationId);

  const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;

  // limit + 1 is the whole has_more mechanism -- cheaper and more accurate
  // than a COUNT, which under a keyset predicate only ever describes the
  // post-cursor remainder anyway.
  const { data, error } = await supabase.rpc("get_conversation_messages", {
    _conversation_id: conversationId,
    _cursor_created_at: cursor?.timestamp ?? null,
    _cursor_id: cursor?.id ?? null,
    _limit: query.limit + 1,
  });
  if (error) {
    throw error;
  }

  const rows = (data ?? []) as MessageDetail[];
  const has_more = rows.length > query.limit;
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];

  return {
    data: page,
    has_more,
    next_cursor: has_more && last ? encodeCursor(last.created_at, last.id) : null,
  };
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Send, idempotent on `(conversation_id, sender_id, client_message_id)` -- the
 * Phase 27-1 unique constraint, which is the authority here rather than
 * anything this function does. There is no separate idempotency table and no
 * need for one.
 *
 * Nothing identifying comes from the client: `sender_id` is the authenticated
 * caller, `conversation_id` is the path, and `id`/`created_at` are database
 * defaults. `sendMessageSchema` is `.strict()`, so supplying any of them is a
 * 400 -- and beyond that, `messages` has no `authenticated` INSERT grant at
 * all (Phase 27-2), so a client going around Express entirely still cannot
 * forge one.
 *
 * Authorization runs FIRST, on the caller's own scoped client. Only then does
 * the insert go through `adminClient`, which changes WHERE the write executes,
 * never WHO may write -- the same reasoning `createBooking()`,
 * `registerDevice()` and `getOrCreateConversation()` already apply.
 *
 * A successful insert fires `on_message_created`, which advances the
 * conversation's `last_message_id`/`last_message_at` inside this same
 * transaction (Phase 27-4 migration), and `on_message_created_broadcast`, which
 * publishes the Realtime `message.created` event (Phase 27-6). Message, Inbox
 * ordering and live delivery therefore commit together or not at all.
 *
 * The APNs notification (Phase 27-8) is deliberately NOT part of that set. It
 * is an outbound call to a third party, so it happens AFTER the durable write
 * has committed, in this service layer rather than in a trigger, and
 * `notifyNewMessage()` can never throw -- a message is durable whether or not
 * anyone was ever told about it.
 */
export async function sendMessage(
  supabase: SupabaseClient,
  senderId: string,
  conversationId: string,
  input: SendMessageInput
): Promise<MessageDetail> {
  await assertParticipant(supabase, conversationId);

  const { data: inserted, error } = await adminClient
    .from("messages")
    .insert({
      conversation_id: conversationId,
      sender_id: senderId,
      body: input.body,
      client_message_id: input.client_message_id,
    })
    .select(MESSAGE_COLUMNS)
    .single();

  if (!error && inserted) {
    const message = inserted as MessageDetail;
    // AFTER the durable write, never inside it. Awaited rather than
    // fire-and-forget because a Vercel function may be frozen or torn down the
    // moment it responds, which would silently drop the push. Guaranteed not to
    // throw, so this cannot turn a stored message into a failed request.
    await notifyNewMessage(senderId, conversationId, message.id);
    return message;
  }

  // A retry after a lost response, a double tap, or a concurrent duplicate.
  // The correct answer is the message that already exists -- returned exactly
  // as it was first stored, so a replay can never re-stamp `created_at` (which
  // would let a client bump its own message's position) and never rewrites the
  // body (first write wins; a retry is a retry, not an edit).
  if (error?.code === UNIQUE_VIOLATION) {
    const { data: existing, error: lookupError } = await supabase
      .from("messages")
      .select(MESSAGE_COLUMNS)
      .eq("conversation_id", conversationId)
      .eq("sender_id", senderId)
      .eq("client_message_id", input.client_message_id)
      .maybeSingle();
    if (lookupError) {
      throw lookupError;
    }
    if (existing) {
      // Deliberately NO notification here. This branch is a replay of a send
      // that already happened, and the counterparty was already notified for it
      // -- the `(user_id, source_event_id)` unique constraint would collapse a
      // second attempt anyway, but not doing the work is clearer than relying
      // on a collision to undo it.
      return existing as MessageDetail;
    }
    // 23505 with nothing to find means the collision was not the idempotency
    // key -- surface it rather than inventing a result.
  }

  throw error ?? new Error("Failed to send message.");
}
