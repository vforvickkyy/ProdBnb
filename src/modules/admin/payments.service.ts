import { SupabaseClient } from "@supabase/supabase-js";
import { PaymentDetail, RefundDetail } from "../payments/payment.service";
import { AdminListPaymentsQuery, AdminListRefundsQuery } from "./admin.schema";

// Both `payments` and `payment_refunds` already have a has_role(admin)
// branch on their SELECT RLS policy (Phase 7) -- these listings use the
// caller's own request-scoped client, no adminClient needed for reads.

const PAYMENT_COLUMNS = `
  id, booking_id, provider, provider_order_id, provider_reference_id,
  status, amount_minor_units, currency, failure_reason, created_at, updated_at
`;

const REFUND_COLUMNS = `
  id, payment_id, provider_refund_id, provider_reference_id,
  status, amount_minor_units, reason, created_at, updated_at
`;

export interface PaginatedPayments {
  data: PaymentDetail[];
  total: number;
}

export interface PaginatedRefunds {
  data: RefundDetail[];
  total: number;
}

export async function listAllPayments(supabase: SupabaseClient, query: AdminListPaymentsQuery): Promise<PaginatedPayments> {
  const from = (query.page - 1) * query.pageSize;
  const to = from + query.pageSize - 1;

  let request = supabase.from("payments").select(PAYMENT_COLUMNS, { count: "exact" });
  if (query.status) {
    request = request.eq("status", query.status);
  }
  if (query.provider) {
    request = request.eq("provider", query.provider);
  }
  if (query.booking_id) {
    request = request.eq("booking_id", query.booking_id);
  }

  const { data, error, count } = await request.order("created_at", { ascending: false }).range(from, to);
  if (error) {
    throw error;
  }
  return { data: (data ?? []) as PaymentDetail[], total: count ?? 0 };
}

export async function listAllRefunds(supabase: SupabaseClient, query: AdminListRefundsQuery): Promise<PaginatedRefunds> {
  const from = (query.page - 1) * query.pageSize;
  const to = from + query.pageSize - 1;

  let request = supabase.from("payment_refunds").select(REFUND_COLUMNS, { count: "exact" });
  if (query.status) {
    request = request.eq("status", query.status);
  }

  const { data, error, count } = await request.order("created_at", { ascending: false }).range(from, to);
  if (error) {
    throw error;
  }
  return { data: (data ?? []) as RefundDetail[], total: count ?? 0 };
}
