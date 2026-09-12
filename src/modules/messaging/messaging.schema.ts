import { z } from "zod";

const uuid = z.string().uuid();

/**
 * Deliberately NOT `.strict()`, matching every other list-query schema in this
 * codebase (bookings, notifications, locations, admin) — an unknown query
 * parameter is ignored, not rejected.
 *
 * The safety property that matters here is not "unknown params are refused",
 * it is that **no parameter exists that could widen the result set**. There is
 * no `booker_id`, `host_id`, `user_id`, `page` or `pageSize`: the caller's
 * identity comes from their bearer token and nothing else, and
 * `get_conversations_for_viewer()` resolves participation from `auth.uid()`
 * internally. Appending `?booker_id=<someone else>` therefore changes nothing
 * at all, which the tests assert directly.
 */
export const listConversationsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  // Opaque to the client. Decoded/validated in conversations.service.ts — a
  // malformed or tampered value raises ValidationError (400), never a 500.
  cursor: z.string().min(1).max(200).optional(),
});
export type ListConversationsQuery = z.infer<typeof listConversationsQuerySchema>;

export const conversationIdParamSchema = z.object({ id: uuid });
export type ConversationIdParam = z.infer<typeof conversationIdParamSchema>;

/**
 * `.strict()` is load-bearing here, not stylistic. A conversation's identity is
 * `(booker_id, location_id)` and the booker is *always* the authenticated
 * caller — so `booker_id`, `host_id`, a participant list or any other identity
 * field must be refused outright rather than silently ignored, which would
 * leave a client believing it had opened a conversation on someone else's
 * behalf.
 *
 * `booking_id` accepts a uuid, an explicit `null`, or omission — all three mean
 * "no booking context" except the uuid. It is validated against the caller's
 * own bookings in the service; it can never be used to infer or impersonate
 * another booker.
 */
export const createConversationSchema = z
  .object({
    location_id: uuid,
    booking_id: uuid.nullable().optional(),
  })
  .strict();
export type CreateConversationInput = z.infer<typeof createConversationSchema>;

// ---------------------------------------------------------------------------
// Messages (Phase 27-4)
//
// The path parameter is `conversationIdParamSchema` above, reused as-is:
// `/v1/conversations/:id/messages` names the conversation, and the message
// endpoints never take a message id (there is no single-message endpoint --
// nothing consumes one, and it would be a pure enumeration surface).
// ---------------------------------------------------------------------------

/**
 * Same shape and the same non-strict stance as the conversation list, for the
 * same reason: no parameter exists that could widen the result set, which is a
 * stronger property than rejecting unknown ones.
 *
 * `limit` defaults to 50 rather than the conversation list's 20 — a message
 * page is a screenful of chat, an Inbox page is a screenful of threads.
 */
export const listMessagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(200).optional(),
});
export type ListMessagesQuery = z.infer<typeof listMessagesQuerySchema>;

/**
 * `.strict()` is load-bearing. Everything that identifies or orders a message
 * is server-derived — `sender_id` from the bearer token, `conversation_id`
 * from the path, `id` and `created_at` from the database — so an attempt to
 * supply one must be REFUSED rather than ignored, which would otherwise leave
 * a client believing it had set them.
 *
 * `.trim()` runs before `.min(1)`/`.max(4000)`, so the bounds are measured on
 * the trimmed value and the trimmed value is what gets stored. That makes the
 * API agree exactly with the database's
 * `char_length(btrim(body, E' \t\r\n\f\v')) between 1 and 4000` CHECK (Phase
 * 27-1): without trimming here, a 4000-character body with trailing spaces
 * would satisfy the CHECK while storing more than 4000 characters.
 *
 * One deliberate asymmetry: JavaScript's trim() strips all Unicode whitespace
 * while the database's btrim strips only the ASCII set, so a body consisting
 * solely of U+00A0 is rejected here and would be accepted there. API stricter
 * than database is the safe direction, and the CHECK remains the backstop.
 *
 * Interior newlines are untouched — multi-line messages are legitimate.
 */
export const sendMessageSchema = z
  .object({
    body: z.string().trim().min(1).max(4000),
    client_message_id: uuid,
  })
  .strict();
export type SendMessageInput = z.infer<typeof sendMessageSchema>;
