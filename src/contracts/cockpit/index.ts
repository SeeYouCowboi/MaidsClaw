import { z } from "zod";
import { MaidsClawError } from "../../core/errors.js";
import {
  CursorPayloadSchema,
  OpaqueCursorSchema,
  decodeCursor,
  encodeCursor,
} from "./cursor.js";
import {
  GATEWAY_ERROR_CODES,
} from "./errors.js";

export const GatewayTokenScopeSchema = z.enum(["read", "write"]);
export type GatewayTokenScope = z.infer<typeof GatewayTokenScopeSchema>;

export const GatewayTokenSchema = z
  .object({
    id: z.string().min(1),
    token: z.string().min(1),
    scopes: z.array(GatewayTokenScopeSchema).min(1),
    disabled: z.boolean().optional(),
  })
  .strict();
export type GatewayToken = z.infer<typeof GatewayTokenSchema>;

export const GatewayTokenListSchema = z.array(GatewayTokenSchema);
export type GatewayTokenList = z.infer<typeof GatewayTokenListSchema>;

function throwBadRequest(message: string, details?: unknown): never {
  throw new MaidsClawError({
    code: "BAD_REQUEST",
    message,
    retriable: false,
    details,
  });
}

export function parseGatewayToken(input: unknown): GatewayToken {
  const parsed = GatewayTokenSchema.safeParse(input);
  if (!parsed.success) {
    throwBadRequest("Gateway token does not match schema", parsed.error.issues);
  }
  return parsed.data;
}

export function parseGatewayTokenList(input: unknown): GatewayTokenList {
  const parsed = GatewayTokenListSchema.safeParse(input);
  if (!parsed.success) {
    throwBadRequest("Gateway token list does not match schema", parsed.error.issues);
  }
  return parsed.data;
}

export const GatewayErrorEnvelopeSchema = z
  .object({
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        retriable: z.boolean(),
        details: z.unknown().optional(),
      })
      .strict(),
    request_id: z.string().optional(),
  })
  .strict();
export type GatewayErrorEnvelope = z.infer<typeof GatewayErrorEnvelopeSchema>;

export const HealthzResponseSchema = z
  .object({
    status: z.literal("ok"),
  })
  .strict();
export type HealthzResponse = z.infer<typeof HealthzResponseSchema>;

export const ReadyzSubsystemStatusSchema = z.enum(["ok", "degraded", "unavailable"]);
export type ReadyzSubsystemStatus = z.infer<typeof ReadyzSubsystemStatusSchema>;

export const ReadyzResponseSchema = z
  .object({
    status: z.enum(["ok", "degraded"]),
    storage: ReadyzSubsystemStatusSchema,
    models: ReadyzSubsystemStatusSchema,
  })
  .passthrough();
export type ReadyzResponse = z.infer<typeof ReadyzResponseSchema>;

export const SessionCreateRequestSchema = z
  .object({
    agent_id: z.string().min(1),
  })
  .strict();
export type SessionCreateRequest = z.infer<typeof SessionCreateRequestSchema>;

export const SessionCreateResponseSchema = z
  .object({
    session_id: z.string().min(1),
    created_at: z.number().int().nonnegative(),
  })
  .strict();
export type SessionCreateResponse = z.infer<typeof SessionCreateResponseSchema>;

export const SessionCloseResponseSchema = z
  .object({
    session_id: z.string().min(1),
    closed_at: z.number().int().nonnegative(),
    host_steps: z
      .object({
        flush_on_session_close: z.enum(["completed", "not_applicable", "skipped_no_agent"]),
      })
      .strict(),
  })
  .strict();
export type SessionCloseResponse = z.infer<typeof SessionCloseResponseSchema>;

export const SessionRecoverRequestSchema = z
  .object({
    action: z.literal("discard_partial_turn"),
  })
  .strict();
export type SessionRecoverRequest = z.infer<typeof SessionRecoverRequestSchema>;

export const SessionRecoverResponseSchema = z
  .object({
    session_id: z.string().min(1),
    recovered: z.literal(true),
    action: z.literal("discard_partial_turn"),
    note_code: z.literal("partial_output_not_canonized"),
  })
  .strict();
export type SessionRecoverResponse = z.infer<typeof SessionRecoverResponseSchema>;

export const TurnStreamRequestSchema = z
  .object({
    agent_id: z.string().min(1).optional(),
    request_id: z.string().min(1).optional(),
    user_message: z
      .object({
        id: z.string().min(1).optional(),
        text: z.string().min(1),
      })
      .strict(),
    client_context: z.unknown().optional(),
    metadata: z.unknown().optional(),
  })
  .strict();
export type TurnStreamRequest = z.infer<typeof TurnStreamRequestSchema>;

export const SessionStatusSchema = z.enum(["open", "closed", "recovery_required"]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const SessionListItemSchema = z
  .object({
    session_id: z.string().min(1),
    agent_id: z.string().min(1),
    created_at: z.number().int().nonnegative(),
    closed_at: z.number().int().nonnegative().optional(),
    status: SessionStatusSchema,
  })
  .strict();
export type SessionListItem = z.infer<typeof SessionListItemSchema>;

export const SessionListResponseSchema = z
  .object({
    items: z.array(SessionListItemSchema),
    next_cursor: z.string().nullable(),
  })
  .strict();
export type SessionListResponse = z.infer<typeof SessionListResponseSchema>;

export {
  CursorPayloadSchema,
  GATEWAY_ERROR_CODES,
  OpaqueCursorSchema,
  decodeCursor,
  encodeCursor,
};
export type {
  CursorPayload,
  OpaqueCursor,
} from "./cursor.js";
export type { GatewayErrorCode } from "./errors.js";
