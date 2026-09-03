import { z } from "zod";

const uuid = z.string().uuid();

const commaSeparatedUuids = (max: number) =>
  z.preprocess(
    (val) => (typeof val === "string" ? val.split(",").map((s) => s.trim()).filter(Boolean) : val),
    z.array(uuid).max(max)
  );

export const sortSchema = z.enum(["newest", "relevant", "nearest"]);

export const searchLocationsQuerySchema = z
  .object({
    search: z.string().trim().min(1).max(200).optional(),
    city: z.string().trim().min(1).max(120).optional(),
    region: z.string().trim().min(1).max(120).optional(),
    country: z.string().trim().min(1).max(120).optional(),
    category_ids: commaSeparatedUuids(20).optional(),
    amenity_ids: commaSeparatedUuids(20).optional(),
    use_case_ids: commaSeparatedUuids(20).optional(),
    capacity_min: z.coerce.number().int().positive().optional(),
    capacity_max: z.coerce.number().int().positive().optional(),
    lat: z.coerce.number().min(-90).max(90).optional(),
    lng: z.coerce.number().min(-180).max(180).optional(),
    radius_km: z.coerce.number().positive().max(500).optional(),
    north: z.coerce.number().min(-90).max(90).optional(),
    south: z.coerce.number().min(-90).max(90).optional(),
    east: z.coerce.number().min(-180).max(180).optional(),
    west: z.coerce.number().min(-180).max(180).optional(),
    sort: sortSchema.optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict()
  .refine((data) => data.capacity_min === undefined || data.capacity_max === undefined || data.capacity_min <= data.capacity_max, {
    message: "capacity_min must be less than or equal to capacity_max.",
    path: ["capacity_min"],
  })
  .refine((data) => (data.lat === undefined) === (data.lng === undefined), {
    message: "lat and lng must be provided together.",
    path: ["lat"],
  })
  .refine((data) => data.radius_km === undefined || (data.lat !== undefined && data.lng !== undefined), {
    message: "radius_km requires lat and lng.",
    path: ["radius_km"],
  })
  .refine(
    (data) => {
      const box = [data.north, data.south, data.east, data.west];
      const provided = box.filter((v) => v !== undefined).length;
      return provided === 0 || provided === 4;
    },
    { message: "north, south, east, and west must all be provided together.", path: ["north"] }
  )
  .refine((data) => data.north === undefined || data.south === undefined || data.north > data.south, {
    message: "north must be greater than south.",
    path: ["north"],
  })
  .refine((data) => data.east === undefined || data.west === undefined || data.east > data.west, {
    message: "east must be greater than west (bounding boxes crossing the antimeridian are not supported).",
    path: ["east"],
  })
  .refine((data) => data.sort !== "nearest" || (data.lat !== undefined && data.lng !== undefined), {
    message: "sort=nearest requires lat and lng.",
    path: ["sort"],
  });

export type SearchLocationsQuery = z.infer<typeof searchLocationsQuerySchema>;
