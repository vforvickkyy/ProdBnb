import { NextFunction, Request, Response } from "express";
import { AppError } from "../errors/AppError";

interface ErrorResponseBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export function notFoundHandler(req: Request, res: Response): void {
  const body: ErrorResponseBody = {
    error: {
      code: "NOT_FOUND",
      message: `No route matches ${req.method} ${req.path}.`,
    },
  };
  res.status(404).json(body);
}

/**
 * Central error → JSON translator. Known AppErrors pass their status/code/
 * message straight through. Anything else (a bug, a Supabase/Postgres error,
 * etc.) is logged in full server-side but reported to the client as a plain
 * 500 — never leaking stack traces, query text, or other internals.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    const body: ErrorResponseBody = {
      error: { code: err.code, message: err.message, details: err.details },
    };
    res.status(err.status).json(body);
    return;
  }

  console.error(`Unhandled error on ${req.method} ${req.path}:`, err);

  const body: ErrorResponseBody = {
    error: { code: "INTERNAL_ERROR", message: "Something went wrong. Please try again." },
  };
  res.status(500).json(body);
}
