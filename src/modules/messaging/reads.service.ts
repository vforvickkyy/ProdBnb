import { SupabaseClient } from "@supabase/supabase-js";
import { NotFoundError } from "../../errors/AppError";
import { getConversation } from "./conversations.service";
import { MarkReadInput } from "./messaging.schema";

// ---------------------------------------------------------------------------
// DTO
//
// The authoritative cursor state AFTER the operation, plus the unread count
// that follows from it -- deliberately narrow. No `id`, no `user_id`, no
// `created_at`/`updated_at`: the database function returns the whole
// `conversation_reads` row (see the migration for why it returns the row type
// rather than a RETURNS TABLE), and this is where that row is projected down
// to what a client actually needs.
//
// `last_read_at` and `last_read_message_id` are reported as one composite
// cursor. `last_read_message_id` can legitimately be null while `last_read_at`
// is set -- the column is ON DELETE SET NULL, so deleting the message a cursor
// points at leaves exactly that state -- which is why the type allows it
// rather than pretending the pair is atomic.
// ---------------------------------------------------------------------------

export interface ConversationReadState {
  conversation_id: string;
  last_read_at: string | null;
  last_read_message_id: string | null;
  unread_count: number;
}

/** The shape `public.mark_conversation_read()` returns -- a whole conversation_reads row. */
interface ConversationReadRow {
  conversation_id: string;
  last_read_at: string | null;
  last_read_message_id: string | null;
}

/**
 * Advance the caller's read cursor in one conversation.
 *
 * MONOTONIC. Marking an older message read, or the same one twice, is a no-op
 * that returns the cursor which actually stands rather than an error -- "read
 * up to at least X" is intrinsically idempotent, so no `client_message_id`
 * style key is needed here the way it is for `sendMessage()`.
 *
 * AUTHORIZATION IS ENFORCED TWICE, DELIBERATELY.
 *
 * The two checks below run on the caller's own RLS-scoped client and exist to
 * produce precise 404s. They are NOT what makes this safe:
 * `public.mark_conversation_read()` consults
 * `public.is_conversation_participant()` itself and writes nothing for a
 * non-participant, a conversation that does not exist, a message that does not
 * exist, or a message belonging to another conversation. Going around Express
 * entirely gains nothing either -- Phase 27-7 revoked INSERT, UPDATE and
 * DELETE on `conversation_reads` from `authenticated`, so that function is now
 * the only write path into the table.
 *
 * The checks are still worth making. Without them the endpoint could not tell
 * "you are not in this conversation" from "that message is not in it": the
 * function answers both with zero rows, and when a cursor already exists an
 * invalid message id would come back looking like a perfectly ordinary
 * monotonic no-op.
 *
 * Both failures are 404, and deliberately indistinguishable from a
 * conversation that does not exist -- matching `getConversation()` and
 * `assertParticipant()`, and leaving no id-enumeration oracle. An admin who is
 * not a participant gets the same 404; there is no admin branch in this
 * module, and an admin can never acquire or advance a participant's cursor.
 */
export async function markConversationRead(
  supabase: SupabaseClient,
  conversationId: string,
  input: MarkReadInput
): Promise<ConversationReadState> {
  // 1. Participation. Same helper `listMessages()`/`sendMessage()` use, so a
  //    non-participant and a nonexistent conversation collapse to one 404.
  const { data: isParticipant, error: participantError } = await supabase.rpc("is_conversation_participant", {
    _conversation_id: conversationId,
  });
  if (participantError) {
    throw participantError;
  }
  if (isParticipant !== true) {
    throw new NotFoundError("Conversation not found.");
  }

  // 2. The message must exist AND belong to THIS conversation. The
  //    `conversation_id` filter is what enforces the second half: a message in
  //    a different thread the caller also participates in is readable under
  //    `messages_select_participant`, so RLS alone would not exclude it. A
  //    message the caller cannot see at all reads back as null here, which is
  //    the same 404 -- so this never confirms that a guessed message id exists.
  const { data: message, error: messageError } = await supabase
    .from("messages")
    .select("id")
    .eq("id", input.last_read_message_id)
    .eq("conversation_id", conversationId)
    .maybeSingle();
  if (messageError) {
    throw messageError;
  }
  if (!message) {
    throw new NotFoundError("Message not found.");
  }

  // 3. The advance itself. Runs on the caller's scoped client because the
  //    function reads `auth.uid()` internally and takes no user id -- it can
  //    only ever move the caller's own cursor.
  const { data, error } = await supabase.rpc("mark_conversation_read", {
    _conversation_id: conversationId,
    _message_id: input.last_read_message_id,
  });
  if (error) {
    throw error;
  }

  const row = ((data ?? []) as ConversationReadRow[])[0];
  if (!row) {
    // Unreachable in practice: both preconditions were just checked against
    // the same session, so the function had a participant and a valid message
    // and must have produced a row. Treated as the same 404 rather than a 500
    // in case participation was revoked between the two calls.
    throw new NotFoundError("Conversation not found.");
  }

  // 4. The resulting unread count, read back through the SAME read model the
  //    Inbox list uses. Deliberately not a second, local count query: a
  //    separate implementation of the capped predicate is a second source of
  //    truth, and the number this endpoint returns must be the number the next
  //    `GET /v1/conversations` will show.
  const conversation = await getConversation(supabase, conversationId);

  return {
    conversation_id: row.conversation_id,
    last_read_at: row.last_read_at,
    last_read_message_id: row.last_read_message_id,
    unread_count: conversation.unread_count,
  };
}
