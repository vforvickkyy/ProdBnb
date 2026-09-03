import { z } from "zod";

const uuid = z.string().uuid();
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be an ISO date, e.g. 2026-10-05.");
const timeOnly = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, "Must be HH:MM or HH:MM:SS.");

export const dayOfWeekSchema = z.enum(["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]);

// --- weekly rules ---

export const createRuleSchema = z
  .object({
    day_of_week: dayOfWeekSchema,
    start_time: timeOnly,
    end_time: timeOnly,
  })
  .strict()
  .refine((d) => d.end_time > d.start_time, { message: "end_time must be after start_time.", path: ["end_time"] });
export type CreateRuleInput = z.infer<typeof createRuleSchema>;

export const updateRuleSchema = z
  .object({
    day_of_week: dayOfWeekSchema.optional(),
    start_time: timeOnly.optional(),
    end_time: timeOnly.optional(),
  })
  .strict()
  .refine((d) => Object.keys(d).length > 0, { message: "Provide at least one field to update." })
  .refine((d) => d.start_time === undefined || d.end_time === undefined || d.end_time > d.start_time, {
    message: "end_time must be after start_time.",
    path: ["end_time"],
  });
export type UpdateRuleInput = z.infer<typeof updateRuleSchema>;

// --- date overrides ---

export const createOverrideSchema = z
  .object({
    date: dateOnly,
    status: z.enum(["available", "unavailable"]),
    start_time: timeOnly.optional(),
    end_time: timeOnly.optional(),
  })
  .strict()
  .refine((d) => d.status !== "unavailable" || (d.start_time === undefined && d.end_time === undefined), {
    message: "An unavailable override cannot specify start_time/end_time.",
    path: ["status"],
  })
  .refine((d) => d.status !== "available" || (d.start_time !== undefined && d.end_time !== undefined), {
    message: "An available override must specify both start_time and end_time.",
    path: ["status"],
  })
  .refine((d) => d.start_time === undefined || d.end_time === undefined || d.end_time > d.start_time, {
    message: "end_time must be after start_time.",
    path: ["end_time"],
  });
export type CreateOverrideInput = z.infer<typeof createOverrideSchema>;

export const updateOverrideSchema = z
  .object({
    status: z.enum(["available", "unavailable"]).optional(),
    start_time: timeOnly.optional(),
    end_time: timeOnly.optional(),
  })
  .strict()
  .refine((d) => Object.keys(d).length > 0, { message: "Provide at least one field to update." })
  .refine((d) => d.status !== "unavailable" || (d.start_time === undefined && d.end_time === undefined), {
    message: "Switching to unavailable cannot specify start_time/end_time.",
    path: ["status"],
  })
  .refine((d) => d.status !== "available" || (d.start_time !== undefined && d.end_time !== undefined), {
    message: "Switching to available must specify both start_time and end_time in the same request.",
    path: ["status"],
  })
  .refine((d) => d.start_time === undefined || d.end_time === undefined || d.end_time > d.start_time, {
    message: "end_time must be after start_time.",
    path: ["end_time"],
  });
export type UpdateOverrideInput = z.infer<typeof updateOverrideSchema>;

// --- blocked periods ---

export const createBlockSchema = z
  .object({
    start_at: z.string().datetime({ offset: true }),
    end_at: z.string().datetime({ offset: true }),
    reason: z.string().max(500).nullable().optional(),
  })
  .strict()
  .refine((d) => new Date(d.end_at) > new Date(d.start_at), {
    message: "end_at must be after start_at.",
    path: ["end_at"],
  });
export type CreateBlockInput = z.infer<typeof createBlockSchema>;

export const updateBlockSchema = z
  .object({
    start_at: z.string().datetime({ offset: true }).optional(),
    end_at: z.string().datetime({ offset: true }).optional(),
    reason: z.string().max(500).nullable().optional(),
  })
  .strict()
  .refine((d) => Object.keys(d).length > 0, { message: "Provide at least one field to update." })
  .refine((d) => d.start_at === undefined || d.end_at === undefined || new Date(d.end_at) > new Date(d.start_at), {
    message: "end_at must be after start_at.",
    path: ["end_at"],
  });
export type UpdateBlockInput = z.infer<typeof updateBlockSchema>;

// --- public computed availability query ---

const MAX_RANGE_DAYS = 90;

export const availabilityQuerySchema = z
  .object({
    from: dateOnly,
    to: dateOnly,
  })
  .strict()
  .refine((d) => new Date(d.to) >= new Date(d.from), { message: "to must not be before from.", path: ["to"] })
  .refine(
    (d) => {
      const days = (new Date(d.to).getTime() - new Date(d.from).getTime()) / 86_400_000;
      return days <= MAX_RANGE_DAYS;
    },
    { message: `Date range must not exceed ${MAX_RANGE_DAYS} days.`, path: ["to"] }
  );
export type AvailabilityQuery = z.infer<typeof availabilityQuerySchema>;

// --- params ---

export const locationIdParamSchema = z.object({ id: uuid });
export type LocationIdParam = z.infer<typeof locationIdParamSchema>;

export const ruleParamsSchema = z.object({ id: uuid, ruleId: uuid });
export type RuleParams = z.infer<typeof ruleParamsSchema>;

export const overrideParamsSchema = z.object({ id: uuid, overrideId: uuid });
export type OverrideParams = z.infer<typeof overrideParamsSchema>;

export const blockParamsSchema = z.object({ id: uuid, blockId: uuid });
export type BlockParams = z.infer<typeof blockParamsSchema>;
