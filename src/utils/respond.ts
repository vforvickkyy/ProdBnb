import { Response } from "express";

interface PaginationMeta {
  page: number;
  pageSize: number;
  total: number;
}

export function ok<T>(res: Response, data: T, status = 200, meta?: PaginationMeta): void {
  res.status(status).json(meta ? { data, meta } : { data });
}

export function created<T>(res: Response, data: T): void {
  ok(res, data, 201);
}
