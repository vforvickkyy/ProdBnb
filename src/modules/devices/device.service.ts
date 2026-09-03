import { SupabaseClient } from "@supabase/supabase-js";
import { NotFoundError } from "../../errors/AppError";
import { adminClient } from "../../lib/supabase";
import { RegisterDeviceInput } from "./device.schema";

const DEVICE_COLUMNS = "id, user_id, platform, environment, is_active, last_seen_at, created_at, updated_at";

export interface DeviceDetail {
  id: string;
  user_id: string;
  platform: string;
  environment: string | null;
  is_active: boolean;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
}

/**
 * `device_token` is globally unique, not scoped per user (see the Phase 8
 * migration comment on user_devices) -- registering a token that already
 * belongs to a DIFFERENT user reassigns that row rather than erroring,
 * which correctly handles "logged out, someone else logged in on the same
 * phone." RLS structurally can't allow a normal user-scoped client to touch
 * a row another user owns, so this always goes through the service-role
 * client -- the same reasoning Phase 7 applied to `payments`.
 *
 * Never returns/logs the raw device_token beyond what the caller already
 * sent it themselves.
 */
export async function registerDevice(callerId: string, input: RegisterDeviceInput): Promise<DeviceDetail> {
  const { data, error } = await adminClient
    .from("user_devices")
    .upsert(
      {
        user_id: callerId,
        platform: input.platform,
        device_token: input.device_token,
        environment: input.environment ?? null,
        is_active: true,
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: "device_token" }
    )
    .select(DEVICE_COLUMNS)
    .single();

  if (error || !data) {
    throw error ?? new Error("Failed to register device.");
  }
  return data as DeviceDetail;
}

export async function listMyDevices(supabase: SupabaseClient): Promise<DeviceDetail[]> {
  const { data, error } = await supabase
    .from("user_devices")
    .select(DEVICE_COLUMNS)
    .order("last_seen_at", { ascending: false });
  if (error) {
    throw error;
  }
  return (data ?? []) as DeviceDetail[];
}

/**
 * Soft delete (is_active = false), never hard-deleted -- preserves
 * notification_delivery_attempts history for this device. Uses the
 * caller's own request-scoped client: RLS already restricts this to a
 * device the caller owns, no cross-user concern here (unlike registration).
 */
export async function removeDevice(supabase: SupabaseClient, deviceId: string): Promise<void> {
  const { data, error } = await supabase
    .from("user_devices")
    .update({ is_active: false })
    .eq("id", deviceId)
    .select("id")
    .maybeSingle();
  if (error) {
    throw error;
  }
  if (!data) {
    throw new NotFoundError("Device not found.");
  }
}
