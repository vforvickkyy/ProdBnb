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
const ADMIN_PROFILE_COLUMNS = `${PROFILE_COLUMNS}, user_roles ( role )`;

export interface AdminProfileRow extends ProfileRow {
  roles: string[];
}

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

export interface PaginatedAdminProfiles {
  data: AdminProfileRow[];
  total: number;
}

export interface ListProfilesFilters {
  search?: string;
  role?: string;
  status?: string;
}

interface RawAdminProfileRow extends ProfileRow {
  user_roles: { role: string }[];
}

/**
 * Lists every profile, with each row's roles flattened in — useful for the
 * admin listing directly, rather than a separate per-user roles call.
 * Relies entirely on RLS: the caller's own request-scoped client is used,
 * and the `profiles_select_own_or_admin` policy is what actually allows an
 * admin caller to see rows beyond their own — this function does not, and
 * must not, use the service-role client. `role`/`status`/`search` are
 * admin-only filters in practice (this is `GET /v1/admin/users`'s only
 * backing function) — a non-admin's own single row is unaffected by them.
 */
export async function listAllProfiles(
  supabase: SupabaseClient,
  page: number,
  pageSize: number,
  filters: ListProfilesFilters = {}
): Promise<PaginatedAdminProfiles> {
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  // PostgREST only treats an embedded-resource filter as row-restricting
  // (rather than just filtering what appears inside the nested array) when
  // the embed is marked `!inner` -- the default embed leaves every outer
  // row in place regardless of the filter. Only switched to `!inner` when a
  // role filter is actually requested: unlike bookings->locations (a
  // required, single relation), a profile can genuinely have zero roles,
  // and the unfiltered listing must still show those rows.
  const columns = filters.role ? ADMIN_PROFILE_COLUMNS.replace("user_roles (", "user_roles!inner (") : ADMIN_PROFILE_COLUMNS;
  let query = supabase.from("profiles").select(columns, { count: "exact" });

  if (filters.status) {
    query = query.eq("status", filters.status);
  }
  if (filters.search) {
    query = query.or(`first_name.ilike.%${filters.search}%,last_name.ilike.%${filters.search}%`);
  }
  if (filters.role) {
    query = query.eq("user_roles.role", filters.role);
  }

  const { data, error, count } = await query.order("created_at", { ascending: false }).range(from, to);

  if (error) {
    throw error;
  }

  const rows = ((data ?? []) as unknown as RawAdminProfileRow[]).map((row) => {
    const { user_roles, ...profile } = row;
    return { ...profile, roles: user_roles.map((r) => r.role) };
  });

  return { data: rows, total: count ?? 0 };
}
