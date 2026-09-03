import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { env } from "../src/config/env";

/**
 * Test-only helpers for creating throwaway Supabase Auth users against the
 * LOCAL Supabase stack (`supabase start`) and obtaining a real access token
 * for them, so tests exercise real Postgres RLS rather than mocks.
 */

export const adminClient: SupabaseClient = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export interface TestUser {
  id: string;
  email: string;
  accessToken: string;
}

let counter = 0;

export async function createTestUser(): Promise<TestUser> {
  counter += 1;
  const email = `test-user-${Date.now()}-${counter}@example.com`;
  const password = "correct horse battery staple 1!";

  const { data: created, error: createError } = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (createError || !created.user) {
    throw createError ?? new Error("Failed to create test user.");
  }

  const anon = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: signIn, error: signInError } = await anon.auth.signInWithPassword({ email, password });

  if (signInError || !signIn.session) {
    throw signInError ?? new Error("Failed to sign in test user.");
  }

  return { id: created.user.id, email, accessToken: signIn.session.access_token };
}

export async function deleteTestUser(userId: string): Promise<void> {
  await adminClient.auth.admin.deleteUser(userId);
}

export async function grantAdminRole(userId: string): Promise<void> {
  const { error } = await adminClient.from("user_roles").insert({ user_id: userId, role: "admin" });
  if (error) {
    throw error;
  }
}
