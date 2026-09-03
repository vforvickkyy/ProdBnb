import cors from "cors";
import express, { Express } from "express";
import helmet from "helmet";
import { env } from "./config/env";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";
import { availabilityRouter } from "./modules/availability/availability.routes";
import { bookingsRouter } from "./modules/bookings/bookings.routes";
import { catalogRouter } from "./modules/catalog/catalog.routes";
import { locationsRouter } from "./modules/locations/locations.routes";
import { mediaRouter } from "./modules/media/media.routes";
import { pricingRouter } from "./modules/pricing/pricing.routes";
import { rolesRouter } from "./modules/roles/roles.routes";
import { usersRouter } from "./modules/users/users.routes";

export function createApp(): Express {
  const app = express();

  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGINS.length > 0 ? env.CORS_ORIGINS : false }));
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
  app.use("/v1", catalogRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
