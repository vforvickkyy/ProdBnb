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
