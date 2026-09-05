import { SupabaseClient } from "@supabase/supabase-js";
import { adminClient } from "../../lib/supabase";
import { AuditLogQuery } from "./admin.schema";

export type AuditAction =
  | "ADMIN_APPROVED_LOCATION"
  | "ADMIN_REJECTED_LOCATION"
  | "ADMIN_SUSPENDED_LOCATION"
  | "ADMIN_RESTORED_LOCATION"
  | "ADMIN_UPDATED_LOCATION_STATUS"
  | "ADMIN_SUSPENDED_USER"
  | "ADMIN_RESTORED_USER"
  | "ADMIN_CANCELLED_BOOKING"
  | "ADMIN_CREATED_REFUND";

export type AuditTargetType = "location" | "user" | "booking" | "payment";

export interface AuditLogEntry {
  id: string;
  admin_id: string;
  action: AuditAction;
  target_type: AuditTargetType;
  target_id: string;
  reason: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

const AUDIT_COLUMNS = "id, admin_id, action, target_type, target_id, reason, metadata, created_at";

/**
 * Writes exactly one audit entry, as the LAST step of a successful
 * privileged mutation. Uses the service-role client -- there is no
 * client-writable path to this table at all (see the Phase 11 migration's
 * RLS: no INSERT grant to `authenticated`), so this function is the only
 * way an entry is ever created, by any admin, for any reason.
 *
 * Deliberately not swallowed on failure the way a notification failure is
 * (src/modules/notifications/notification.service.ts): an audit entry is a
 * compliance record, not a best-effort side effect. A failure here surfaces
 * as a 500 to the caller so it's never silently lost -- but it never
 * reverses the already-committed action that preceded it either.
 */
export async function writeAuditLog(
  adminId: string,
  action: AuditAction,
  targetType: AuditTargetType,
  targetId: string,
  reason?: string | null,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  const { error } = await adminClient.from("admin_audit_log").insert({
    admin_id: adminId,
    action,
    target_type: targetType,
    target_id: targetId,
    reason: reason ?? null,
    metadata,
  });
  if (error) {
    throw error;
  }
}

export interface PaginatedAuditLog {
  data: AuditLogEntry[];
  total: number;
}

/**
 * RLS-scoped read (every admin sees every entry, via the
 * admin_audit_log_select_admin_only policy) -- uses the caller's own
 * request-scoped client, not adminClient, since reads don't need to bypass
 * RLS here.
 */
export async function listAuditLog(supabase: SupabaseClient, query: AuditLogQuery): Promise<PaginatedAuditLog> {
  const from = (query.page - 1) * query.pageSize;
  const to = from + query.pageSize - 1;

  let request = supabase.from("admin_audit_log").select(AUDIT_COLUMNS, { count: "exact" });
  if (query.target_type) {
    request = request.eq("target_type", query.target_type);
  }
  if (query.target_id) {
    request = request.eq("target_id", query.target_id);
  }
  if (query.admin_id) {
    request = request.eq("admin_id", query.admin_id);
  }
  if (query.action) {
    request = request.eq("action", query.action);
  }
  if (query.created_after) {
    request = request.gte("created_at", query.created_after);
  }
  if (query.created_before) {
    request = request.lte("created_at", query.created_before);
  }

  const { data, error, count } = await request.order("created_at", { ascending: false }).range(from, to);
  if (error) {
    throw error;
  }

  return { data: (data ?? []) as AuditLogEntry[], total: count ?? 0 };
}
