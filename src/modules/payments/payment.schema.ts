import { z } from "zod";

const uuid = z.string().uuid();

// Cashfree's create-order API requires a 10-digit customer phone number
// (§ Cashfree Orders API); ProdBnb doesn't collect one anywhere else on the
// profile, so it's asked for at the moment it's actually needed instead of
// adding a general-purpose profile field this phase doesn't otherwise need.
export const createPaymentSchema = z
  .object({
    customer_phone: z.string().regex(/^\d{10}$/, "Must be a 10-digit phone number."),
    return_url: z.string().url().optional(),
  })
  .strict();
export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;

export const createRefundSchema = z
  .object({
    // Omitted = refund the full remaining (unrefunded) balance.
    amount_minor_units: z.number().int().positive().optional(),
    reason: z.string().max(500).optional(),
  })
  .strict()
  .default({});
export type CreateRefundInput = z.infer<typeof createRefundSchema>;

export const paymentIdParamSchema = z.object({ id: uuid });
export type PaymentIdParam = z.infer<typeof paymentIdParamSchema>;
