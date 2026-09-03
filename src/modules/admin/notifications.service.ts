import { adminClient } from "../../lib/supabase";
import { DeliveryAttemptsQuery } from "./admin.schema";

// notification_delivery_attempts has NO authenticated/anon access at all
// (Phase 8) -- adminClient is the only way to read it, for anyone,
// including admin. This is diagnostics only (status/provider/error_reason
// per device) -- never a user's notification content (title/body), which
// stays strictly private (Phase 8 plan §14 / Phase 11 plan §14).

export interface DeliveryAttemptRow {
  id: string;
  notification_id: string;
  device_id: string;
  provider: string;
  status: string;
  provider_message_id: string | null;
  error_reason: string | null;
  created_at: string;
}

export interface PaginatedDeliveryAttempts {
  data: DeliveryAttemptRow[];
  total: number;
}

const DELIVERY_ATTEMPT_COLUMNS = "id, notification_id, device_id, provider, status, provider_message_id, error_reason, created_at";

export async function listDeliveryAttempts(query: DeliveryAttemptsQuery): Promise<PaginatedDeliveryAttempts> {
  const from = (query.page - 1) * query.pageSize;
  const to = from + query.pageSize - 1;

  let request = adminClient.from("notification_delivery_attempts").select(DELIVERY_ATTEMPT_COLUMNS, { count: "exact" });

  if (query.notification_id) {
    request = request.eq("notification_id", query.notification_id);
  } else if (query.booking_id) {
    const { data: notifications, error: notifError } = await adminClient
      .from("notifications")
      .select("id")
      .eq("entity_type", "booking")
      .eq("entity_id", query.booking_id);
    if (notifError) {
      throw notifError;
    }
    const notificationIds = (notifications ?? []).map((n) => n.id as string);
    // A non-matching filter (rather than skipping the .in() entirely) so an
    // unknown/no-notification booking correctly returns an empty page
    // instead of every delivery attempt in the table.
    request = request.in("notification_id", notificationIds.length > 0 ? notificationIds : ["00000000-0000-0000-0000-000000000000"]);
  }

  const { data, error, count } = await request.order("created_at", { ascending: false }).range(from, to);
  if (error) {
    throw error;
  }
  return { data: (data ?? []) as DeliveryAttemptRow[], total: count ?? 0 };
}
