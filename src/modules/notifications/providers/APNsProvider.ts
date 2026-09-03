import { createSign } from "crypto";
import * as http2 from "http2";
import { env } from "../../../config/env";
import { DeliveryStatus, NotificationProvider, SendPushInput, SendPushResult } from "./NotificationProvider";

// Sandbox only this phase -- env.APNS_ENVIRONMENT's schema (src/config/env.ts)
// only accepts "sandbox" today. Adding "production" later is a conscious,
// separate change to both that schema and this map, never a silent flip.
const HOSTS: Record<string, string> = {
  sandbox: "https://api.sandbox.push.apple.com",
};

// Reasons Apple documents specifically for a token that will never work
// again -- these, and only these, flip the owning user_devices row to
// is_active = false. Everything else non-200 is a generic `failed`
// (misconfiguration, rate limiting, a transient provider issue), which
// this phase records but does not retry (see docs/DATABASE.md).
const INVALID_TOKEN_REASONS = new Set(["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic"]);

function base64url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Signs Apple's provider-authentication JWT (ES256, header {alg, kid},
 * claims {iss, iat}) -- built with node:crypto's raw ECDSA signing
 * (dsaEncoding: "ieee-p1363" produces the raw R||S concatenation ES256
 * JWTs require, not the ASN.1 DER crypto.sign() emits by default).
 */
function signApnsJwt(teamId: string, keyId: string, privateKeyPem: string): string {
  const header = base64url(Buffer.from(JSON.stringify({ alg: "ES256", kid: keyId })));
  const claims = base64url(Buffer.from(JSON.stringify({ iss: teamId, iat: Math.floor(Date.now() / 1000) })));
  const signingInput = `${header}.${claims}`;

  const signature = createSign("SHA256").update(signingInput).sign({ key: privateKeyPem, dsaEncoding: "ieee-p1363" });

  return `${signingInput}.${base64url(signature)}`;
}

// Apple recommends reusing a provider token for up to ~1 hour rather than
// signing a fresh one per request -- a small in-memory cache, not a queue.
let cachedJwt: { token: string; issuedAt: number } | null = null;
const JWT_MAX_AGE_MS = 50 * 60 * 1000;

function getJwt(): string {
  if (cachedJwt && Date.now() - cachedJwt.issuedAt < JWT_MAX_AGE_MS) {
    return cachedJwt.token;
  }
  const token = signApnsJwt(requireConfig("APNS_TEAM_ID"), requireConfig("APNS_KEY_ID"), requireConfig("APNS_PRIVATE_KEY"));
  cachedJwt = { token, issuedAt: Date.now() };
  return token;
}

function requireConfig(key: "APNS_TEAM_ID" | "APNS_KEY_ID" | "APNS_BUNDLE_ID" | "APNS_PRIVATE_KEY"): string {
  const value = env[key];
  if (!value) {
    // env.ts's cross-field .refine() already prevents this in normal
    // operation (NOTIFICATION_PROVIDER=apns requires all four) -- this is a
    // defensive re-check, and gives TypeScript a non-optional return type.
    throw new Error(`${key} is required when NOTIFICATION_PROVIDER=apns.`);
  }
  return value;
}

function mapApnsResponse(status: number, reason: string | undefined): DeliveryStatus {
  if (status === 200) {
    return "sent";
  }
  if (reason && INVALID_TOKEN_REASONS.has(reason)) {
    return "invalid_token";
  }
  return "failed";
}

export class APNsProvider implements NotificationProvider {
  readonly name = "apns" as const;

  private readonly host: string;

  constructor() {
    const host = HOSTS[env.APNS_ENVIRONMENT];
    if (!host) {
      throw new Error(`No APNs host configured for APNS_ENVIRONMENT='${env.APNS_ENVIRONMENT}'.`);
    }
    this.host = host;
    // Fail fast at construction time, not on the first send.
    requireConfig("APNS_TEAM_ID");
    requireConfig("APNS_KEY_ID");
    requireConfig("APNS_BUNDLE_ID");
    requireConfig("APNS_PRIVATE_KEY");
  }

  async send(input: SendPushInput): Promise<SendPushResult> {
    const payload = JSON.stringify({
      aps: { alert: { title: input.title, body: input.body }, sound: "default" },
      ...input.data,
    });

    const session = http2.connect(this.host);
    try {
      const result = await new Promise<SendPushResult>((resolve, reject) => {
        const stream = session.request({
          ":method": "POST",
          ":path": `/3/device/${encodeURIComponent(input.deviceToken)}`,
          authorization: `bearer ${getJwt()}`,
          "apns-topic": requireConfig("APNS_BUNDLE_ID"),
          "apns-push-type": "alert",
          "content-type": "application/json",
        });

        let status = 0;
        let apnsId: string | null = null;
        const chunks: Buffer[] = [];

        stream.on("response", (headers) => {
          status = Number(headers[":status"] ?? 0);
          const idHeader = headers["apns-id"];
          apnsId = typeof idHeader === "string" ? idHeader : null;
        });
        stream.on("data", (chunk: Buffer) => chunks.push(chunk));
        stream.on("end", () => {
          let reason: string | undefined;
          try {
            const body = Buffer.concat(chunks).toString("utf8");
            reason = body ? (JSON.parse(body) as { reason?: string }).reason : undefined;
          } catch {
            reason = undefined;
          }
          const mapped = mapApnsResponse(status, reason);
          resolve({
            status: mapped,
            providerMessageId: apnsId,
            errorReason: mapped === "sent" ? null : (reason ?? `HTTP ${status}`),
          });
        });
        stream.on("error", (err) => reject(err));

        stream.end(payload);
      });
      return result;
    } catch (err) {
      return { status: "failed", providerMessageId: null, errorReason: err instanceof Error ? err.message : "Unknown APNs error." };
    } finally {
      session.close();
    }
  }
}
