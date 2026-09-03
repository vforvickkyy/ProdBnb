import { Request, Response } from "express";
import { callerHasRole } from "../../middleware/requireRole";
import { created, ok } from "../../utils/respond";
import {
  cancelBooking,
  completeBooking,
  confirmBooking,
  createBooking,
  getBooking,
  listBookings,
  rejectBooking,
} from "./bookings.service";
import { BookingActionInput, BookingIdParam, CreateBookingInput, ListBookingsQuery } from "./bookings.schema";

async function isCallerAdmin(req: Request): Promise<boolean> {
  return callerHasRole(req.supabase!, req.user!.id, "admin");
}

export async function postBooking(req: Request, res: Response): Promise<void> {
  const input = req.valid!.body as CreateBookingInput;
  const booking = await createBooking(req.supabase!, req.user!.id, input);
  created(res, booking);
}

export async function getBookings(req: Request, res: Response): Promise<void> {
  const query = req.valid!.query as ListBookingsQuery;
  const { data, total } = await listBookings(req.supabase!, query);
  ok(res, data, 200, { page: query.page, pageSize: query.pageSize, total });
}

export async function getBookingDetail(req: Request, res: Response): Promise<void> {
  const { id } = req.valid!.params as BookingIdParam;
  const booking = await getBooking(req.supabase!, id);
  ok(res, booking);
}

export async function postConfirmBooking(req: Request, res: Response): Promise<void> {
  const { id } = req.valid!.params as BookingIdParam;
  const isAdmin = await isCallerAdmin(req);
  const booking = await confirmBooking(req.supabase!, req.user!.id, isAdmin, id);
  ok(res, booking);
}

export async function postRejectBooking(req: Request, res: Response): Promise<void> {
  const { id } = req.valid!.params as BookingIdParam;
  const input = req.valid!.body as BookingActionInput;
  const isAdmin = await isCallerAdmin(req);
  const booking = await rejectBooking(req.supabase!, req.user!.id, isAdmin, id, input);
  ok(res, booking);
}

export async function postCancelBooking(req: Request, res: Response): Promise<void> {
  const { id } = req.valid!.params as BookingIdParam;
  const input = req.valid!.body as BookingActionInput;
  const isAdmin = await isCallerAdmin(req);
  const booking = await cancelBooking(req.supabase!, req.user!.id, isAdmin, id, input);
  ok(res, booking);
}

export async function postCompleteBooking(req: Request, res: Response): Promise<void> {
  const { id } = req.valid!.params as BookingIdParam;
  const isAdmin = await isCallerAdmin(req);
  const booking = await completeBooking(req.supabase!, req.user!.id, isAdmin, id);
  ok(res, booking);
}
