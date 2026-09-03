import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { requireRole } from "../../middleware/requireRole";
import { validate } from "../../middleware/validate";
import {
  getBookingDetail,
  getBookings,
  postBooking,
  postCancelBooking,
  postCompleteBooking,
  postConfirmBooking,
  postRejectBooking,
} from "./bookings.controller";
import { bookingActionSchema, bookingIdParamSchema, createBookingSchema, listBookingsQuerySchema } from "./bookings.schema";

export const bookingsRouter = Router();

// "Create a new resource for yourself" — same requireRole precedent as
// POST /v1/locations + requireRole('host').
bookingsRouter.post("/bookings", requireAuth, requireRole("booker"), validate({ body: createBookingSchema }), postBooking);

// RLS-scoped: booker sees own, host sees bookings on owned locations, admin
// sees all — no app-layer filtering needed beyond the optional query params.
bookingsRouter.get("/bookings", requireAuth, validate({ query: listBookingsQuerySchema }), getBookings);

bookingsRouter.get("/bookings/:id", requireAuth, validate({ params: bookingIdParamSchema }), getBookingDetail);

bookingsRouter.post(
  "/bookings/:id/confirm",
  requireAuth,
  validate({ params: bookingIdParamSchema }),
  postConfirmBooking
);

bookingsRouter.post(
  "/bookings/:id/reject",
  requireAuth,
  validate({ params: bookingIdParamSchema, body: bookingActionSchema }),
  postRejectBooking
);

bookingsRouter.post(
  "/bookings/:id/cancel",
  requireAuth,
  validate({ params: bookingIdParamSchema, body: bookingActionSchema }),
  postCancelBooking
);

bookingsRouter.post(
  "/bookings/:id/complete",
  requireAuth,
  validate({ params: bookingIdParamSchema }),
  postCompleteBooking
);
