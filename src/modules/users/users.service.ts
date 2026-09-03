import { SupabaseClient } from "@supabase/supabase-js";
import { NotFoundError } from "../../errors/AppError";
import { UpdateProfileInput } from "./users.schema";

export interface ProfileRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  avatar_url: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

const PROFILE_COLUMNS = "id, first_name, last_name, avatar_url, status, created_at, updated_at";

export async function getProfile(supabase: SupabaseClient, userId: string): Promise<ProfileRow> {
  const { data, error } = await supabase.from("profiles").select(PROFILE_COLUMNS).eq("id", userId).single();

  if (error || !data) {
    throw new NotFoundError("Profile not found.");
  }

  return data;
}

export async function updateProfile(
  supabase: SupabaseClient,
  userId: string,
  patch: UpdateProfileInput
): Promise<ProfileRow> {
  const { data, error } = await supabase
    .from("profiles")
    .update(patch)
    .eq("id", userId)
    .select(PROFILE_COLUMNS)
    .single();

  if (error || !data) {
    throw new NotFoundError("Profile not found.");
  }

  return data;
}

export interface PaginatedProfiles {
  data: ProfileRow[];
  total: number;
}

/**
 * Lists every profile. Relies entirely on RLS: the caller's own request-scoped
 * client is used, and the `profiles_select_own_or_admin` policy is what
 * actually allows an admin caller to see rows beyond their own — this
 * function does not, and must not, use the service-role client.
 */
export async function listAllProfiles(
  supabase: SupabaseClient,
  page: number,
  pageSize: number
): Promise<PaginatedProfiles> {
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const { data, error, count } = await supabase
    .from("profiles")
    .select(PROFILE_COLUMNS, { count: "exact" })
    .order("created_at", { ascending: false })
    .range(from, to);

  if (error) {
    throw error;
  }

  return { data: data ?? [], total: count ?? 0 };
}
