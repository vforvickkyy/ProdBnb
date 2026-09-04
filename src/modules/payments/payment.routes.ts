import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { paymentCreationLimiter } from "../../middleware/rateLimit";
import { validate } from "../../middleware/validate";
import { bookingIdParamSchema } from "../bookings/bookings.schema";
import {
  getPaymentDetail,
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
