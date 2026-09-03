import { Request, Response } from "express";
import { callerHasRole } from "../../middleware/requireRole";
import { created, ok } from "../../utils/respond";
import { CompleteUploadInput, LocationIdOnlyParam, LocationMediaParams, RequestUploadInput, UpdateMediaInput } from "./media.schema";
import { completeUpload, deleteMedia, listMedia, requestUpload, updateMediaPosition } from "./media.service";

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

export async function postCompleteUpload(req: Request, res: Response): Promise<void> {
  const { id, mediaId } = req.valid!.params as LocationMediaParams;
  const { position } = req.valid!.body as CompleteUploadInput;
  const isAdmin = await isCallerAdmin(req);
  const media = await completeUpload(req.supabase!, req.user!.id, isAdmin, id, mediaId, position);
  created(res, media);
}

export async function getMedia(req: Request, res: Response): Promise<void> {
  const { id } = req.valid!.params as LocationIdOnlyParam;
  const media = await listMedia(req.supabase!, id);
  ok(res, media);
}

export async function patchMedia(req: Request, res: Response): Promise<void> {
  const { id, mediaId } = req.valid!.params as LocationMediaParams;
  const { position } = req.valid!.body as UpdateMediaInput;
  const isAdmin = await isCallerAdmin(req);
  const media = await updateMediaPosition(req.supabase!, req.user!.id, isAdmin, id, mediaId, position);
  ok(res, media);
}

export async function deleteMediaHandler(req: Request, res: Response): Promise<void> {
  const { id, mediaId } = req.valid!.params as LocationMediaParams;
  const isAdmin = await isCallerAdmin(req);
  await deleteMedia(req.supabase!, req.user!.id, isAdmin, id, mediaId);
  ok(res, { id: mediaId, deleted: true });
}
