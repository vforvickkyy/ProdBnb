import { Response } from "express";

export function ok<T, M extends Record<string, unknown> = Record<string, unknown>>(
  res: Response,
  data: T,
  status = 200,
  meta?: M
): void {
  res.status(status).json(meta ? { data, meta } : { data });
}

export function created<T>(res: Response, data: T): void {
  ok(res, data, 201);
}
