import { SupabaseClient } from "@supabase/supabase-js";
import { NotFoundError } from "../../errors/AppError";
import { UpdateProfileInput } from "./users.schema";

/**
 * The profile fields that existed before Phase 26-MB, and the only ones the
 * admin listing selects. Split out so `AdminProfileRow` cannot claim the
 * contact fields it deliberately does not fetch (see `ADMIN_PROFILE_COLUMNS`).
 */
interface ProfileBaseRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  avatar_url: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

/**
 * What `GET /v1/me` returns: the base profile plus the user's own contact
 * details (Phase 26-MB). All nullable — a profile that predates the migration,
 * or a user who simply never supplied them, reads back `null`.
 *
 * `email` is deliberately absent, as it always has been: it lives in
 * `auth.users` and is sourced from the session, never duplicated here
 * (docs/DATABASE.md).
 */
export interface ProfileRow extends ProfileBaseRow {
  phone: string | null;
  address_line1: string | null;
  address_line2: string | null;
  address_city: string | null;
  address_region: string | null;
  address_country: string | null;
  address_postal_code: string | null;
}

// Kept as a single string literal, not a concatenation: supabase-js infers the
// row type from the literal, and `"a" + "b"` widens it to `string`, which
// collapses the inferred result to an error type.
const PROFILE_COLUMNS =
  "id, first_name, last_name, avatar_url, phone, address_line1, address_line2, address_city, address_region, address_country, address_postal_code, status, created_at, updated_at";

/**
 * The admin listing's columns, deliberately **not** derived from
 * `PROFILE_COLUMNS` any more (Phase 26-MB).
 *
 * Before this phase the two were the same string, so extending one silently
 * extended the other. A user's phone number and home address are materially
 * more sensitive than their display name, and nothing in this phase asked for
 * them to appear in the admin user list — so the admin contract is left
 * exactly as it was. Decoupling makes that a decision rather than an accident.
 */
const ADMIN_PROFILE_COLUMNS =
  "id, first_name, last_name, avatar_url, status, created_at, updated_at, user_roles ( role )";

export interface AdminProfileRow extends ProfileBaseRow {
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
  data: ProfileBaseRow[];
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

interface RawAdminProfileRow extends ProfileBaseRow {
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
