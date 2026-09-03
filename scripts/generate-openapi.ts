/**
 * Generates docs/admin-openapi.json from the /v1/admin/* zod schemas.
 *
 * Scoped to the admin surface only (Phase 11) -- not retrofitted across the
 * other ~50 existing endpoints from Phases 1-8, which have no separate
 * frontend consumer that benefits from generated types the way the new
 * Admin Panel project does. Run via `npm run generate:openapi`.
 */
import { writeFileSync } from "fs";
import { join } from "path";
import { extendZodWithOpenApi, OpenApiGeneratorV3, OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { bookingActionSchema, bookingIdParamSchema, listBookingsQuerySchema } from "../src/modules/bookings/bookings.schema";
import { locationIdParamSchema } from "../src/modules/locations/locations.schema";
import { createRefundSchema, paymentIdParamSchema } from "../src/modules/payments/payment.schema";
import { listUsersQuerySchema } from "../src/modules/users/users.schema";
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
} from "../src/modules/admin/admin.schema";

extendZodWithOpenApi(z);

const registry = new OpenAPIRegistry();

registry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
  bearerFormat: "Supabase access token",
});

const security = [{ bearerAuth: [] }];
const jsonOk = { description: "OK", content: { "application/json": { schema: z.object({ data: z.unknown() }) } } };
const created = { description: "Created", content: { "application/json": { schema: z.object({ data: z.unknown() }) } } };
const errorResponses = {
  "400": { description: "Validation error" },
  "401": { description: "Missing/invalid bearer token" },
  "403": { description: "Authenticated but not an admin" },
  "404": { description: "Not found" },
};

function jsonBody(schema: z.ZodTypeAny) {
  return { content: { "application/json": { schema } }, required: true };
}

registry.registerPath({
  method: "get",
  path: "/dashboard",
  tags: ["Admin"],
  summary: "Operational dashboard summary",
  security,
  responses: { "200": jsonOk, ...errorResponses },
});

// -- Users --------------------------------------------------------------

registry.registerPath({
  method: "get",
  path: "/users",
  tags: ["Admin", "Users"],
  summary: "List users (search/role/status filters, roles included per row)",
  security,
  request: { query: listUsersQuerySchema },
  responses: { "200": jsonOk, ...errorResponses },
});

registry.registerPath({
  method: "get",
  path: "/users/{id}",
  tags: ["Admin", "Users"],
  summary: "User detail: profile + roles + email (Admin Auth API) + counts",
  security,
  request: { params: adminUserIdParamSchema },
  responses: { "200": jsonOk, ...errorResponses },
});

registry.registerPath({
  method: "post",
  path: "/users/{id}/suspend",
  tags: ["Admin", "Users"],
  summary: "Suspend a user (reason required) -- cascades to their published locations only",
  security,
  request: { params: adminUserIdParamSchema, body: jsonBody(suspendUserSchema) },
  responses: { "200": jsonOk, ...errorResponses },
});

registry.registerPath({
  method: "post",
  path: "/users/{id}/restore",
  tags: ["Admin", "Users"],
  summary: "Restore a suspended user -- republishes only locations its own suspension put down",
  security,
  request: { params: adminUserIdParamSchema, body: jsonBody(noBodySchema) },
  responses: { "200": jsonOk, ...errorResponses },
});

// -- Locations ------------------------------------------------------------

const adminListLocationsQuery = z.object({
  status: z.string().optional(),
  host_id: z.string().uuid().optional(),
  search: z.string().optional(),
  page: z.coerce.number().int().optional(),
  pageSize: z.coerce.number().int().optional(),
});

registry.registerPath({
  method: "get",
  path: "/locations",
  tags: ["Admin", "Locations"],
  summary: "List locations (status/host_id/search filters)",
  security,
  request: { query: adminListLocationsQuery },
  responses: { "200": jsonOk, ...errorResponses },
});

registry.registerPath({
  method: "get",
  path: "/locations/{id}",
  tags: ["Admin", "Locations"],
  summary: "Location detail (includes moderation_reason)",
  security,
  request: { params: locationIdParamSchema },
  responses: { "200": jsonOk, ...errorResponses },
});

registry.registerPath({
  method: "post",
  path: "/locations/{id}/approve",
  tags: ["Admin", "Locations"],
  summary: "Approve: submitted/under_review -> published directly",
  security,
  request: { params: locationIdParamSchema, body: jsonBody(noBodySchema) },
  responses: { "200": jsonOk, ...errorResponses },
});

registry.registerPath({
  method: "post",
  path: "/locations/{id}/reject",
  tags: ["Admin", "Locations"],
  summary: "Reject (reason required): submitted/under_review -> rejected",
  security,
  request: { params: locationIdParamSchema, body: jsonBody(rejectLocationSchema) },
  responses: { "200": jsonOk, ...errorResponses },
});

registry.registerPath({
  method: "post",
  path: "/locations/{id}/suspend",
  tags: ["Admin", "Locations"],
  summary: "Suspend (reason required): published -> suspended",
  security,
  request: { params: locationIdParamSchema, body: jsonBody(suspendLocationSchema) },
  responses: { "200": jsonOk, ...errorResponses },
});

registry.registerPath({
  method: "post",
  path: "/locations/{id}/restore",
  tags: ["Admin", "Locations"],
  summary: "Restore: suspended -> published",
  security,
  request: { params: locationIdParamSchema, body: jsonBody(noBodySchema) },
  responses: { "200": jsonOk, ...errorResponses },
});

// -- Bookings ---------------------------------------------------------------

registry.registerPath({
  method: "get",
  path: "/bookings",
  tags: ["Admin", "Bookings"],
  summary: "List bookings (booker_id/host_id/location_id/status filters)",
  security,
  request: { query: listBookingsQuerySchema },
  responses: { "200": jsonOk, ...errorResponses },
});

registry.registerPath({
  method: "get",
  path: "/bookings/{id}",
  tags: ["Admin", "Bookings"],
  summary: "Booking detail",
  security,
  request: { params: bookingIdParamSchema },
  responses: { "200": jsonOk, ...errorResponses },
});

registry.registerPath({
  method: "post",
  path: "/bookings/{id}/cancel",
  tags: ["Admin", "Bookings"],
  summary: "Cancel a booking via the existing, unmodified booking engine",
  security,
  request: { params: bookingIdParamSchema, body: jsonBody(bookingActionSchema) },
  responses: { "200": jsonOk, ...errorResponses },
});

// -- Payments / refunds -----------------------------------------------------

registry.registerPath({
  method: "get",
  path: "/payments",
  tags: ["Admin", "Payments"],
  summary: "List payments (status/provider/booking_id filters)",
  security,
  request: { query: adminListPaymentsQuerySchema },
  responses: { "200": jsonOk, ...errorResponses },
});

registry.registerPath({
  method: "get",
  path: "/payments/{id}",
  tags: ["Admin", "Payments"],
  summary: "Payment detail",
  security,
  request: { params: paymentIdParamSchema },
  responses: { "200": jsonOk, ...errorResponses },
});

registry.registerPath({
  method: "get",
  path: "/refunds",
  tags: ["Admin", "Payments"],
  summary: "List refunds (status filter)",
  security,
  request: { query: adminListRefundsQuerySchema },
  responses: { "200": jsonOk, ...errorResponses },
});

registry.registerPath({
  method: "post",
  path: "/payments/{id}/refunds",
  tags: ["Admin", "Payments"],
  summary: "Create a refund via the existing PaymentService/PaymentProvider architecture",
  security,
  request: { params: paymentIdParamSchema, body: jsonBody(createRefundSchema) },
  responses: { "201": created, ...errorResponses },
});

// -- Notifications ------------------------------------------------------

registry.registerPath({
  method: "get",
  path: "/notifications/delivery-attempts",
  tags: ["Admin", "Notifications"],
  summary: "Delivery diagnostics only (status/provider/error_reason) -- never notification content",
  security,
  request: { query: deliveryAttemptsQuerySchema },
  responses: { "200": jsonOk, ...errorResponses },
});

// -- Audit log ------------------------------------------------------------

registry.registerPath({
  method: "get",
  path: "/audit-log",
  tags: ["Admin", "Audit"],
  summary: "Immutable audit log (target_type/target_id/admin_id filters) -- no write endpoint exists",
  security,
  request: { query: auditLogQuerySchema },
  responses: { "200": jsonOk, ...errorResponses },
});

const generator = new OpenApiGeneratorV3(registry.definitions);
const document = generator.generateDocument({
  openapi: "3.0.0",
  info: {
    title: "ProdBnb Admin API",
    version: "1.0.0",
    description:
      "The /v1/admin/* surface only (Phase 11). Every endpoint requires a Supabase access token " +
      "for a user holding the 'admin' role. Base path is mounted at /v1/admin on the ProdBnb backend.",
  },
  servers: [{ url: "/v1/admin" }],
});

const outPath = join(__dirname, "../docs/admin-openapi.json");
writeFileSync(outPath, JSON.stringify(document, null, 2) + "\n");
console.log(`Wrote ${outPath}`);
