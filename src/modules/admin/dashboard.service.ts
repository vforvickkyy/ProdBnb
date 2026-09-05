import { SupabaseClient } from "@supabase/supabase-js";

// Every count/sum here is a small, indexed, bounded query (a head:true count
// or a 30-day/limited-row window) via the caller's own request-scoped
// client -- RLS already grants admin full visibility on every table
// touched. No materialized view, no analytics infrastructure: this is
// deliberately the simplest thing that stays cheap at this marketplace's
// current scale (Phase 11 plan §11 — "avoid expensive dashboard queries").

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export interface DashboardSummary {
  total_users: number;
  active_hosts: number;
  published_locations: number;
  locations_awaiting_approval: number;
  upcoming_bookings: number;
  recent_bookings: { id: string; status: string; start_at: string; created_at: string }[];
  payment_activity_30d: { count: number; total_amount_minor_units: number };
  refund_activity_30d: { count: number; total_amount_minor_units: number };
  recent_admin_actions: { id: string; action: string; target_type: string; target_id: string; created_at: string }[];
}

export async function getDashboardSummary(supabase: SupabaseClient): Promise<DashboardSummary> {
  const now = new Date().toISOString();
  const since30d = new Date(Date.now() - THIRTY_DAYS_MS).toISOString();

  const [
    totalUsersRes,
    activeHostsRes,
    publishedLocationsRes,
    locationsAwaitingApprovalRes,
    upcomingBookingsRes,
    recentBookingsRes,
    recentPaymentsRes,
    recentRefundsRes,
    recentAuditRes,
  ] = await Promise.all([
    supabase.from("profiles").select("id", { count: "exact", head: true }),
    supabase
      .from("user_roles")
      .select("id, profiles!inner(status)", { count: "exact", head: true })
      .eq("role", "host")
      .eq("profiles.status", "active"),
    supabase.from("locations").select("id", { count: "exact", head: true }).eq("status", "published"),
    supabase.from("locations").select("id", { count: "exact", head: true }).in("status", ["submitted", "under_review"]),
    supabase
      .from("bookings")
      .select("id", { count: "exact", head: true })
      .in("status", ["requested", "confirmed"])
      .gt("start_at", now),
    supabase.from("bookings").select("id, status, start_at, created_at").order("created_at", { ascending: false }).limit(5),
    supabase.from("payments").select("amount_minor_units").eq("status", "success").gte("created_at", since30d),
    supabase.from("payment_refunds").select("amount_minor_units").eq("status", "success").gte("created_at", since30d),
    supabase
      .from("admin_audit_log")
      .select("id, action, target_type, target_id, created_at")
      .order("created_at", { ascending: false })
      .limit(5),
  ]);

  if (totalUsersRes.error) throw totalUsersRes.error;
  if (activeHostsRes.error) throw activeHostsRes.error;
  if (publishedLocationsRes.error) throw publishedLocationsRes.error;
  if (locationsAwaitingApprovalRes.error) throw locationsAwaitingApprovalRes.error;
  if (upcomingBookingsRes.error) throw upcomingBookingsRes.error;
  if (recentBookingsRes.error) throw recentBookingsRes.error;
  if (recentPaymentsRes.error) throw recentPaymentsRes.error;
  if (recentRefundsRes.error) throw recentRefundsRes.error;
  if (recentAuditRes.error) throw recentAuditRes.error;

  const totalUsers = totalUsersRes.count ?? 0;
  const activeHosts = activeHostsRes.count ?? 0;
  const publishedLocations = publishedLocationsRes.count ?? 0;
  const locationsAwaitingApproval = locationsAwaitingApprovalRes.count ?? 0;
  const upcomingBookings = upcomingBookingsRes.count ?? 0;

  const sum = (rows: { amount_minor_units: number }[] | null) => (rows ?? []).reduce((s, r) => s + r.amount_minor_units, 0);

  return {
    total_users: totalUsers,
    active_hosts: activeHosts,
    published_locations: publishedLocations,
    locations_awaiting_approval: locationsAwaitingApproval,
    upcoming_bookings: upcomingBookings,
    recent_bookings: recentBookingsRes.data ?? [],
    payment_activity_30d: {
      count: (recentPaymentsRes.data ?? []).length,
      total_amount_minor_units: sum(recentPaymentsRes.data),
    },
    refund_activity_30d: {
      count: (recentRefundsRes.data ?? []).length,
      total_amount_minor_units: sum(recentRefundsRes.data),
    },
    recent_admin_actions: recentAuditRes.data ?? [],
  };
}
