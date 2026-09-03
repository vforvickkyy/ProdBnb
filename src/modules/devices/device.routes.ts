import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import { deleteDevice, getDevices, postDevice } from "./device.controller";
import { deviceIdParamSchema, registerDeviceSchema } from "./device.schema";

export const devicesRouter = Router();

devicesRouter.post("/devices", requireAuth, validate({ body: registerDeviceSchema }), postDevice);
devicesRouter.get("/devices", requireAuth, getDevices);
devicesRouter.delete("/devices/:id", requireAuth, validate({ params: deviceIdParamSchema }), deleteDevice);
