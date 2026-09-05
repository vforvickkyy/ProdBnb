import { Request, Response } from "express";
import { cancelBooking, getBooking, listBookings } from "../bookings/bookings.service";
import { BookingActionInput, BookingIdParam, ListBookingsQuery } from "../bookings/bookings.schema";
import { getLocation } from "../locations/locations.service";
import { LocationIdParam } from "../locations/locations.schema";
import { createRefund } from "../payments/payment.service";
import { CreateRefundInput, PaymentIdParam } from "../payments/payment.schema";
import {
  AdminListPaymentsQuery,
  AdminListRefundsQuery,
  AdminUserIdParam,
  AuditLogQuery,
  DeliveryAttemptsQuery,
  RejectLocationInput,
  SuspendLocationInput,
  SuspendUserInput,
} from "./admin.schema";
import { listAuditLog, writeAuditLog } from "./audit.service";
import { getDashboardSummary } from "./dashboard.service";
import { approveLocation, rejectLocation, restoreLocation, suspendLocation } from "./locations.service";
import { listDeliveryAttempts } from "./notifications.service";
import { getAdminPayment, listAllPayments, listAllRefunds } from "./payments.service";
import { getSystemStatus } from "./system.service";
import { getAdminUserDetail, restoreUser, suspendUser } from "./users.service";
import { created, ok } from "../../utils/respond";

export async function getDashboard(req: Request, res: Response): Promise<void> {
  const summary = await getDashboardSummary(req.supabase!);
  ok(res, summary);
}

// -- System ---------------------------------------------------------------

export async function getSystemStatusHandler(_req: Request, res: Response): Promise<void> {
  ok(res, getSystemStatus());
}

// -- Users --------------------------------------------------------------
// GET /admin/users is served by users.routes.ts (extended in place with
// search/role/status filters this phase) -- not duplicated here.

export async function getUserDetail(req: Request, res: Response): Promise<void> {
  const { id } = req.valid!.params as AdminUserIdParam;
  const user = await getAdminUserDetail(req.supabase!, id);
  ok(res, user);
}

export async function postSuspendUser(req: Request, res: Response): Promise<void> {
  const { id } = req.valid!.params as AdminUserIdParam;
  const { reason } = req.valid!.body as SuspendUserInput;
  const user = await suspendUser(req.supabase!, req.user!.id, id, reason);
  ok(res, user);
}

export async function postRestoreUser(req: Request, res: Response): Promise<void> {
  const { id } = req.valid!.params as AdminUserIdParam;
  const user = await restoreUser(req.supabase!, req.user!.id, id);
  ok(res, user);
}

// -- Locations ------------------------------------------------------------
// GET /admin/locations is served by locations.routes.ts (extended in place
// with host_id/search filters this phase) -- not duplicated here.

export async function getAdminLocationDetail(req: Request, res: Response): Promise<void> {
  const { id } = req.valid!.params as LocationIdParam;
  const location = await getLocation(req.supabase!, id);
  ok(res, location);
}

export async function postApproveLocation(req: Request, res: Response): Promise<void> {
  const { id } = req.valid!.params as LocationIdParam;
  const location = await approveLocation(req.supabase!, req.user!.id, id);
  ok(res, location);
}

export async function postRejectLocation(req: Request, res: Response): Promise<void> {
  const { id } = req.valid!.params as LocationIdParam;
  const { reason } = req.valid!.body as RejectLocationInput;
  const location = await rejectLocation(req.supabase!, req.user!.id, id, reason);
  ok(res, location);
}

export async function postSuspendLocation(req: Request, res: Response): Promise<void> {
  const { id } = req.valid!.params as LocationIdParam;
  const { reason } = req.valid!.body as SuspendLocationInput;
  const location = await suspendLocation(req.supabase!, req.user!.id, id, reason);
  ok(res, location);
}

export async function postRestoreLocation(req: Request, res: Response): Promise<void> {
  const { id } = req.valid!.params as LocationIdParam;
  const location = await restoreLocation(req.supabase!, req.user!.id, id);
  ok(res, location);
}

// -- Bookings ---------------------------------------------------------------

export async function getAdminBookings(req: Request, res: Response): Promise<void> {
  const query = req.valid!.query as ListBookingsQuery;
  const { data, total } = await listBookings(req.supabase!, query);
  ok(res, data, 200, { page: query.page, pageSize: query.pageSize, total });
}

export async function getAdminBookingDetail(req: Request, res: Response): Promise<void> {
  const { id } = req.valid!.params as BookingIdParam;
  const booking = await getBooking(req.supabase!, id);
  ok(res, booking);
}

export async function postAdminCancelBooking(req: Request, res: Response): Promise<void> {
  const { id } = req.valid!.params as BookingIdParam;
  const input = req.valid!.body as BookingActionInput;
  const booking = await cancelBooking(req.supabase!, req.user!.id, true, id, input);
  await writeAuditLog(req.user!.id, "ADMIN_CANCELLED_BOOKING", "booking", id, input.reason ?? null, {});
  ok(res, booking);
}

// -- Payments / refunds -----------------------------------------------------

export async function getAdminPayments(req: Request, res: Response): Promise<void> {
  const query = req.valid!.query as AdminListPaymentsQuery;
  const { data, total } = await listAllPayments(req.supabase!, query);
  ok(res, data, 200, { page: query.page, pageSize: query.pageSize, total });
}

export async function getAdminPaymentDetail(req: Request, res: Response): Promise<void> {
  const { id } = req.valid!.params as PaymentIdParam;
  const payment = await getAdminPayment(req.supabase!, id);
  ok(res, payment);
}

export async function getAdminRefunds(req: Request, res: Response): Promise<void> {
  const query = req.valid!.query as AdminListRefundsQuery;
  const { data, total } = await listAllRefunds(req.supabase!, query);
  ok(res, data, 200, { page: query.page, pageSize: query.pageSize, total });
}

export async function postAdminCreateRefund(req: Request, res: Response): Promise<void> {
  const { id } = req.valid!.params as PaymentIdParam;
  const input = req.valid!.body as CreateRefundInput;
  // Caller is already guaranteed admin by requireRole at the router level --
  // createRefund's own isAdmin gate is satisfied unconditionally here.
  const refund = await createRefund(true, id, input);
  await writeAuditLog(req.user!.id, "ADMIN_CREATED_REFUND", "payment", id, input.reason ?? null, {
    amount_minor_units: refund.amount_minor_units,
  });
  created(res, refund);
}

// -- Notifications (diagnostics only) ---------------------------------------

export async function getAdminDeliveryAttempts(req: Request, res: Response): Promise<void> {
  const query = req.valid!.query as DeliveryAttemptsQuery;
  const { data, total } = await listDeliveryAttempts(query);
  ok(res, data, 200, { page: query.page, pageSize: query.pageSize, total });
}

// -- Audit log ----------------------------------------------------------

export async function getAuditLog(req: Request, res: Response): Promise<void> {
  const query = req.valid!.query as AuditLogQuery;
  const { data, total } = await listAuditLog(req.supabase!, query);
  ok(res, data, 200, { page: query.page, pageSize: query.pageSize, total });
}
