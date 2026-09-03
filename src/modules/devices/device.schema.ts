import { z } from "zod";

const uuid = z.string().uuid();

export const devicePlatformSchema = z.enum(["ios", "android", "web"]);
export type DevicePlatform = z.infer<typeof devicePlatformSchema>;

export const deviceEnvironmentSchema = z.enum(["sandbox", "production"]);
export type DeviceEnvironment = z.infer<typeof deviceEnvironmentSchema>;

// No user_id field -- the recipient is always the authenticated caller,
// never client-supplied (same as every other "create a resource for
// yourself" endpoint in this codebase).
export const registerDeviceSchema = z
  .object({
    device_token: z.string().trim().min(1).max(4096),
    platform: devicePlatformSchema,
    environment: deviceEnvironmentSchema.optional(),
  })
  .strict();
export type RegisterDeviceInput = z.infer<typeof registerDeviceSchema>;

export const deviceIdParamSchema = z.object({ id: uuid });
export type DeviceIdParam = z.infer<typeof deviceIdParamSchema>;
