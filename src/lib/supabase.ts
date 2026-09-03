import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { env } from "../config/env";

/**
 * Builds a Supabase client scoped to a single request, acting as the calling
 * user (via their bearer token). All queries through this client are subject
 * to Postgres RLS as that user — this is the primary authorization boundary,
 * not just application code.
 */
export function createUserScopedClient(accessToken: string): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    global: {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

/**
 * Anon-key client with no user context. Used only to validate bearer tokens
 * (auth.getUser) before a user-scoped client can be built.
 */
export const anonClient: SupabaseClient = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

/**
 * Service-role client. Bypasses RLS entirely. Not used by any Phase 1 request
 * path — reserved for test fixtures and future server-only operations
 * (e.g. admin tooling, signed media uploads). Never expose this client or its
 * key to a client application.
 */
export const adminClient: SupabaseClient = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});
