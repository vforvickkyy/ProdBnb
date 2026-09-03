import { Request, Response } from "express";
import { anonClient } from "../../lib/supabase";
import { ok } from "../../utils/respond";
import { listAmenities, listCategories, listUseCases } from "./catalog.service";

export async function getCategories(_req: Request, res: Response): Promise<void> {
  ok(res, await listCategories(anonClient));
}

export async function getAmenities(_req: Request, res: Response): Promise<void> {
  ok(res, await listAmenities(anonClient));
}

export async function getUseCases(_req: Request, res: Response): Promise<void> {
  ok(res, await listUseCases(anonClient));
}
