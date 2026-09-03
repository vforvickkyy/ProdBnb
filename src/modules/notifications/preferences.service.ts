import { SupabaseClient } from "@supabase/supabase-js";
import { adminClient } from "../../lib/supabase";
import { PreferenceCategory, UpdatePreferencesInput } from "./notification.schema";

const CATEGORIES: PreferenceCategory[] = ["booking", "payment"];

export interface PreferencesView {
  booking: boolean;
  payment: boolean;
}

/**
 * A missing row means enabled -- the safe default (Phase 8 plan §5), so a
 * user who never opens settings still gets transactional push delivery.
 */
export async function getPreferences(supabase: SupabaseClient, userId: string): Promise<PreferencesView> {
  const { data, error } = await supabase.from("notification_preferences").select("category, enabled").eq("user_id", userId);
  if (error) {
    throw error;
  }

  const byCategory = new Map((data ?? []).map((row) => [row.category, row.enabled]));
  return {
    booking: byCategory.get("booking") ?? true,
    payment: byCategory.get("payment") ?? true,
  };
}

export async function updatePreferences(
  supabase: SupabaseClient,
  userId: string,
  input: UpdatePreferencesInput
): Promise<PreferencesView> {
  const rows = CATEGORIES.filter((category) => input[category] !== undefined).map((category) => ({
    user_id: userId,
    category,
    enabled: input[category] as boolean,
  }));

  const { error } = await supabase.from("notification_preferences").upsert(rows, { onConflict: "user_id,category" });
  if (error) {
    throw error;
  }

  return getPreferences(supabase, userId);
}

/**
 * Internal check used by notification.service.ts before attempting push
 * delivery -- gates delivery only, never notification creation (see the
 * migration's comment on notification_preferences for why). Uses the
 * service-role client: this runs from within server-side notify*() calls
 * triggered by booking/payment transitions, not from an authenticated
 * request the recipient themselves made.
 */
export async function isPushEnabled(userId: string, category: PreferenceCategory): Promise<boolean> {
  const { data, error } = await adminClient
    .from("notification_preferences")
    .select("enabled")
    .eq("user_id", userId)
    .eq("category", category)
    .maybeSingle();
  if (error) {
    throw error;
  }
  return data?.enabled ?? true;
}
