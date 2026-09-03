import { Request, Response } from "express";
import { ok } from "../../utils/respond";
import { SearchLocationsQuery } from "./search.schema";
import { searchLocations } from "./search.service";

export async function getSearchResults(req: Request, res: Response): Promise<void> {
  const query = req.valid!.query as SearchLocationsQuery;
  const { data, total } = await searchLocations(query);
  ok(res, data, 200, { page: query.page, pageSize: query.pageSize, total });
}
