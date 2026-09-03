import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  CORS_ORIGINS: z
    .string()
    .default("")
    .transform((value) =>
      value
        .split(",")
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0)
    ),
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  R2_ACCOUNT_ID: z.string().min(1),
  R2_BUCKET_NAME: z.string().min(1),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  R2_PUBLIC_BASE_URL: z.string().url(),
  R2_UPLOAD_URL_EXPIRY_SECONDS: z.coerce.number().int().positive().default(900),

  MEDIA_MAX_PHOTO_SIZE_MB: z.coerce.number().int().positive().default(20),
  MEDIA_MAX_VIDEO_SIZE_MB: z.coerce.number().int().positive().default(500),

  // This server's own publicly-reachable base URL — used to build the
  // webhook notify_url handed to payment providers server-side. Never
  // influenced by a client request.
  API_BASE_URL: z.string().url().default("http://localhost:4000"),

  // Which PaymentProvider implementation is active (see
  // src/modules/payments/providers/index.ts). Only "cashfree" exists so far.
  PAYMENT_PROVIDER: z.enum(["cashfree"]).default("cashfree"),

  // Cashfree is test/sandbox-only in this phase — deliberately the only
  // accepted value, so switching to production Cashfree credentials later is
  // a conscious one-line schema change (adding "production" here plus its
  // host mapping in CashfreeProvider), never an accidental config typo.
  CASHFREE_ENV: z.enum(["test"]).default("test"),
  CASHFREE_APP_ID: z.string().min(1),
  CASHFREE_SECRET_KEY: z.string().min(1),
  CASHFREE_API_VERSION: z.string().min(1).default("2023-08-01"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:");
  console.error(parsed.error.flatten().fieldErrors);
  throw new Error("Missing or invalid environment variables. Check .env against .env.example.");
}

export const env = parsed.data;
