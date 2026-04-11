import { z } from "zod";
import { MaidsClawError } from "../../core/errors.js";

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export const OpaqueCursorSchema = z.string().min(1).regex(BASE64URL_PATTERN);

export const CursorPayloadSchema = z
  .object({
    v: z.literal(1),
    sort_key: z.unknown(),
    tie_breaker: z.string().min(1),
  })
  .strict();

export type OpaqueCursor = z.infer<typeof OpaqueCursorSchema>;
export type CursorPayload = z.infer<typeof CursorPayloadSchema>;

function throwBadRequest(message: string, details?: unknown): never {
  throw new MaidsClawError({
    code: "BAD_REQUEST",
    message,
    retriable: false,
    details,
  });
}

export function encodeCursor(payload: CursorPayload): OpaqueCursor {
  const validated = CursorPayloadSchema.parse(payload);
  const encoded = Buffer.from(JSON.stringify(validated), "utf-8").toString("base64url");
  return OpaqueCursorSchema.parse(encoded);
}

export function decodeCursor(cursor: string): CursorPayload {
  const parsedCursor = OpaqueCursorSchema.safeParse(cursor);
  if (!parsedCursor.success) {
    throwBadRequest("Invalid cursor encoding", parsedCursor.error.issues);
  }

  let decodedJsonText = "";
  try {
    decodedJsonText = Buffer.from(parsedCursor.data, "base64url").toString("utf-8");
  } catch {
    throwBadRequest("Invalid cursor encoding");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(decodedJsonText);
  } catch {
    throwBadRequest("Cursor payload must be valid JSON");
  }

  const parsedPayload = CursorPayloadSchema.safeParse(decoded);
  if (!parsedPayload.success) {
    throwBadRequest("Cursor payload does not match v1 schema", parsedPayload.error.issues);
  }

  return parsedPayload.data;
}
