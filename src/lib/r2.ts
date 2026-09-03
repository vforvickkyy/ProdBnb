import { DeleteObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../config/env";

/**
 * R2 is S3-compatible, so the standard AWS SDK v3 client works against it
 * directly — just point `endpoint` at the account's R2 endpoint and use
 * region "auto" (Cloudflare's documented approach for presigned URLs).
 */
const client = new S3Client({
  region: "auto",
  endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  },
});

/** Deterministic, collision-free, extension-less object key for one media item. */
export function objectKeyFor(locationId: string, mediaId: string): string {
  return `locations/${locationId}/${mediaId}/original`;
}

/** The bucket is public (see docs/DATABASE.md) — this is a plain, unsigned link. */
export function publicUrlFor(storageKey: string): string {
  return `${env.R2_PUBLIC_BASE_URL}/${storageKey}`;
}

export interface PresignedUpload {
  url: string;
  expiresAt: Date;
}

/**
 * Signs a PUT with Content-Type/Content-Length pinned, so R2 will only
 * accept a request that matches exactly what was authorized — a client
 * can't upload a different content-type or a larger file than declared.
 */
export async function presignUpload(key: string, contentType: string, contentLength: number): Promise<PresignedUpload> {
  const command = new PutObjectCommand({
    Bucket: env.R2_BUCKET_NAME,
    Key: key,
    ContentType: contentType,
    ContentLength: contentLength,
  });

  const expiresIn = env.R2_UPLOAD_URL_EXPIRY_SECONDS;
  const url = await getSignedUrl(client, command, { expiresIn });

  return { url, expiresAt: new Date(Date.now() + expiresIn * 1000) };
}

export interface R2ObjectInfo {
  contentType: string | undefined;
  contentLength: number | undefined;
}

/** Returns null if nothing exists at that key yet — never throws for "not found". */
export async function headObject(key: string): Promise<R2ObjectInfo | null> {
  try {
    const result = await client.send(new HeadObjectCommand({ Bucket: env.R2_BUCKET_NAME, Key: key }));
    return { contentType: result.ContentType, contentLength: result.ContentLength };
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    const name = (error as { name?: string }).name;
    if (status === 404 || name === "NotFound") {
      return null;
    }
    throw error;
  }
}

export async function deleteObject(key: string): Promise<void> {
  await client.send(new DeleteObjectCommand({ Bucket: env.R2_BUCKET_NAME, Key: key }));
}
