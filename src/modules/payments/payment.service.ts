import { createHash, randomUUID } from "crypto";
import { SupabaseClient } from "@supabase/supabase-js";
import { env } from "../../config/env";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../../errors/AppError";
import { adminClient } from "../../lib/supabase";
import { getBooking } from "../bookings/bookings.service";
import { notifyPaymentFailed, notifyPaymentSuccess, notifyRefundProcessed } from "../notifications/notification.service";
import { CreatePaymentInput, CreateRefundInput } from "./payment.schema";
import { getPaymentProvider } from "./providers";
import { FetchOrderResult, NormalizedPaymentStatus, NormalizedWebhookEvent } from "./providers/PaymentProvider";

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

async function getBookerId(bookingId: string): Promise<string | null> {
  const { data, error } = await adminClient.from("bookings").select("booker_id").eq("id", bookingId).maybeSingle();
  if (error) {
    throw error;
  }
  return data?.booker_id ?? null;
}

/** The minimum a payment row must expose for a guarded status transition. */
interface PaymentStatusTarget {
  id: string;
  status: string;
  amount_minor_units: number;
  currency: string;
}

/** What the provider itself claims the money was; `null` fields mean "not reported". */
export interface ProviderReportedAmount {
  amountMinorUnits: number | null;
  currency: string | null;
}

/**
 * Phase 26-H. The provider is the one telling us a payment succeeded, so before
 * that claim is allowed to become a `success` row we check it is a claim about
 * the amount we actually recorded. A provider reporting a different amount or
 * currency than `payments.amount_minor_units`/`currency` is never recorded as
 * success -- it becomes a `failed` with the discrepancy captured internally.
 *
 * A `null` reported value means the provider did not include it on this
 * particular event, which is not evidence of a mismatch and so is not treated
 * as one. This check is defence-in-depth: the amount ProdBnb *charges* is
 * already structurally un-influenceable by any client (createPayment reads it
 * only from the booking's own immutable snapshot).
 */
function amountMismatchReason(expected: PaymentStatusTarget, reported: ProviderReportedAmount | null): string | null {
  if (!reported) {
    return null;
  }
  if (reported.amountMinorUnits != null && reported.amountMinorUnits !== expected.amount_minor_units) {
    return `Provider reported ${reported.amountMinorUnits} minor units but this payment is for ${expected.amount_minor_units}.`;
  }
  if (reported.currency != null && reported.currency.toUpperCase() !== expected.currency.toUpperCase()) {
    return `Provider reported currency ${reported.currency.toUpperCase()} but this payment is in ${expected.currency.toUpperCase()}.`;
  }
  return null;
}

/**
 * Turns a provider order read into the status this payment should move to (Phase 26-H.9D).
 *
 * One place, used by both the verify and the resume path, so attempt-level data can never mean
 * two different things depending on how it was fetched. It does **not** transition anything --
 * `applyPaymentStatusUpdate` remains the only funnel that writes status.
 *
 * Two rules carry the whole design:
 *
 * 1. **A successful attempt can settle an order the provider still reports as open.** Money
 *    demonstrably moved; waiting for order-level `PAID` or a webhook that may never arrive only
 *    delays the truth.
 * 2. **An unsuccessful attempt changes nothing.** While the order is open the payer may attempt
 *    again -- Cashfree's own reference shows one order carrying a failed *and* a successful
 *    attempt -- so a failed attempt is not a failed payment. Since `failed` is terminal here, the
 *    naive mapping would permanently lock out a later success on that same order. That is the
 *    single most important invariant in this phase.
 */
function effectiveProviderOutcome(
  result: FetchOrderResult,
  current: PaymentStatusTarget
): { status: NormalizedPaymentStatus; reported: ProviderReportedAmount; raw: unknown } {
  const attemptSummary =
    result.settledAttempt || result.lastAttempt
      ? { settledAttempt: result.settledAttempt ?? null, lastAttempt: result.lastAttempt ?? null }
      : null;

  // Audit trail keeps the reduced attempt projection alongside the order body. Never exposed:
  // `provider_raw` is excluded from PAYMENT_COLUMNS, so no API response can carry it.
  const raw = attemptSummary ? { order: result.raw, attempts: attemptSummary } : result.raw;

  const settled = result.settledAttempt;
  if (result.status === "pending" && settled && settled.status === "success") {
    // Validate the SUCCESS attempt against OUR recorded amount before letting it settle anything.
    //
    // Checked here rather than left to the funnel on purpose: the funnel turns a mismatched
    // success into a terminal `failed`, which would be exactly wrong for an order that is still
    // open and still payable. A mismatch must leave the payment pending and resumable.
    const mismatch = amountMismatchReason(current, {
      amountMinorUnits: settled.amountMinorUnits,
      currency: settled.currency,
    });
    if (mismatch) {
      console.error(`Cashfree attempt amount/currency mismatch for payment ${current.id}; not settling. ${mismatch}`);
      return { status: result.status, reported: { amountMinorUnits: null, currency: null }, raw };
    }
    return {
      status: "success",
      reported: { amountMinorUnits: settled.amountMinorUnits, currency: settled.currency },
      raw,
    };
  }

  return {
    status: result.status,
    reported: { amountMinorUnits: result.amountMinorUnits, currency: result.currency },
    raw,
  };
}

async function applyPaymentStatusUpdate(
  current: PaymentStatusTarget,
  incomingStatus: NormalizedPaymentStatus,
  providerReferenceId: string | null,
  raw: unknown,
  failureReason: string | null,
  reportedAmount: ProviderReportedAmount | null = null
): Promise<PaymentDetail> {
  const paymentId = current.id;
  const currentStatus = current.status;
  let resolved = nextPaymentStatus(currentStatus, incomingStatus);
  let resolvedFailureReason = failureReason;

  // Only guard a genuine transition INTO success. An already-terminal payment
  // is returned untouched by nextPaymentStatus above, and a late, malformed
  // event must never be able to flip an already-successful payment to failed.
  if (resolved === "success" && resolved !== currentStatus) {
    const mismatch = amountMismatchReason(current, reportedAmount);
    if (mismatch) {
      resolved = "failed";
      resolvedFailureReason = `Amount/currency mismatch. ${mismatch}`;
    }
  }

  const patch: Record<string, unknown> = { status: resolved, provider_raw: raw };
  if (providerReferenceId) {
    patch.provider_reference_id = providerReferenceId;
  }
  if (resolved === "failed" && resolvedFailureReason) {
    patch.failure_reason = resolvedFailureReason;
  }

  const { data, error } = await adminClient.from("payments").update(patch).eq("id", paymentId).select(PAYMENT_COLUMNS).single();
  if (error || !data) {
    throw error ?? new Error("Failed to update payment.");
  }
  const payment = data as PaymentDetail;

  // Only notify on the transition INTO a terminal outcome, not on every
  // idempotent re-check of an already-settled payment (the guarded
  // nextPaymentStatus() above already prevents `resolved` from moving once
  // terminal, so this only fires the first time success/failed is reached).
  if (resolved !== currentStatus && (resolved === "success" || resolved === "failed")) {
    const bookerId = await getBookerId(payment.booking_id);
    if (bookerId) {
      if (resolved === "success") {
        await notifyPaymentSuccess(bookerId, payment.booking_id, payment.id);
      } else {
        await notifyPaymentFailed(bookerId, payment.booking_id, payment.id);
      }
    }
  }

  return payment;
}

/**
 * Decides what to do with an existing `created`/`pending` payment (Phase 26-H).
 *
 * Returns the payload to hand straight back to the caller when the provider
 * order is still payable -- the SAME payment row and the SAME provider order,
 * with a freshly-minted checkout session. That is what makes
 * `POST /v1/bookings/:id/payment` naturally idempotent: a retry after an
 * ambiguous network failure resumes rather than creating a second order, so a
 * booking can never accumulate two live orders and a payer can never be
 * charged twice.
 *
 * Returns `null` when the old attempt is genuinely dead -- having first
 * recorded that terminal outcome, which frees the one-in-flight index so the
 * caller can start a clean new attempt (a new row, preserving attempt history).
 *
 * Throws when the situation is not ours to resolve: already paid, or the
 * provider is unreachable and we therefore cannot tell.
 */
async function resumeInFlightPayment(
  inFlight: PaymentDetail
): Promise<{ payment: PaymentDetail; checkout: Record<string, unknown> } | null> {
  const provider = getPaymentProvider();

  let order;
  try {
    order = await provider.fetchOrder(inFlight.provider_order_id);
  } catch {
    // We cannot see whether the existing order is still live, so we must not
    // create a second one -- that is precisely the duplicate-charge risk this
    // whole path exists to remove. Preserve the pre-26-H conflict semantics.
    throw new ConflictError("A payment is already in progress for this booking. Please try again in a moment.");
  }

  // Same interpretation the verify path uses (Phase 26-H.9D), so a resume and a verify can never
  // disagree about what the provider just said.
  const outcome = effectiveProviderOutcome(order, inFlight);

  if (outcome.status === "success") {
    // Either the order itself is paid, or an attempt against it succeeded and we simply hadn't
    // heard yet. Record that before refusing, so the caller's next read sees the truth.
    await applyPaymentStatusUpdate(inFlight, "success", order.providerReferenceId, outcome.raw, null, outcome.reported);
    throw new ConflictError("This booking has already been paid for.");
  }

  if (outcome.status === "pending") {
    const { data, error } = await adminClient
      .from("payments")
      .update({
        status: "pending",
        provider_reference_id: order.providerReferenceId ?? inFlight.provider_reference_id,
        provider_raw: order.raw,
      })
      .eq("id", inFlight.id)
      .select(PAYMENT_COLUMNS)
      .single();
    if (error || !data) {
      throw error ?? new Error("Failed to update payment while resuming.");
    }
    return { payment: data as PaymentDetail, checkout: order.checkout };
  }

  // failed / cancelled / expired at the provider: settle this attempt so the
  // partial unique index lets a genuinely new one be created.
  // EXPIRED / TERMINATED only. Reached solely from order-level status: an unsuccessful *attempt*
  // never lands here, because an open order stays `pending` above and remains resumable.
  await applyPaymentStatusUpdate(
    inFlight,
    outcome.status,
    order.providerReferenceId,
    outcome.raw,
    "The previous payment attempt is no longer completable.",
    outcome.reported
  );
  return null;
}

/**
 * Only the booker themselves may pay for their own booking, only while it's
 * still `requested`/`confirmed` (Phase 6A statuses, unmodified -- payment
 * never adds a new one). The booking's own immutable price snapshot
 * (`bookings.total_amount_minor_units`/`currency`) is the sole amount
 * source -- nothing here reads or trusts any client-supplied amount.
 *
 * Phase 26-H: an in-flight attempt is resumed rather than rejected -- see
 * `resumeInFlightPayment`. Booking status is still never touched here.
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

  // Phase 26-H: an existing in-flight attempt is RESUMED, not rejected.
  //
  // Before this, an abandoned checkout left a `pending` payment that only a
  // webhook could ever settle -- and if that webhook never arrived, every
  // retry hit a 409 forever and the booker could not pay for their booking at
  // all. The provider order is the source of truth for whether that attempt is
  // still live, so we ask it rather than guessing from our own row.
  const { data: inFlight, error: inFlightError } = await adminClient
    .from("payments")
    .select(PAYMENT_COLUMNS)
    .eq("booking_id", bookingId)
    .in("status", ["created", "pending"])
    .maybeSingle();
  if (inFlightError) {
    throw inFlightError;
  }
  if (inFlight) {
    const resumed = await resumeInFlightPayment(inFlight as PaymentDetail);
    if (resumed) {
      return resumed;
    }
    // Not resumable: the attempt has been settled terminally above, which also
    // releases payments_one_inflight_per_booking, so a fresh attempt may now be
    // created below.
  }

  // Payment success deliberately never mutates booking status (Phase 7), so
  // a booking stays requested/confirmed indefinitely after being paid --
  // without this check, nothing stops the same booker from calling this
  // endpoint again and paying a second time in full. `payments_one_settled_
  // per_booking` (Phase 12 migration) is the atomic DB-level backstop against
  // the same race this in-flight check already has via
  // payments_one_inflight_per_booking.
  const { data: alreadySettled, error: alreadySettledError } = await adminClient
    .from("payments")
    .select("id")
    .eq("booking_id", bookingId)
    .in("status", ["success", "partially_refunded", "refunded"])
    .maybeSingle();
  if (alreadySettledError) {
    throw alreadySettledError;
  }
  if (alreadySettled) {
    throw new ConflictError("This booking has already been paid for.");
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
    // The partial unique indexes (payments_one_inflight_per_booking,
    // payments_one_settled_per_booking) are the real backstops against a
    // double-submit race -- the pre-checks above are just for a clean error
    // message in the common (non-racing) case.
    if (insertError.code === UNIQUE_VIOLATION) {
      throw new ConflictError("A payment is already in progress or has already been completed for this booking.");
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
  const result = await provider.fetchOrder(current.provider_order_id);
  const outcome = effectiveProviderOutcome(result, current);
  return applyPaymentStatusUpdate(current, outcome.status, result.providerReferenceId, outcome.raw, null, outcome.reported);
}

async function recomputePaymentRefundStatus(paymentId: string): Promise<void> {
  const { data: payment, error } = await adminClient
    .from("payments")
    .select("id, booking_id, amount_minor_units, status")
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

    // One notification per payment the first time it moves away from a
    // clean 'success' into any refunded state -- iOS has a single
    // refund_processed type regardless of full vs. partial, and a later
    // second partial refund completing the remainder doesn't get a second
    // notification (a deliberate Phase 8 scope cut, see docs/DATABASE.md).
    if (payment.status === "success") {
      const bookerId = await getBookerId(payment.booking_id);
      if (bookerId) {
        await notifyRefundProcessed(bookerId, payment.booking_id, payment.id);
      }
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
    .select("id, status, amount_minor_units, currency, provider_order_id")
    .eq("provider_order_id", event.providerOrderId)
    .maybeSingle();
  if (paymentError) {
    throw paymentError;
  }

  if (payment) {
    const incoming: NormalizedPaymentStatus = event.type === "PAYMENT_SUCCESS" ? "success" : "failed";

    // Phase 26-H. The payer abandoned checkout, so the provider order is still
    // ACTIVE and payable while we are about to record a TERMINAL `failed` that
    // can never be walked back. Left alone, someone completing that still-live
    // order later would be charged against a payment we consider dead forever.
    // Terminating first makes our `failed` true at the provider too.
    //
    // Deliberately NOT done for a plain PAYMENT_FAILED (e.g. a card decline):
    // there the payer is very likely still in checkout about to try another
    // instrument, and killing their order mid-session would break a payment
    // that was about to succeed.
    if (event.type === "PAYMENT_USER_DROPPED" && !TERMINAL_PAYMENT_STATUSES.has(payment.status)) {
      try {
        await getPaymentProvider().terminateOrder(payment.provider_order_id);
      } catch (err) {
        // Non-fatal by contract: the provider legitimately refuses to terminate
        // an order that was in fact just paid. Acknowledging the webhook still
        // matters more than this best-effort cleanup, and the guarded status
        // transition below plus reconciliation remain correct either way.
        console.error("Failed to terminate abandoned Cashfree order:", err);
      }
    }

    await applyPaymentStatusUpdate(
      payment,
      incoming,
      event.providerPaymentId,
      event.raw,
      incoming === "failed" ? "Payment failed or was not completed." : null,
      { amountMinorUnits: event.amountMinorUnits, currency: event.currency }
    );
    await adminClient.from("payment_webhook_events").update({ payment_id: payment.id }).eq("id", ledgerRow.id);
  }

  await adminClient.from("payment_webhook_events").update({ processed_at: new Date().toISOString() }).eq("id", ledgerRow.id);
}
