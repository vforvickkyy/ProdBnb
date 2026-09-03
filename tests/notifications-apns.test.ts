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
}));

vi.mock("http2", () => ({
  connect: () => ({
    request: (headers: Record<string, unknown>) => {
      const stream = new EventEmitter() as EventEmitter & { end: (body: string) => void };
      stream.end = (body: string) => {
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
