import { Request, Response } from "express";
import { callerHasRole } from "../../middleware/requireRole";
import { created, ok } from "../../utils/respond";
import {
  CompleteUploadInput,
  LocationIdOnlyParam,
  LocationMediaParams,
  ReorderMediaInput,
  RequestUploadInput,
} from "./media.schema";
import { completeUpload, deleteMedia, listMedia, reorderMedia, requestUpload } from "./media.service";

async function isCallerAdmin(req: Request): Promise<boolean> {
  return callerHasRole(req.supabase!, req.user!.id, "admin");
}

export async function postRequestUpload(req: Request, res: Response): Promise<void> {
  const { id } = req.valid!.params as LocationIdOnlyParam;
  const input = req.valid!.body as RequestUploadInput;
  const isAdmin = await isCallerAdmin(req);
  const authorization = await requestUpload(req.supabase!, req.user!.id, isAdmin, id, input);
  created(res, authorization);
}

/**
 * Phase 29 B2.5-b: **201 for a genuine first record, 200 for an idempotent replay.**
 *
 * A replay is not a creation, so it must not keep claiming 201. The body is identical either way —
 * the same `PublicMediaItem` the normal completion returns, in the module's existing `{ data }`
 * envelope.
 */
export async function postCompleteUpload(req: Request, res: Response): Promise<void> {
  const { id, mediaId } = req.valid!.params as LocationMediaParams;
  const { position, section_id } = req.valid!.body as CompleteUploadInput;
  const isAdmin = await isCallerAdmin(req);
  const result = await completeUpload(req.supabase!, req.user!.id, isAdmin, id, mediaId, position, section_id ?? null);
  if (result.created) {
    created(res, result.item);
    return;
  }
  ok(res, result.item);
}

export async function getMedia(req: Request, res: Response): Promise<void> {
  const { id } = req.valid!.params as LocationIdOnlyParam;
  const media = await listMedia(req.supabase!, id);
  ok(res, media);
}

/** Phase 29 B2.5-a. Returns the resulting order, 200, in the module's existing `{ data }` envelope. */
export async function putMediaOrder(req: Request, res: Response): Promise<void> {
  const { id } = req.valid!.params as LocationIdOnlyParam;
  const { ordered_ids, section_id } = req.valid!.body as ReorderMediaInput;
  const isAdmin = await isCallerAdmin(req);
  const media = await reorderMedia(req.supabase!, req.user!.id, isAdmin, id, ordered_ids, section_id ?? null);
  ok(res, media);
}

export async function deleteMediaHandler(req: Request, res: Response): Promise<void> {
  const { id, mediaId } = req.valid!.params as LocationMediaParams;
  const isAdmin = await isCallerAdmin(req);
  await deleteMedia(req.supabase!, req.user!.id, isAdmin, id, mediaId);
  ok(res, { id: mediaId, deleted: true });
}
