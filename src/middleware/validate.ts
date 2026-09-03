import { NextFunction, Request, Response } from "express";
import { ZodSchema } from "zod";
import { ValidationError } from "../errors/AppError";

interface ValidateSchemas {
  body?: ZodSchema;
  query?: ZodSchema;
  params?: ZodSchema;
}

/**
 * Parses/validates request data with the given zod schemas and stores the
 * result on `req.valid` (rather than overwriting req.body/query/params) so
 * controllers always read trusted, typed data from one predictable place.
 */
export function validate(schemas: ValidateSchemas) {
  return function (req: Request, _res: Response, next: NextFunction): void {
    const valid: NonNullable<Request["valid"]> = {};

    if (schemas.body) {
      const result = schemas.body.safeParse(req.body);
      if (!result.success) {
        throw new ValidationError("Invalid request body.", result.error.flatten());
      }
      valid.body = result.data;
    }

    if (schemas.query) {
      const result = schemas.query.safeParse(req.query);
      if (!result.success) {
        throw new ValidationError("Invalid query parameters.", result.error.flatten());
      }
      valid.query = result.data;
    }

    if (schemas.params) {
      const result = schemas.params.safeParse(req.params);
      if (!result.success) {
        throw new ValidationError("Invalid path parameters.", result.error.flatten());
      }
      valid.params = result.data;
    }

    req.valid = valid;
    next();
  };
}
