import { Request, Response } from "express";
import { created, ok } from "../../utils/respond";
import { DeviceIdParam, RegisterDeviceInput } from "./device.schema";
import { listMyDevices, registerDevice, removeDevice } from "./device.service";

export async function postDevice(req: Request, res: Response): Promise<void> {
  const input = req.valid!.body as RegisterDeviceInput;
  const device = await registerDevice(req.user!.id, input);
  created(res, device);
}

export async function getDevices(req: Request, res: Response): Promise<void> {
  const devices = await listMyDevices(req.supabase!);
  ok(res, devices);
}

export async function deleteDevice(req: Request, res: Response): Promise<void> {
  const { id } = req.valid!.params as DeviceIdParam;
  await removeDevice(req.supabase!, id);
  ok(res, { id, deleted: true });
}
