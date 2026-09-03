import cors from "cors";
import express, { Express } from "express";
import helmet from "helmet";
import { env } from "./config/env";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";
import { availabilityRouter } from "./modules/availability/availability.routes";
import { bookingsRouter } from "./modules/bookings/bookings.routes";
import { catalogRouter } from "./modules/catalog/catalog.routes";
import { devicesRouter } from "./modules/devices/device.routes";
import { locationsRouter } from "./modules/locations/locations.routes";
import { mediaRouter } from "./modules/media/media.routes";
import { notificationsRouter } from "./modules/notifications/notification.routes";
import { postCashfreeWebhook } from "./modules/payments/payment.controller";
import { paymentsRouter } from "./modules/payments/payment.routes";
import { pricingRouter } from "./modules/pricing/pricing.routes";
import { rolesRouter } from "./modules/roles/roles.routes";
import { usersRouter } from "./modules/users/users.routes";

export function createApp(): Express {
  const app = express();

  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGINS.length > 0 ? env.CORS_ORIGINS : false }));

  // Registered BEFORE the global express.json() below, and deliberately not
  // part of paymentsRouter -- Cashfree's webhook signature covers the exact
  // raw request bytes (see CashfreeProvider#verifyAndParseWebhook), which
  // express.json() would otherwise parse-and-discard before this handler
  // ever saw them. Every other route is unaffected: express.raw() only
  // consumes application/json bodies posted to this one path.
  app.post("/v1/payments/webhooks/cashfree", express.raw({ type: "application/json" }), postCashfreeWebhook);

  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.status(200).json({ data: { status: "ok" } });
  });

  app.use("/v1", usersRouter);
  app.use("/v1", rolesRouter);
  app.use("/v1", locationsRouter);
  app.use("/v1", mediaRouter);
  app.use("/v1", availabilityRouter);
  app.use("/v1", bookingsRouter);
  app.use("/v1", pricingRouter);
  app.use("/v1", paymentsRouter);
  app.use("/v1", devicesRouter);
  app.use("/v1", notificationsRouter);
  app.use("/v1", catalogRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
