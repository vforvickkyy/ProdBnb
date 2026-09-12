import { ValidationError } from "../../errors/AppError";

/**
 * The shared keyset-pagination cursor for the messaging module.
 *
 * Extracted verbatim from Phase 27-3's `conversations.service.ts` (Phase 27-4,
 * D-6) once message history needed the identical `(timestamp, uuid)` shape.
 * The wire format is unchanged, so cursors minted before the extraction still
 * decode: opaque base64url of `"<ISO timestamp>|<uuid>"`.
 *
 * **Opaque on purpose.** A hand-constructible cursor invites clients to build
 * one, and the ordering it encodes is an implementation detail rather than
 * part of the API contract. It carries nothing sensitive either way — both
 * halves are already on the row the client just received.
 *
 * **Composite on purpose.** Neither half is sufficient alone:
 *   - A timestamp-only cursor skips or repeats rows across a tie.
 *     `conversations.last_message_at` defaults to `now()`, which is the
 *     TRANSACTION timestamp, so conversations created in one statement share
 *     it byte-for-byte. Message ties are rarer (one insert per transaction)
 *     but not impossible.
 *   - An id-only cursor is meaningless against a random v4 uuid.
 *
 * Both consumers order by `(<timestamp column> DESC, id DESC)` and page with
 * the predicate `ts < cursor.timestamp OR (ts = cursor.timestamp AND id <
 * cursor.id)`.
 */
export interface Cursor {
  /** ISO-8601, as the database returned it — never re-formatted. */
  timestamp: string;
  id: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeCursor(timestamp: string, id: string): string {
  return Buffer.from(`${timestamp}|${id}`, "utf8").toString("base64url");
}

/**
 * Any malformed or tampered value is a client error (400), never a 500 — which
 * is why this throws `ValidationError` rather than returning null and leaving
 * the decision to each caller.
 *
 * Splits on the LAST separator so a timestamp containing `|` could never
 * truncate the uuid, and validates both halves independently.
 */
export function decodeCursor(raw: string): Cursor {
  const invalid = new ValidationError("Invalid pagination cursor.");

  let decoded: string;
  try {
    decoded = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    throw invalid;
  }

  const separator = decoded.lastIndexOf("|");
  if (separator === -1) {
    throw invalid;
  }

  const timestamp = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);

  if (!UUID_PATTERN.test(id)) {
    throw invalid;
  }
  if (timestamp.length === 0 || Number.isNaN(new Date(timestamp).getTime())) {
    throw invalid;
  }

  return { timestamp, id };
}
