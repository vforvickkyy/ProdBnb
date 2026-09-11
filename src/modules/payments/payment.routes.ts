import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { paymentCreationLimiter } from "../../middleware/rateLimit";
import { validate } from "../../middleware/validate";
import { bookingIdParamSchema } from "../bookings/bookings.schema";
import {
  getPaymentDetail,
  getPaymentReturn,
  getPaymentsForBooking,
  getRefundsForPayment,
  postPayment,
  postRefund,
  postVerifyPayment,
} from "./payment.controller";
import { createPaymentSchema, createRefundSchema, paymentIdParamSchema } from "./payment.schema";

export const paymentsRouter = Router();

// Authorization (booker-owns-this-booking, payable status) is enforced in
// payment.service.ts, not here -- same "RLS/service decides, route just
// authenticates" split every other module in this codebase already uses.
// paymentCreationLimiter runs after requireAuth specifically so it can key
// on the authenticated caller (req.user.id), not just IP -- see
// middleware/rateLimit.ts.
paymentsRouter.post(
  "/bookings/:id/payment",
  requireAuth,
  paymentCreationLimiter,
  validate({ params: bookingIdParamSchema, body: createPaymentSchema }),
  postPayment
);

paymentsRouter.get("/bookings/:id/payments", requireAuth, validate({ params: bookingIdParamSchema }), getPaymentsForBooking);

// Registered BEFORE "/payments/:id" -- Express matches in order, so without
// this the path would bind `:id = "return"` and answer a returning payer's
// BROWSER with a 401 JSON body (Phase 26-H fix). Deliberately unauthenticated:
// whoever lands here arrived via a provider redirect, not with a bearer token.
//
// Carries no payment state and reads no query parameter, because a provider
// redirect is not evidence of anything -- the native SDK path never depends on
// this route, and payment truth only ever comes from a signed webhook or a
// server-side verify.
paymentsRouter.get("/payments/return", getPaymentReturn);

paymentsRouter.get("/payments/:id", requireAuth, validate({ params: paymentIdParamSchema }), getPaymentDetail);

paymentsRouter.post("/payments/:id/verify", requireAuth, validate({ params: paymentIdParamSchema }), postVerifyPayment);

// Admin-only (decision #2) -- enforced inside payment.service.ts#createRefund.
paymentsRouter.post(
  "/payments/:id/refunds",
  requireAuth,
  validate({ params: paymentIdParamSchema, body: createRefundSchema }),
  postRefund
);

paymentsRouter.get("/payments/:id/refunds", requireAuth, validate({ params: paymentIdParamSchema }), getRefundsForPayment);

// Deliberately NOT here: POST /payments/webhooks/cashfree. It needs the raw
// request body for signature verification, which requires express.raw()
// registered on `app` itself BEFORE the global express.json() middleware --
// see app.ts and payment.controller.ts#postCashfreeWebhook.
