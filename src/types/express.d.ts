import type { SupabaseClient } from "@supabase/supabase-js";

declare global {
  namespace Express {
    interface Request {
      /** Present once middleware/auth.ts has run successfully. */
      user?: {
        id: string;
        email: string | null;
      };
      /** Supabase client scoped to the calling user's JWT — RLS applies. */
      supabase?: SupabaseClient;
      /** Populated by middleware/validate.ts — parsed, schema-validated request data. */
      valid?: {
        body?: unknown;
        query?: unknown;
        params?: unknown;
      };
    }
  }
}

export {};
