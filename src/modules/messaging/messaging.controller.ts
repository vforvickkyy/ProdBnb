import { Request, Response } from "express";
import { created, ok } from "../../utils/respond";
import { getConversation, getOrCreateConversation, listConversations } from "./conversations.service";
import { ConversationIdParam, CreateConversationInput, ListConversationsQuery } from "./messaging.schema";

/**
 * Keyset-paginated, so `meta` carries `has_more`/`next_cursor` rather than the
 * `{page, pageSize, total}` every other list endpoint returns. A total would
 * be misleading here: under a cursor predicate, a COUNT only ever describes
 * the post-cursor remainder. See docs/API.md.
 */
export async function getConversations(req: Request, res: Response): Promise<void> {
  const query = req.valid!.query as ListConversationsQuery;
  const { data, has_more, next_cursor } = await listConversations(req.supabase!, query);
  ok(res, data, 200, { limit: query.limit, has_more, next_cursor });
}

export async function getConversationDetail(req: Request, res: Response): Promise<void> {
  const { id } = req.valid!.params as ConversationIdParam;
  const conversation = await getConversation(req.supabase!, id);
  ok(res, conversation);
}

/**
 * Get-or-create. Returns 201 whether the conversation was just created or
 * already existed, matching POST /v1/devices, which is this codebase's
 * existing idempotent-create precedent (re-registering a known token is also
 * a 201). The client's next action is the same either way: open the thread.
 */
export async function postConversation(req: Request, res: Response): Promise<void> {
  const input = req.valid!.body as CreateConversationInput;
  const conversation = await getOrCreateConversation(req.supabase!, req.user!.id, input);
  created(res, conversation);
}
