import type { generateKeyPairSync as GenerateKeyPairSync } from "crypto";
import { EventEmitter } from "events";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A real (test-only, self-generated) ES256 (P-256) key pair -- signing needs
// a syntactically valid EC private key, not a placeholder string. Computed
// inside vi.hoisted() because vi.mock() factories (and vi.hoisted itself)
// are hoisted above every top-level statement in the file, including a
// normal ES `import` -- referencing an imported binding here throws
// "Cannot access ... before initialization", so `require` (available at
// runtime regardless of hoisting) is used instead, exactly as vitest's own
// docs recommend for this situation.
const TEST_PRIVATE_KEY_PEM = vi.hoisted(() => {
  const { generateKeyPairSync } = require("crypto") as { generateKeyPairSync: typeof GenerateKeyPairSync };
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
});

vi.mock("../src/config/env", () => ({
  env: {
    NOTIFICATION_PROVIDER: "apns",
    APNS_ENVIRONMENT: "sandbox",
    APNS_TEAM_ID: "TESTTEAMID1",
    APNS_KEY_ID: "TESTKEYID99",
    APNS_BUNDLE_ID: "com.prodbnb.test",
    APNS_PRIVATE_KEY: TEST_PRIVATE_KEY_PEM,
  },
}));

interface MockResponse {
  status: number;
  body?: string;
  apnsId?: string;
}

interface CapturedRequest {
  headers: Record<string, unknown>;
  body: string;
}

const mockState = vi.hoisted(() => ({
  nextResponse: { status: 200, apnsId: "apns-id-1" } as MockResponse,
  captured: [] as CapturedRequest[],
  /** Every host connect() was called with -- Phase 27-8 routes this per device. */
  connectedHosts: [] as string[],
}));

vi.mock("http2", () => ({
  // The host argument is captured now: before Phase 27-8 it was a single
  // process-wide value and there was nothing to assert about it.
  connect: (host: string) => ({
    request: (headers: Record<string, unknown>) => {
      const stream = new EventEmitter() as EventEmitter & { end: (body: string) => void };
      stream.end = (body: string) => {
        mockState.connectedHosts.push(host);
        mockState.captured.push({ headers, body });
        const response = mockState.nextResponse;
        queueMicrotask(() => {
          stream.emit("response", {
            ":status": response.status,
            ...(response.apnsId ? { "apns-id": response.apnsId } : {}),
          });
          if (response.body) {
            stream.emit("data", Buffer.from(response.body));
          }
          stream.emit("end");
        });
      };
      return stream;
    },
    close: () => {},
  }),
}));

import { APNsProvider } from "../src/modules/notifications/providers/APNsProvider";
import { DisabledProvider } from "../src/modules/notifications/providers/DisabledProvider";

function decodeJwtPart(part: string): Record<string, unknown> {
  const padded = part.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
}

describe("DisabledProvider", () => {
  it("always returns an explicit 'skipped' outcome, never a false success", async () => {
    const provider = new DisabledProvider();
    const result = await provider.send({
      deviceToken: "tok",
      environment: null,
      title: "t",
      body: "b",
      data: {},
    });
    expect(result.status).toBe("skipped");
    expect(result.providerMessageId).toBeNull();
  });
});

describe("APNsProvider", () => {
  beforeEach(() => {
    mockState.captured = [];
    mockState.connectedHosts = [];
    mockState.nextResponse = { status: 200, apnsId: "apns-id-1" };
  });

  const baseInput = {
    deviceToken: "device-token-abc",
    environment: "sandbox" as const,
    title: "Booking confirmed",
    body: "Your booking has been confirmed.",
    data: { prodbnb_type: "booking_confirmed", prodbnb_booking_id: "11111111-1111-1111-1111-111111111111" },
  };

  it("constructs a correctly-shaped request: path, apns-topic, push-type, and a well-formed ES256 JWT", async () => {
    const provider = new APNsProvider();
    await provider.send(baseInput);

    expect(mockState.captured).toHaveLength(1);
    const { headers } = mockState.captured[0]!;
    expect(headers[":method"]).toBe("POST");
    expect(headers[":path"]).toBe("/3/device/device-token-abc");
    expect(headers["apns-topic"]).toBe("com.prodbnb.test");
    expect(headers["apns-push-type"]).toBe("alert");

    const auth = headers.authorization as string;
    expect(auth.startsWith("bearer ")).toBe(true);
    const jwt = auth.slice("bearer ".length);
    const [headerPart, claimsPart, signaturePart] = jwt.split(".");
    expect(headerPart && claimsPart && signaturePart).toBeTruthy();

    const jwtHeader = decodeJwtPart(headerPart!);
    expect(jwtHeader).toEqual({ alg: "ES256", kid: "TESTKEYID99" });
    const jwtClaims = decodeJwtPart(claimsPart!);
    expect(jwtClaims.iss).toBe("TESTTEAMID1");
    expect(typeof jwtClaims.iat).toBe("number");
  });

  it("payload includes aps.alert (title/body) and the custom prodbnb_* top-level keys", async () => {
    const provider = new APNsProvider();
    await provider.send(baseInput);

    const body = JSON.parse(mockState.captured[0]!.body);
    expect(body.aps.alert).toEqual({ title: "Booking confirmed", body: "Your booking has been confirmed." });
    expect(body.aps.sound).toBe("default");
    expect(body.prodbnb_type).toBe("booking_confirmed");
    expect(body.prodbnb_booking_id).toBe("11111111-1111-1111-1111-111111111111");
  });

  it("reuses the same JWT across consecutive sends within the cache window", async () => {
    const provider = new APNsProvider();
    await provider.send(baseInput);
    await provider.send(baseInput);

    const auth1 = mockState.captured[0]!.headers.authorization;
    const auth2 = mockState.captured[1]!.headers.authorization;
    expect(auth1).toBe(auth2);
  });

  it("maps a 200 response to 'sent' with the apns-id as providerMessageId", async () => {
    mockState.nextResponse = { status: 200, apnsId: "apns-id-xyz" };
    const provider = new APNsProvider();
    const result = await provider.send(baseInput);
    expect(result.status).toBe("sent");
    expect(result.providerMessageId).toBe("apns-id-xyz");
    expect(result.errorReason).toBeNull();
  });

  it("maps BadDeviceToken to 'invalid_token'", async () => {
    mockState.nextResponse = { status: 400, body: JSON.stringify({ reason: "BadDeviceToken" }) };
    const provider = new APNsProvider();
    const result = await provider.send(baseInput);
    expect(result.status).toBe("invalid_token");
    expect(result.errorReason).toBe("BadDeviceToken");
  });

  it("maps Unregistered to 'invalid_token'", async () => {
    mockState.nextResponse = { status: 410, body: JSON.stringify({ reason: "Unregistered" }) };
    const provider = new APNsProvider();
    const result = await provider.send(baseInput);
    expect(result.status).toBe("invalid_token");
  });

  it("maps a non-token reason (e.g. bad provider auth) to 'failed', never 'invalid_token'", async () => {
    mockState.nextResponse = { status: 403, body: JSON.stringify({ reason: "InvalidProviderToken" }) };
    const provider = new APNsProvider();
    const result = await provider.send(baseInput);
    expect(result.status).toBe("failed");
    expect(result.errorReason).toBe("InvalidProviderToken");
  });

  it("maps an unexpected non-200 with no parseable body to 'failed' without throwing", async () => {
    mockState.nextResponse = { status: 500 };
    const provider = new APNsProvider();
    const result = await provider.send(baseInput);
    expect(result.status).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// Phase 27-8
// ---------------------------------------------------------------------------

describe("APNsProvider: per-device environment routing (Phase 27-8)", () => {
  beforeEach(() => {
    mockState.captured = [];
    mockState.connectedHosts = [];
    mockState.nextResponse = { status: 200, apnsId: "apns-id-1" };
  });

  const base = {
    deviceToken: "device-token-abc",
    title: "Priya Sharma",
    body: "Sent you a message.",
    data: { prodbnb_type: "new_message" },
  };

  it("sends a sandbox device to the sandbox host", async () => {
    await new APNsProvider().send({ ...base, environment: "sandbox" });
    expect(mockState.connectedHosts).toEqual(["https://api.sandbox.push.apple.com"]);
  });

  it("sends a production device to the production host", async () => {
    // Code support only -- APNS_ENVIRONMENT remains sandbox-only and no
    // production credentials exist. This asserts that a device which registered
    // itself as `production` is routed correctly rather than being sent to the
    // sandbox host, where Apple answers DeviceTokenNotForTopic and the fan-out
    // would deactivate a perfectly good device.
    await new APNsProvider().send({ ...base, environment: "production" });
    expect(mockState.connectedHosts).toEqual(["https://api.push.apple.com"]);
  });

  it("falls back to the configured environment when a device recorded none", async () => {
    await new APNsProvider().send({ ...base, environment: null });
    expect(mockState.connectedHosts).toEqual(["https://api.sandbox.push.apple.com"]);
  });

  it("routes each device independently within one fan-out", async () => {
    const provider = new APNsProvider();
    await provider.send({ ...base, environment: "sandbox" });
    await provider.send({ ...base, environment: "production" });
    expect(mockState.connectedHosts).toEqual([
      "https://api.sandbox.push.apple.com",
      "https://api.push.apple.com",
    ]);
  });
});

describe("APNsProvider: thread-id (Phase 27-8)", () => {
  beforeEach(() => {
    mockState.captured = [];
    mockState.connectedHosts = [];
    mockState.nextResponse = { status: 200, apnsId: "apns-id-1" };
  });

  const base = {
    deviceToken: "device-token-abc",
    environment: "sandbox" as const,
    title: "Priya Sharma",
    body: "Sent you a message.",
    data: { prodbnb_type: "new_message" },
  };

  it("includes thread-id inside aps when one is supplied", async () => {
    await new APNsProvider().send({ ...base, threadId: "11111111-1111-1111-1111-111111111111" });
    const payload = JSON.parse(mockState.captured[0]!.body) as { aps: Record<string, unknown> };
    expect(payload.aps["thread-id"]).toBe("11111111-1111-1111-1111-111111111111");
  });

  it("omits thread-id entirely when none is supplied", async () => {
    // Booking and payment pushes pass no threadId, so their `aps` object must
    // be byte-identical to what shipped in Phase 8.
    await new APNsProvider().send(base);
    const payload = JSON.parse(mockState.captured[0]!.body) as { aps: Record<string, unknown> };
    expect(payload.aps).not.toHaveProperty("thread-id");
    expect(payload.aps).toEqual({ alert: { title: base.title, body: base.body }, sound: "default" });
  });

  it("omits thread-id when it is explicitly null", async () => {
    await new APNsProvider().send({ ...base, threadId: null });
    const payload = JSON.parse(mockState.captured[0]!.body) as { aps: Record<string, unknown> };
    expect(payload.aps).not.toHaveProperty("thread-id");
  });
});
