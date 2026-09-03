import { createHash, randomUUID } from "crypto";
import { SupabaseClient } from "@supabase/supabase-js";
import { env } from "../../config/env";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../../errors/AppError";
import { adminClient } from "../../lib/supabase";
import { getBooking } from "../bookings/bookings.service";
import { CreatePaymentInput, CreateRefundInput } from "./payment.schema";
import { getPaymentProvider } from "./providers";
import { NormalizedPaymentStatus, NormalizedWebhookEvent } from "./providers/PaymentProvider";

const UNIQUE_VIOLATION = "23505";

const PAYMENT_COLUMNS = `
  id, booking_id, provider, provider_order_id, provider_reference_id,
  status, amount_minor_units, currency, failure_reason, created_at, updated_at
`;

const REFUND_COLUMNS = `
  id, payment_id, provider_refund_id, provider_reference_id,
  status, amount_minor_units, reason, created_at, updated_at
`;

export interface PaymentDetail {
  id: string;
  booking_id: string;
  provider: string;
  provider_order_id: string;
  provider_reference_id: string | null;
  status: string;
  amount_minor_units: number;
  currency: string;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface RefundDetail {
  id: string;
  payment_id: string;
  provider_refund_id: string;
  provider_reference_id: string | null;
  status: string;
  amount_minor_units: number;
  reason: string | null;
  created_at: string;
  updated_at: string;
}

// A payment never regresses out of one of these once reached (decision #5
// in the Phase 7 plan) -- a delayed/out-of-order webhook can only ever be a
// no-op against a payment that's already settled.
const TERMINAL_PAYMENT_STATUSES = new Set(["success", "failed", "cancelled", "refunded", "partially_refunded"]);
const TERMINAL_REFUND_STATUSES = new Set(["success", "failed", "cancelled"]);

function nextPaymentStatus(current: string, incoming: NormalizedPaymentStatus): NormalizedPaymentStatus {
  if (TERMINAL_PAYMENT_STATUSES.has(current)) {
    return current as NormalizedPaymentStatus;
  }
  return incoming;
}

async function applyPaymentStatusUpdate(
  paymentId: string,
  currentStatus: string,
  incomingStatus: NormalizedPaymentStatus,
  providerReferenceId: string | null,
  raw: unknown,
  failureReason: string | null
): Promise<PaymentDetail> {
  const resolved = nextPaymentStatus(currentStatus, incomingStatus);
  const patch: Record<string, unknown> = { status: resolved, provider_raw: raw };
  if (providerReferenceId) {
    patch.provider_reference_id = providerReferenceId;
  }
  if (resolved === "failed" && failureReason) {
    patch.failure_reason = failureReason;
  }

  const { data, error } = await adminClient.from("payments").update(patch).eq("id", paymentId).select(PAYMENT_COLUMNS).single();
  if (error || !data) {
    throw error ?? new Error("Failed to update payment.");
  }
  return data as PaymentDetail;
}

/**
 * Only the booker themselves may pay for their own booking, only while it's
 * still `requested`/`confirmed` (Phase 6A statuses, unmodified -- payment
 * never adds a new one). The booking's own immutable price snapshot
 * (`bookings.total_amount_minor_units`/`currency`) is the sole amount
 * source -- nothing here reads or trusts any client-supplied amount.
 */
export async function createPayment(
  supabase: SupabaseClient,
  callerId: string,
  bookerEmail: string | null,
  bookingId: string,
  input: CreatePaymentInput
): Promise<{ payment: PaymentDetail; checkout: Record<string, unknown> }> {
  const booking = await getBooking(supabase, bookingId);
  if (booking.booker_id !== callerId) {
    throw new ForbiddenError("Only the booker can pay for this booking.");
  }
  if (booking.status !== "requested" && booking.status !== "confirmed") {
    throw new ValidationError(`Cannot create a payment for a booking with status '${booking.status}'.`);
  }

  const { data: inFlight, error: inFlightError } = await adminClient
    .from("payments")
    .select("id")
    .eq("booking_id", bookingId)
    .in("status", ["created", "pending"])
    .maybeSingle();
  if (inFlightError) {
    throw inFlightError;
  }
  if (inFlight) {
    throw new ConflictError("A payment is already in progress for this booking.");
  }

  const paymentId = randomUUID();
  const providerOrderId = `pb_${paymentId.replace(/-/g, "")}`;
  const provider = getPaymentProvider();

  const { error: insertError } = await adminClient.from("payments").insert({
    id: paymentId,
    booking_id: bookingId,
    provider: provider.name,
    provider_order_id: providerOrderId,
    status: "created",
    amount_minor_units: booking.pricing.total_amount_minor_units,
    currency: booking.pricing.currency,
  });
  if (insertError) {
    // The partial unique index (payments_one_inflight_per_booking) is the
    // real backstop against a double-submit race -- the pre-check above is
    // just for a clean error message in the common case.
    if (insertError.code === UNIQUE_VIOLATION) {
      throw new ConflictError("A payment is already in progress for this booking.");
    }
    throw insertError;
  }

  let createResult;
  try {
    createResult = await provider.createOrder({
      merchantOrderId: providerOrderId,
      amountMinorUnits: booking.pricing.total_amount_minor_units,
      currency: booking.pricing.currency,
      customer: { id: callerId, email: bookerEmail, phone: input.customer_phone },
      returnUrl: input.return_url ?? `${env.API_BASE_URL}/v1/payments/return`,
      notifyUrl: `${env.API_BASE_URL}/v1/payments/webhooks/cashfree`,
    });
  } catch (err) {
    await adminClient
      .from("payments")
      .update({ status: "failed", failure_reason: "Provider order creation failed." })
      .eq("id", paymentId);
    throw err;
  }

  const { data: updated, error: updateError } = await adminClient
    .from("payments")
    .update({
      status: createResult.status,
      provider_reference_id: createResult.providerReferenceId,
      provider_raw: createResult.raw,
    })
    .eq("id", paymentId)
    .select(PAYMENT_COLUMNS)
    .single();
  if (updateError || !updated) {
    throw updateError ?? new Error("Failed to update payment after provider order creation.");
  }

  return { payment: updated as PaymentDetail, checkout: createResult.checkout };
}

export async function listPaymentsForBooking(supabase: SupabaseClient, bookingId: string): Promise<PaymentDetail[]> {
  const { data, error } = await supabase
    .from("payments")
    .select(PAYMENT_COLUMNS)
    .eq("booking_id", bookingId)
    .order("created_at", { ascending: false });
  if (error) {
    throw error;
  }
  return (data ?? []) as PaymentDetail[];
}

export async function getPayment(supabase: SupabaseClient, id: string): Promise<PaymentDetail> {
  const { data, error } = await supabase.from("payments").select(PAYMENT_COLUMNS).eq("id", id).maybeSingle();
  if (error) {
    throw error;
  }
  if (!data) {
    throw new NotFoundError("Payment not found.");
  }
  return data as PaymentDetail;
}

export async function listRefunds(supabase: SupabaseClient, paymentId: string): Promise<RefundDetail[]> {
  const { data, error } = await supabase
    .from("payment_refunds")
    .select(REFUND_COLUMNS)
    .eq("payment_id", paymentId)
    .order("created_at", { ascending: false });
  if (error) {
    throw error;
  }
  return (data ?? []) as RefundDetail[];
}

/**
 * Server-side re-check against the provider, independent of webhook timing
 * -- never trusts a client's own "it succeeded" claim (§11/§17). A no-op if
 * the payment already reached a terminal status.
 */
export async function verifyPayment(supabase: SupabaseClient, paymentId: string): Promise<PaymentDetail> {
  const current = await getPayment(supabase, paymentId);
  if (TERMINAL_PAYMENT_STATUSES.has(current.status)) {
    return current;
  }

  const provider = getPaymentProvider();
  const result = await provider.fetchOrderStatus(current.provider_order_id);
  return applyPaymentStatusUpdate(current.id, current.status, result.status, result.providerReferenceId, result.raw, null);
}

async function recomputePaymentRefundStatus(paymentId: string): Promise<void> {
  const { data: payment, error } = await adminClient
    .from("payments")
    .select("id, amount_minor_units, status")
    .eq("id", paymentId)
    .single();
  if (error || !payment) {
    throw error ?? new Error("Payment not found while recomputing refund status.");
  }
  // A payment that failed/was cancelled outright is never touched by refund
  // bookkeeping -- only success/partially_refunded/refunded are relevant.
  if (payment.status !== "success" && payment.status !== "partially_refunded" && payment.status !== "refunded") {
    return;
  }

  const { data: refunds, error: refundsError } = await adminClient
    .from("payment_refunds")
    .select("amount_minor_units")
    .eq("payment_id", paymentId)
    .eq("status", "success");
  if (refundsError) {
    throw refundsError;
  }

  const totalRefunded = (refunds ?? []).reduce((sum, r) => sum + r.amount_minor_units, 0);
  const newStatus = totalRefunded <= 0 ? "success" : totalRefunded >= payment.amount_minor_units ? "refunded" : "partially_refunded";

  if (newStatus !== payment.status) {
    const { error: updateError } = await adminClient.from("payments").update({ status: newStatus }).eq("id", paymentId);
    if (updateError) {
      throw updateError;
    }
  }
}

/**
 * Admin-only in Phase 7 (decision #2) -- hosts have no payout/fund-split
 * mechanism yet, so only the platform can authorize giving money back. No
 * refund policy engine: just validates the requested amount against what's
 * actually left to refund.
 */
export async function createRefund(isAdmin: boolean, paymentId: string, input: CreateRefundInput): Promise<RefundDetail> {
  if (!isAdmin) {
    throw new ForbiddenError("Only an admin can issue a refund.");
  }

  const { data: payment, error } = await adminClient.from("payments").select(PAYMENT_COLUMNS).eq("id", paymentId).maybeSingle();
  if (error) {
    throw error;
  }
  if (!payment) {
    throw new NotFoundError("Payment not found.");
  }
  if (payment.status !== "success" && payment.status !== "partially_refunded") {
    throw new ValidationError(`Cannot refund a payment with status '${payment.status}'.`);
  }

  const { data: priorRefunds, error: refundsError } = await adminClient
    .from("payment_refunds")
    .select("amount_minor_units, status")
    .eq("payment_id", paymentId)
    .in("status", ["pending", "success"]);
  if (refundsError) {
    throw refundsError;
  }

  const alreadyCommitted = (priorRefunds ?? []).reduce((sum, r) => sum + r.amount_minor_units, 0);
  const remaining = payment.amount_minor_units - alreadyCommitted;
  const requested = input.amount_minor_units ?? remaining;

  if (requested <= 0 || requested > remaining) {
    throw new ValidationError(`Refund amount must be between 1 and ${remaining} minor units.`);
  }

  const refundId = randomUUID();
  const providerRefundId = `pbr_${refundId.replace(/-/g, "")}`;

  const { error: insertError } = await adminClient.from("payment_refunds").insert({
    id: refundId,
    payment_id: paymentId,
    provider_refund_id: providerRefundId,
    status: "pending",
    amount_minor_units: requested,
    reason: input.reason ?? null,
  });
  if (insertError) {
    throw insertError;
  }

  const provider = getPaymentProvider();
  let result;
  try {
    result = await provider.createRefund({
      providerOrderId: payment.provider_order_id,
      merchantRefundId: providerRefundId,
      amountMinorUnits: requested,
      reason: input.reason,
    });
  } catch (err) {
    await adminClient.from("payment_refunds").update({ status: "failed" }).eq("id", refundId);
    throw err;
  }

  const { data: updated, error: updateError } = await adminClient
    .from("payment_refunds")
    .update({ status: result.status, provider_reference_id: result.providerReferenceId, provider_raw: result.raw })
    .eq("id", refundId)
    .select(REFUND_COLUMNS)
    .single();
  if (updateError || !updated) {
    throw updateError ?? new Error("Failed to update refund.");
  }

  await recomputePaymentRefundStatus(paymentId);

  return updated as RefundDetail;
}

async function applyRefundEvent(event: NormalizedWebhookEvent, ledgerId: string): Promise<void> {
  if (!event.providerRefundId) {
    await adminClient.from("payment_webhook_events").update({ processed_at: new Date().toISOString() }).eq("id", ledgerId);
    return;
  }

  const { data: refund, error } = await adminClient
    .from("payment_refunds")
    .select("id, payment_id, status")
    .eq("provider_refund_id", event.providerRefundId)
    .maybeSingle();
  if (error) {
    throw error;
  }

  if (refund) {
    if (!TERMINAL_REFUND_STATUSES.has(refund.status)) {
      const newStatus = event.type === "REFUND_SUCCESS" ? "success" : event.type === "REFUND_FAILED" ? "failed" : refund.status;
      if (newStatus !== refund.status) {
        await adminClient.from("payment_refunds").update({ status: newStatus, provider_raw: event.raw }).eq("id", refund.id);
      }
    }
    await recomputePaymentRefundStatus(refund.payment_id);
    await adminClient.from("payment_webhook_events").update({ payment_id: refund.payment_id }).eq("id", ledgerId);
  }

  await adminClient.from("payment_webhook_events").update({ processed_at: new Date().toISOString() }).eq("id", ledgerId);
}

/**
 * Entry point for POST /v1/payments/webhooks/cashfree. Verifies the
 * signature (throws 401 before any DB write on failure), records the raw
 * delivery in the idempotency ledger (an exact redelivery is a no-op),
 * normalizes the event, and applies the same guarded status-transition
 * update `verifyPayment` uses -- a webhook and a manual verify can never
 * disagree about what "reached success" means.
 */
export async function handleWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): Promise<void> {
  const provider = getPaymentProvider();
  const event = provider.verifyAndParseWebhook({ rawBody, headers });

  const hash = createHash("sha256").update(rawBody).digest("hex");

  const { data: ledgerRow, error: ledgerError } = await adminClient
    .from("payment_webhook_events")
    .insert({ provider: provider.name, raw_body_hash: hash, payload: JSON.parse(rawBody) })
    .select("id")
    .single();

  if (ledgerError) {
    if (ledgerError.code === UNIQUE_VIOLATION) {
      return; // exact redelivery of a webhook already processed -- idempotent no-op
    }
    throw ledgerError;
  }

  if (!event) {
    await adminClient.from("payment_webhook_events").update({ processed_at: new Date().toISOString() }).eq("id", ledgerRow.id);
    return;
  }

  if (event.type === "REFUND_CREATED" || event.type === "REFUND_SUCCESS" || event.type === "REFUND_FAILED") {
    await applyRefundEvent(event, ledgerRow.id);
    return;
  }

  const { data: payment, error: paymentError } = await adminClient
    .from("payments")
    .select("id, status")
    .eq("provider_order_id", event.providerOrderId)
    .maybeSingle();
  if (paymentError) {
    throw paymentError;
  }

  if (payment) {
    const incoming: NormalizedPaymentStatus = event.type === "PAYMENT_SUCCESS" ? "success" : "failed";
    await applyPaymentStatusUpdate(
      payment.id,
      payment.status,
      incoming,
      event.providerPaymentId,
      event.raw,
      incoming === "failed" ? "Payment failed or was not completed." : null
    );
    await adminClient.from("payment_webhook_events").update({ payment_id: payment.id }).eq("id", ledgerRow.id);
  }

  await adminClient.from("payment_webhook_events").update({ processed_at: new Date().toISOString() }).eq("id", ledgerRow.id);
}
