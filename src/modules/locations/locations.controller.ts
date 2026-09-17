import { Request, Response } from "express";
import { callerHasRole } from "../../middleware/requireRole";
import { created, ok } from "../../utils/respond";
import {
  AdminListLocationsQuery,
  CreateLocationInput,
  ListLocationsQuery,
  LocationIdParam,
  UpdateLocationInput,
} from "./locations.schema";
import {
  createLocation,
  deleteLocation,
  getLocation,
  listAllLocationsForAdmin,
  listMyLocations,
  updateLocation,
} from "./locations.service";
import { sectionSummariesFor } from "../sections/sections.service";

export async function getLocationDetail(req: Request, res: Response): Promise<void> {
  const { id } = req.valid!.params as LocationIdParam;
  const location = await getLocation(req.supabase!, id);
  // Phase 29.6: lightweight section metadata — id/name/description/cover/photo_count — so a client
  // can render a section rail from this one response. Deliberately NOT every photo of every
  // section: that would make a 20-section location's detail hundreds of media rows. The full
  // gallery is one request away at GET /v1/locations/:id/sections/:sectionId/media.
  const sections = await sectionSummariesFor(req.supabase!, id);
  ok(res, { ...location, sections });
}

export async function postLocation(req: Request, res: Response): Promise<void> {
  const input = req.valid!.body as CreateLocationInput;
  const location = await createLocation(req.supabase!, req.user!.id, input);
  created(res, location);
}

export async function patchLocation(req: Request, res: Response): Promise<void> {
  const { id } = req.valid!.params as LocationIdParam;
  const input = req.valid!.body as UpdateLocationInput;
  const isAdmin = await callerHasRole(req.supabase!, req.user!.id, "admin");
  const location = await updateLocation(req.supabase!, req.user!.id, isAdmin, id, input);
  ok(res, location);
}

export async function deleteLocationHandler(req: Request, res: Response): Promise<void> {
  const { id } = req.valid!.params as LocationIdParam;
  const isAdmin = await callerHasRole(req.supabase!, req.user!.id, "admin");
  await deleteLocation(req.supabase!, req.user!.id, isAdmin, id);
  ok(res, { id, deleted: true });
}

export async function getMyLocations(req: Request, res: Response): Promise<void> {
  const { page, pageSize } = req.valid!.query as ListLocationsQuery;
  const { data, total } = await listMyLocations(req.supabase!, req.user!.id, page, pageSize);
  ok(res, data, 200, { page, pageSize, total });
}

export async function getAdminLocations(req: Request, res: Response): Promise<void> {
  const { page, pageSize, status, host_id, search } = req.valid!.query as AdminListLocationsQuery;
  const { data, total } = await listAllLocationsForAdmin(req.supabase!, page, pageSize, { status, hostId: host_id, search });
  ok(res, data, 200, { page, pageSize, total });
}
