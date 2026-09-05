import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { requireRole } from "../../middleware/requireRole";
import { validate } from "../../middleware/validate";
import { bookingActionSchema, bookingIdParamSchema, listBookingsQuerySchema } from "../bookings/bookings.schema";
import { locationIdParamSchema } from "../locations/locations.schema";
import { createRefundSchema, paymentIdParamSchema } from "../payments/payment.schema";
import {
  getAdminBookingDetail,
  getAdminBookings,
  getAdminDeliveryAttempts,
  getAdminLocationDetail,
  getAdminPaymentDetail,
  getAdminPayments,
  getAdminRefunds,
  getAuditLog,
  getDashboard,
  getUserDetail,
  postAdminCancelBooking,
  postAdminCreateRefund,
  postApproveLocation,
  postRejectLocation,
  postRestoreLocation,
  postRestoreUser,
  postSuspendLocation,
  postSuspendUser,
  getSystemStatusHandler,
} from "./admin.controller";
import {
  adminListPaymentsQuerySchema,
  adminListRefundsQuerySchema,
  adminUserIdParamSchema,
  auditLogQuerySchema,
  deliveryAttemptsQuerySchema,
  noBodySchema,
  rejectLocationSchema,
  suspendLocationSchema,
  suspendUserSchema,
} from "./admin.schema";

export const adminRouter = Router();

// Applied ONCE, here, for every route this router will ever define --
// centralizes the security gate for the whole /v1/admin/* surface, rather
// than repeating `requireAuth, requireRole('admin')` per route the way the
// two pre-Phase-11 admin routes (GET /v1/admin/users, GET
// /v1/admin/locations) did. A booker/host hitting anything under this
// router gets 403 before any handler runs, with no per-route chance to
// forget the gate.
adminRouter.use(requireAuth, requireRole("admin"));

adminRouter.get("/dashboard", getDashboard);
adminRouter.get("/system/status", getSystemStatusHandler);

// -- Users --------------------------------------------------------------
// GET /admin/users already exists (src/modules/users/users.routes.ts,
// extended in place this phase with search/role/status filters) -- not
// redefined here to avoid two competing route registrations for the same
// path. Everything below is genuinely new.

adminRouter.get("/users/:id", validate({ params: adminUserIdParamSchema }), getUserDetail);
adminRouter.post(
  "/users/:id/suspend",
  validate({ params: adminUserIdParamSchema, body: suspendUserSchema }),
  postSuspendUser
);
adminRouter.post(
  "/users/:id/restore",
  validate({ params: adminUserIdParamSchema, body: noBodySchema }),
  postRestoreUser
);

// -- Locations ------------------------------------------------------------
// GET /admin/locations already exists (src/modules/locations/locations.routes.ts,
// extended in place this phase with host_id/search filters) -- same
// no-duplicate-route reasoning as /admin/users above.

adminRouter.get("/locations/:id", validate({ params: locationIdParamSchema }), getAdminLocationDetail);
adminRouter.post(
  "/locations/:id/approve",
  validate({ params: locationIdParamSchema, body: noBodySchema }),
  postApproveLocation
);
adminRouter.post(
  "/locations/:id/reject",
  validate({ params: locationIdParamSchema, body: rejectLocationSchema }),
  postRejectLocation
);
adminRouter.post(
  "/locations/:id/suspend",
  validate({ params: locationIdParamSchema, body: suspendLocationSchema }),
  postSuspendLocation
);
adminRouter.post(
  "/locations/:id/restore",
  validate({ params: locationIdParamSchema, body: noBodySchema }),
  postRestoreLocation
);

// -- Bookings ---------------------------------------------------------------
// Thin wrappers around the existing, unmodified booking engine
// (bookings.service.ts) -- no new cancellation logic, no bypass of the
// EXCLUDE constraint or the booking lifecycle's existing status guards.

adminRouter.get("/bookings", validate({ query: listBookingsQuerySchema }), getAdminBookings);
adminRouter.get("/bookings/:id", validate({ params: bookingIdParamSchema }), getAdminBookingDetail);
adminRouter.post(
  "/bookings/:id/cancel",
  validate({ params: bookingIdParamSchema, body: bookingActionSchema }),
  postAdminCancelBooking
);

// -- Payments / refunds -----------------------------------------------------
// Thin wrappers around the existing PaymentService/PaymentProvider
// architecture (Phase 7) -- no Cashfree-specific code here.

adminRouter.get("/payments", validate({ query: adminListPaymentsQuerySchema }), getAdminPayments);
adminRouter.get("/payments/:id", validate({ params: paymentIdParamSchema }), getAdminPaymentDetail);
adminRouter.get("/refunds", validate({ query: adminListRefundsQuerySchema }), getAdminRefunds);
adminRouter.post(
  "/payments/:id/refunds",
  validate({ params: paymentIdParamSchema, body: createRefundSchema }),
  postAdminCreateRefund
);

// -- Notifications (delivery diagnostics only, never notification content) --

adminRouter.get(
  "/notifications/delivery-attempts",
  validate({ query: deliveryAttemptsQuerySchema }),
  getAdminDeliveryAttempts
);

// -- Audit log ----------------------------------------------------------

adminRouter.get("/audit-log", validate({ query: auditLogQuerySchema }), getAuditLog);
