import { Request, Response } from "express";
import { writeAuditLog } from "../admin/audit.service";
import { callerHasRole } from "../../middleware/requireRole";
import { created, ok } from "../../utils/respond";
import { BookingIdParam } from "../bookings/bookings.schema";
import { CreatePaymentInput, CreateRefundInput, PaymentIdParam } from "./payment.schema";
import { createPayment, createRefund, getPayment, handleWebhook, listPaymentsForBooking, listRefunds, verifyPayment } from "./payment.service";

async function isCallerAdmin(req: Request): Promise<boolean> {
  return callerHasRole(req.supabase!, req.user!.id, "admin");
}

export async function postPayment(req: Request, res: Response): Promise<void> {
  const { id } = req.valid!.params as BookingIdParam;
  const input = req.valid!.body as CreatePaymentInput;
  const { payment, checkout } = await createPayment(req.supabase!, req.user!.id, req.user!.email, id, input);
  created(res, {
    payment_id: payment.id,
    booking_id: payment.booking_id,
    provider: payment.provider,
    status: payment.status,
    amount_minor_units: payment.amount_minor_units,
    currency: payment.currency,
    checkout,
  });
}

export async function getPaymentsForBooking(req: Request, res: Response): Promise<void> {
  const { id } = req.valid!.params as BookingIdParam;
  const payments = await listPaymentsForBooking(req.supabase!, id);
  ok(res, payments);
}

export async function getPaymentDetail(req: Request, res: Response): Promise<void> {
  const { id } = req.valid!.params as PaymentIdParam;
  const payment = await getPayment(req.supabase!, id);
  ok(res, payment);
}

export async function postVerifyPayment(req: Request, res: Response): Promise<void> {
  const { id } = req.valid!.params as PaymentIdParam;
  const payment = await verifyPayment(req.supabase!, id);
  ok(res, payment);
}

export async function postRefund(req: Request, res: Response): Promise<void> {
  const { id } = req.valid!.params as PaymentIdParam;
  const input = req.valid!.body as CreateRefundInput;
  const isAdmin = await isCallerAdmin(req);
  const refund = await createRefund(isAdmin, id, input);
  // createRefund() already requires isAdmin unconditionally, so every
  // successful call through this route is an admin action -- audited
  // identically to the dedicated POST /v1/admin/payments/:id/refunds (Phase
  // 11), so using the older route doesn't produce a silent, unaudited refund
  // (Phase 12).
  await writeAuditLog(req.user!.id, "ADMIN_CREATED_REFUND", "payment", id, input.reason ?? null, {
    amount_minor_units: refund.amount_minor_units,
  });
  created(res, refund);
}

export async function getRefundsForPayment(req: Request, res: Response): Promise<void> {
  const { id } = req.valid!.params as PaymentIdParam;
  const refunds = await listRefunds(req.supabase!, id);
  ok(res, refunds);
}

/**
 * Registered directly on `app` in app.ts with express.raw() ahead of the
 * global JSON parser (decision #6) -- req.body here is a raw Buffer, not
 * parsed JSON. No requireAuth: Cashfree has no bearer token to send, the
 * webhook signature itself is the authentication.
 */
export async function postCashfreeWebhook(req: Request, res: Response): Promise<void> {
  const rawBody = (req.body as Buffer).toString("utf8");
  await handleWebhook(rawBody, req.headers as Record<string, string | string[] | undefined>);
  res.status(200).json({ received: true });
}

/**
 * Where a provider redirects a payer's browser when a hosted/web checkout
 * finishes (Phase 26-H). Serves a neutral, self-contained page and nothing
 * else: it asserts no outcome, because arriving here proves only that a
 * redirect happened -- not that any money moved.
 *
 * The native iOS SDK flow never lands here; it reconciles through
 * POST /v1/payments/:id/verify instead. This exists so the default
 * `return_url` handed to the provider resolves to something coherent rather
 * than a 401 JSON error page.
 */
export function getPaymentReturn(_req: Request, res: Response): void {
  res
    .status(200)
    .type("html")
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
        `<meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<title>Payment complete</title>` +
        `<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;` +
        `font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;` +
        `background:#f7f7f5;color:#1c1c1e;text-align:center;padding:24px}` +
        `main{max-width:22rem}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0;color:#6b6b70}` +
        `@media(prefers-color-scheme:dark){body{background:#111113;color:#f2f2f7}p{color:#9b9ba1}}</style>` +
        `</head><body><main><h1>You can return to Prod.Bnb</h1>` +
        `<p>Your booking and payment status will be confirmed in the app.</p></main></body></html>`
    );
}
