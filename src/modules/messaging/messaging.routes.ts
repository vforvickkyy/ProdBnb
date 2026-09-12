import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { messageSendLimiter } from "../../middleware/rateLimit";
import { requireRole } from "../../middleware/requireRole";
import { validate } from "../../middleware/validate";
import {
  getConversationDetail,
  getConversations,
  getMessages,
  postConversation,
  postConversationRead,
  postMessage,
} from "./messaging.controller";
import {
  conversationIdParamSchema,
  createConversationSchema,
  listConversationsQuerySchema,
  listMessagesQuerySchema,
  markReadSchema,
  sendMessageSchema,
} from "./messaging.schema";

export const messagingRouter = Router();

// Participation, not role, decides who sees what — so no requireRole here. A
// user who hosts one listing and books another legitimately sees both sides of
// their Inbox in one list; get_conversations_for_viewer() scopes the result to
// them via auth.uid(), and no query parameter exists that could widen it.
messagingRouter.get("/conversations", requireAuth, validate({ query: listConversationsQuerySchema }), getConversations);

// "Create a new resource for yourself" — the same requireRole precedent as
// POST /v1/bookings + requireRole('booker') and POST /v1/locations +
// requireRole('host'). A host cannot initiate a conversation in this phase:
// the identity is (booker_id, location_id), the booker is always the
// authenticated caller, and there is no safe input a host could supply to name
// one (a host cannot read a booker's profile at all). Host-initiated threads
// are deferred, not forgotten.
messagingRouter.post(
  "/conversations",
  requireAuth,
  requireRole("booker"),
  validate({ body: createConversationSchema }),
  postConversation
);

// Participant-only, 404 for everyone else including admins — see
// getConversation() in conversations.service.ts.
messagingRouter.get(
  "/conversations/:id",
  requireAuth,
  validate({ params: conversationIdParamSchema }),
  getConversationDetail
);

// --- Messages (Phase 27-4) -------------------------------------------------
// No requireRole on either: both participants read and send, and participation
// is a relationship rather than a role. `requireRole('booker')` belongs only on
// conversation CREATION, where a host structurally cannot participate.

messagingRouter.get(
  "/conversations/:id/messages",
  requireAuth,
  validate({ params: conversationIdParamSchema, query: listMessagesQuerySchema }),
  getMessages
);

// messageSendLimiter is applied to this route ONLY -- never to the reads. It
// sits after requireAuth because it keys on req.user.id (see rateLimit.ts),
// and before validate so a flood is rejected without parsing bodies.
messagingRouter.post(
  "/conversations/:id/messages",
  requireAuth,
  messageSendLimiter,
  validate({ params: conversationIdParamSchema, body: sendMessageSchema }),
  postMessage
);

// --- Read state (Phase 27-7) -----------------------------------------------
// No requireRole, for the same reason as the message routes: both participants
// maintain their own read cursor, and participation is a relationship rather
// than a role. A host reads their Inbox exactly as a booker does.
//
// No rate limiter either, deliberately — unlike POST .../messages. A client
// marks read on every conversation open and again whenever a message arrives
// while the thread is on screen, so this is legitimately chattier than sending;
// and it creates nothing, is idempotent, and can only ever move the caller's
// own cursor forwards. `messageSendLimiter` exists to stop a flood of durable
// rows from one user, which this endpoint cannot produce.
messagingRouter.post(
  "/conversations/:id/read",
  requireAuth,
  validate({ params: conversationIdParamSchema, body: markReadSchema }),
  postConversationRead
);
