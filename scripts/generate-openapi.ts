/**
 * Generates docs/admin-openapi.json from the /v1/admin/* zod schemas.
 *
 * Scoped to the admin surface only (Phase 11) -- not retrofitted across the
 * other ~50 existing endpoints from Phases 1-8, which have no separate
 * frontend consumer that benefits from generated types the way the new
 * Admin Panel project does. Run via `npm run generate:openapi`.
 *
 * Response shapes (Phase 14) are hand-written zod schemas that mirror each
 * service's real TypeScript return type -- not derived from it, since those
 * types are plain hand-written interfaces, not zod-inferred. Keeping the two
 * in sync is a manual discipline (same as admin.schema.ts's own auditAction
 * enum already is, relative to audit.service.ts's AuditAction union): when a
 * service's returned shape changes, this file's matching schema must change
 * with it. This is what turns the Admin Panel's generated
 * src/types/admin-api.d.ts from `{ data?: unknown }` into real, checkable
 * response types for every endpoint.
 */
import { writeFileSync } from "fs";
import { join } from "path";
import { extendZodWithOpenApi, OpenApiGeneratorV3, OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { bookingActionSchema, bookingIdParamSchema, listBookingsQuerySchema } from "../src/modules/bookings/bookings.schema";
import { adminListLocationsQuerySchema, locationIdParamSchema } from "../src/modules/locations/locations.schema";
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
const errorResponses = {
  "400": { description: "Validation error" },
  "401": { description: "Missing/invalid bearer token" },
  "403": { description: "Authenticated but not an admin" },
  "404": { description: "Not found" },
};

function jsonBody(schema: z.ZodTypeAny) {
  return { content: { "application/json": { schema } }, required: true };
}

function okResponse(dataSchema: z.ZodTypeAny) {
  return { description: "OK", content: { "application/json": { schema: z.object({ data: dataSchema }) } } };
}

function createdResponse(dataSchema: z.ZodTypeAny) {
  return { description: "Created", content: { "application/json": { schema: z.object({ data: dataSchema }) } } };
}

const paginationMeta = z.object({ page: z.number().int(), pageSize: z.number().int(), total: z.number().int() });

function paginatedResponse(itemSchema: z.ZodTypeAny) {
  return {
    description: "OK",
    content: { "application/json": { schema: z.object({ data: z.array(itemSchema), meta: paginationMeta }) } },
  };
}

// -- Shared field-level building blocks -------------------------------------

const nameRefSchema = z
  .object({ first_name: z.string().nullable(), last_name: z.string().nullable() })
  .nullable()
  .openapi("NameRef");

const catalogRefSchema = z.object({ id: z.string().uuid(), name: z.string() }).openapi("CatalogRef");

const publicMediaItemSchema = z
  .object({
    id: z.string().uuid(),
    media_type: z.enum(["photo", "video"]),
    url: z.string().url(),
    position: z.number().int(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .openapi("PublicMediaItem");

const bookingOptionSchema = z
  .object({ type: z.string(), amount_minor_units: z.number().int(), currency: z.string() })
  .openapi("BookingOption");

const hostPublicSummarySchema = z
  .object({
    id: z.string().uuid(),
    first_name: z.string().nullable(),
    last_name: z.string().nullable(),
    avatar_url: z.string().nullable(),
  })
  .nullable()
  .openapi("HostPublicSummary");

// -- Dashboard ----------------------------------------------------------

const dashboardSummarySchema = z
  .object({
    total_users: z.number().int(),
    active_hosts: z.number().int(),
    published_locations: z.number().int(),
    locations_awaiting_approval: z.number().int(),
    upcoming_bookings: z.number().int(),
    recent_bookings: z.array(
      z.object({ id: z.string().uuid(), status: z.string(), start_at: z.string().datetime(), created_at: z.string().datetime() })
    ),
    payment_activity_30d: z.object({ count: z.number().int(), total_amount_minor_units: z.number().int() }),
    refund_activity_30d: z.object({ count: z.number().int(), total_amount_minor_units: z.number().int() }),
    recent_admin_actions: z.array(
      z.object({
        id: z.string().uuid(),
        action: z.string(),
        target_type: z.string(),
        target_id: z.string().uuid(),
        created_at: z.string().datetime(),
      })
    ),
  })
  .openapi("DashboardSummary");

registry.registerPath({
  method: "get",
  path: "/dashboard",
  tags: ["Admin"],
  summary: "Operational dashboard summary",
  security,
  responses: { "200": okResponse(dashboardSummarySchema), ...errorResponses },
});

// -- System -----------------------------------------------------------------

const systemStatusSchema = z
  .object({
    environment: z.string(),
    payments: z.object({ provider: z.string(), mode: z.string() }),
    notifications: z.object({ provider: z.string() }),
    media: z.object({ configured: z.boolean() }),
  })
  .openapi("SystemStatus");

registry.registerPath({
  method: "get",
  path: "/system/status",
  tags: ["Admin", "System"],
  summary: "Provider/config status -- booleans and enums only, never a credential (Phase 14)",
  security,
  responses: { "200": okResponse(systemStatusSchema), ...errorResponses },
});

// -- Users --------------------------------------------------------------

const adminUserDetailSchema = z
  .object({
    id: z.string().uuid(),
    first_name: z.string().nullable(),
    last_name: z.string().nullable(),
    avatar_url: z.string().nullable(),
    status: z.enum(["active", "suspended", "deleted"]),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
    roles: z.array(z.enum(["booker", "host", "admin"])),
    email: z.string().nullable(),
    last_sign_in_at: z.string().datetime().nullable(),
    locations_count: z.number().int(),
    bookings_count: z.number().int(),
  })
  .openapi("AdminUserDetail");

registry.registerPath({
  method: "get",
  path: "/users",
  tags: ["Admin", "Users"],
  summary: "List users (search/role/status filters, roles included per row)",
  security,
  request: { query: listUsersQuerySchema },
  responses: { "200": paginatedResponse(adminUserDetailSchema), ...errorResponses },
});

registry.registerPath({
  method: "get",
  path: "/users/{id}",
  tags: ["Admin", "Users"],
  summary: "User detail: profile + roles + email (Admin Auth API) + counts",
  security,
  request: { params: adminUserIdParamSchema },
  responses: { "200": okResponse(adminUserDetailSchema), ...errorResponses },
});

registry.registerPath({
  method: "post",
  path: "/users/{id}/suspend",
  tags: ["Admin", "Users"],
  summary: "Suspend a user (reason required) -- cascades to their published locations only",
  security,
  request: { params: adminUserIdParamSchema, body: jsonBody(suspendUserSchema) },
  responses: { "200": okResponse(adminUserDetailSchema), ...errorResponses },
});

registry.registerPath({
  method: "post",
  path: "/users/{id}/restore",
  tags: ["Admin", "Users"],
  summary: "Restore a suspended user -- republishes only locations its own suspension put down",
  security,
  request: { params: adminUserIdParamSchema, body: jsonBody(noBodySchema) },
  responses: { "200": okResponse(adminUserDetailSchema), ...errorResponses },
});

// -- Locations ------------------------------------------------------------

const locationDetailSchema = z
  .object({
    id: z.string().uuid(),
    host_id: z.string().uuid(),
    title: z.string(),
    description: z.string(),
    address_line1: z.string().nullable(),
    address_line2: z.string().nullable(),
    city: z.string(),
    region: z.string().nullable(),
    country: z.string(),
    postal_code: z.string().nullable(),
    latitude: z.number().nullable(),
    longitude: z.number().nullable(),
    capacity: z.number().int().nullable(),
    timezone: z.string(),
    instant_booking_enabled: z.boolean(),
    status: z.enum(["draft", "submitted", "under_review", "approved", "published", "rejected", "suspended", "archived"]),
    moderation_reason: z.string().nullable(),
    suspended_by_host_suspension: z.boolean(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
    categories: z.array(catalogRefSchema),
    amenities: z.array(catalogRefSchema),
    use_cases: z.array(catalogRefSchema),
    media: z.array(publicMediaItemSchema),
    host: hostPublicSummarySchema,
    booking_options: z.array(bookingOptionSchema),
  })
  .openapi("LocationDetail");

registry.registerPath({
  method: "get",
  path: "/locations",
  tags: ["Admin", "Locations"],
  summary: "List locations (status/host_id/search filters)",
  security,
  request: { query: adminListLocationsQuerySchema },
  responses: { "200": paginatedResponse(locationDetailSchema), ...errorResponses },
});

registry.registerPath({
  method: "get",
  path: "/locations/{id}",
  tags: ["Admin", "Locations"],
  summary: "Location detail (includes moderation_reason, suspended_by_host_suspension)",
  security,
  request: { params: locationIdParamSchema },
  responses: { "200": okResponse(locationDetailSchema), ...errorResponses },
});

registry.registerPath({
  method: "post",
  path: "/locations/{id}/approve",
  tags: ["Admin", "Locations"],
  summary: "Approve: submitted/under_review -> published directly",
  security,
  request: { params: locationIdParamSchema, body: jsonBody(noBodySchema) },
  responses: { "200": okResponse(locationDetailSchema), ...errorResponses },
});

registry.registerPath({
  method: "post",
  path: "/locations/{id}/reject",
  tags: ["Admin", "Locations"],
  summary: "Reject (reason required): submitted/under_review -> rejected",
  security,
  request: { params: locationIdParamSchema, body: jsonBody(rejectLocationSchema) },
  responses: { "200": okResponse(locationDetailSchema), ...errorResponses },
});

registry.registerPath({
  method: "post",
  path: "/locations/{id}/suspend",
  tags: ["Admin", "Locations"],
  summary: "Suspend (reason required): published -> suspended",
  security,
  request: { params: locationIdParamSchema, body: jsonBody(suspendLocationSchema) },
  responses: { "200": okResponse(locationDetailSchema), ...errorResponses },
});

registry.registerPath({
  method: "post",
  path: "/locations/{id}/restore",
  tags: ["Admin", "Locations"],
  summary: "Restore: suspended -> published",
  security,
  request: { params: locationIdParamSchema, body: jsonBody(noBodySchema) },
  responses: { "200": okResponse(locationDetailSchema), ...errorResponses },
});

// -- Bookings ---------------------------------------------------------------

const bookingLocationRefSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  city: z.string(),
  timezone: z.string(),
  host_id: z.string().uuid(),
  host: nameRefSchema,
});

const paymentSummarySchema = z.object({
  id: z.string().uuid(),
  status: z.string(),
  amount_minor_units: z.number().int(),
  created_at: z.string().datetime(),
});

const bookingDetailSchema = z
  .object({
    id: z.string().uuid(),
    location: bookingLocationRefSchema,
    booker_id: z.string().uuid(),
    booker: nameRefSchema,
    booking_type: z.enum(["hourly", "half_day", "day", "multi_day"]),
    start_at: z.string().datetime(),
    end_at: z.string().datetime(),
    status: z.enum(["requested", "confirmed", "cancelled", "completed", "rejected"]),
    pricing: z.object({
      base_amount_minor_units: z.number().int(),
      platform_fee_minor_units: z.number().int(),
      tax_minor_units: z.number().int(),
      discount_minor_units: z.number().int(),
      total_amount_minor_units: z.number().int(),
      currency: z.string(),
    }),
    payments: z.array(paymentSummarySchema),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
    cancelled_at: z.string().datetime().nullable(),
    cancelled_by: z.string().uuid().nullable(),
    cancellation_reason: z.string().nullable(),
  })
  .openapi("BookingDetail");

registry.registerPath({
  method: "get",
  path: "/bookings",
  tags: ["Admin", "Bookings"],
  summary: "List bookings (booker_id/host_id/location_id/status/start_after/start_before filters)",
  security,
  request: { query: listBookingsQuerySchema },
  responses: { "200": paginatedResponse(bookingDetailSchema), ...errorResponses },
});

registry.registerPath({
  method: "get",
  path: "/bookings/{id}",
  tags: ["Admin", "Bookings"],
  summary: "Booking detail",
  security,
  request: { params: bookingIdParamSchema },
  responses: { "200": okResponse(bookingDetailSchema), ...errorResponses },
});

registry.registerPath({
  method: "post",
  path: "/bookings/{id}/cancel",
  tags: ["Admin", "Bookings"],
  summary: "Cancel a booking via the existing, unmodified booking engine",
  security,
  request: { params: bookingIdParamSchema, body: jsonBody(bookingActionSchema) },
  responses: { "200": okResponse(bookingDetailSchema), ...errorResponses },
});

// -- Payments / refunds -----------------------------------------------------

const bookingContextSchema = z
  .object({
    id: z.string().uuid(),
    location_id: z.string().uuid(),
    booker_id: z.string().uuid(),
    location: z.object({ title: z.string() }).nullable(),
    booker: nameRefSchema,
  })
  .nullable();

const adminPaymentDetailSchema = z
  .object({
    id: z.string().uuid(),
    booking_id: z.string().uuid(),
    provider: z.string(),
    provider_order_id: z.string(),
    provider_reference_id: z.string().nullable(),
    status: z.enum(["created", "pending", "success", "failed", "cancelled", "refunded", "partially_refunded"]),
    amount_minor_units: z.number().int(),
    currency: z.string(),
    failure_reason: z.string().nullable(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
    booking: bookingContextSchema,
  })
  .openapi("AdminPaymentDetail");

const adminRefundDetailSchema = z
  .object({
    id: z.string().uuid(),
    payment_id: z.string().uuid(),
    provider_refund_id: z.string(),
    provider_reference_id: z.string().nullable(),
    status: z.enum(["pending", "success", "failed", "cancelled"]),
    amount_minor_units: z.number().int(),
    reason: z.string().nullable(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
    payment: z.object({ id: z.string().uuid(), booking: bookingContextSchema }).nullable(),
  })
  .openapi("AdminRefundDetail");

registry.registerPath({
  method: "get",
  path: "/payments",
  tags: ["Admin", "Payments"],
  summary: "List payments (status/provider/booking_id/created_after/created_before filters)",
  security,
  request: { query: adminListPaymentsQuerySchema },
  responses: { "200": paginatedResponse(adminPaymentDetailSchema), ...errorResponses },
});

registry.registerPath({
  method: "get",
  path: "/payments/{id}",
  tags: ["Admin", "Payments"],
  summary: "Payment detail",
  security,
  request: { params: paymentIdParamSchema },
  responses: { "200": okResponse(adminPaymentDetailSchema), ...errorResponses },
});

registry.registerPath({
  method: "get",
  path: "/refunds",
  tags: ["Admin", "Payments"],
  summary: "List refunds (status/payment_id filters)",
  security,
  request: { query: adminListRefundsQuerySchema },
  responses: { "200": paginatedResponse(adminRefundDetailSchema), ...errorResponses },
});

registry.registerPath({
  method: "post",
  path: "/payments/{id}/refunds",
  tags: ["Admin", "Payments"],
  summary: "Create a refund via the existing PaymentService/PaymentProvider architecture",
  security,
  request: { params: paymentIdParamSchema, body: jsonBody(createRefundSchema) },
  responses: { "201": createdResponse(adminRefundDetailSchema.omit({ payment: true })), ...errorResponses },
});

// -- Notifications ------------------------------------------------------

const deliveryAttemptDeviceSchema = z
  .object({
    platform: z.string(),
    environment: z.string().nullable(),
    is_active: z.boolean(),
  })
  .nullable()
  .openapi("DeliveryAttemptDevice");

const deliveryAttemptRowSchema = z
  .object({
    id: z.string().uuid(),
    notification_id: z.string().uuid(),
    device_id: z.string().uuid(),
    provider: z.string(),
    status: z.enum(["sent", "failed", "invalid_token", "skipped"]),
    provider_message_id: z.string().nullable(),
    error_reason: z.string().nullable(),
    created_at: z.string().datetime(),
    device: deliveryAttemptDeviceSchema,
  })
  .openapi("DeliveryAttemptRow");

registry.registerPath({
  method: "get",
  path: "/notifications/delivery-attempts",
  tags: ["Admin", "Notifications"],
  summary: "Delivery diagnostics only (status/provider/error_reason) -- never notification content",
  security,
  request: { query: deliveryAttemptsQuerySchema },
  responses: { "200": paginatedResponse(deliveryAttemptRowSchema), ...errorResponses },
});

// -- Audit log ------------------------------------------------------------

const auditLogEntrySchema = z
  .object({
    id: z.string().uuid(),
    admin_id: z.string().uuid(),
    action: z.enum([
      "ADMIN_APPROVED_LOCATION",
      "ADMIN_REJECTED_LOCATION",
      "ADMIN_SUSPENDED_LOCATION",
      "ADMIN_RESTORED_LOCATION",
      "ADMIN_UPDATED_LOCATION_STATUS",
      "ADMIN_SUSPENDED_USER",
      "ADMIN_RESTORED_USER",
      "ADMIN_CANCELLED_BOOKING",
      "ADMIN_CREATED_REFUND",
    ]),
    target_type: z.enum(["location", "user", "booking", "payment"]),
    target_id: z.string().uuid(),
    reason: z.string().nullable(),
    metadata: z.record(z.unknown()),
    created_at: z.string().datetime(),
  })
  .openapi("AuditLogEntry");

registry.registerPath({
  method: "get",
  path: "/audit-log",
  tags: ["Admin", "Audit"],
  summary: "Immutable audit log (target_type/target_id/admin_id/action/created_after/created_before filters) -- no write endpoint exists",
  security,
  request: { query: auditLogQuerySchema },
  responses: { "200": paginatedResponse(auditLogEntrySchema), ...errorResponses },
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
