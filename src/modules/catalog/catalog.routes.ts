import { Router } from "express";
import { getAmenities, getCategories, getUseCases } from "./catalog.controller";

export const catalogRouter = Router();

catalogRouter.get("/categories", getCategories);
catalogRouter.get("/amenities", getAmenities);
catalogRouter.get("/use-cases", getUseCases);
