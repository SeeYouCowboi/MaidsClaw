import { describe, expect, it } from "bun:test";
import {
  CursorPayloadSchema,
  GATEWAY_ERROR_CODES,
  GatewayErrorEnvelopeSchema,
  GatewayTokenSchema,
  HealthzResponseSchema,
  OpaqueCursorSchema,
  ReadyzResponseSchema,
  SessionCreateRequestSchema,
  SessionCreateResponseSchema,
  SessionRecoverRequestSchema,
  SessionRecoverResponseSchema,
  SessionStatusSchema,
  TurnStreamRequestSchema,
  decodeCursor,
  encodeCursor,
} from "../../src/contracts/cockpit/index.js";

describe("cockpit shared contract exports", () => {
  it("exports zod schema objects for dashboard-consumed wire shapes", () => {
    expect(SessionCreateRequestSchema.parse({ agent_id: "maid:main" })).toEqual({
      agent_id: "maid:main",
    });
    expect(SessionCreateResponseSchema.parse({ session_id: "s-1", created_at: 1 })).toEqual({
      session_id: "s-1",
      created_at: 1,
    });
    expect(SessionRecoverRequestSchema.parse({ action: "discard_partial_turn" })).toEqual({
      action: "discard_partial_turn",
    });
    expect(SessionRecoverResponseSchema.parse({
      session_id: "s-1",
      recovered: true,
      action: "discard_partial_turn",
      note_code: "partial_output_not_canonized",
    })).toEqual({
      session_id: "s-1",
      recovered: true,
      action: "discard_partial_turn",
      note_code: "partial_output_not_canonized",
    });
    expect(TurnStreamRequestSchema.parse({ user_message: { text: "hello" } })).toEqual({
      user_message: { text: "hello" },
    });
  });

  it("exports health/ready/error envelope schemas", () => {
    expect(HealthzResponseSchema.parse({ status: "ok" })).toEqual({ status: "ok" });
    expect(ReadyzResponseSchema.parse({ status: "ok", storage: "ok", models: "ok" })).toEqual({
      status: "ok",
      storage: "ok",
      models: "ok",
    });
    expect(
      GatewayErrorEnvelopeSchema.parse({
        error: {
          code: "BAD_REQUEST",
          message: "bad",
          retriable: false,
        },
        request_id: "req-1",
      }),
    ).toEqual({
      error: {
        code: "BAD_REQUEST",
        message: "bad",
        retriable: false,
      },
      request_id: "req-1",
    });
    expect(SessionStatusSchema.parse("recovery_required")).toBe("recovery_required");
    expect(GATEWAY_ERROR_CODES.includes("UNSUPPORTED_RUNTIME_MODE")).toBe(true);
  });

  it("exports cursor schemas and helpers", () => {
    const payload = { v: 1 as const, sort_key: { created_at: 123 }, tie_breaker: "session-1" };
    const encoded = encodeCursor(payload);
    expect(OpaqueCursorSchema.safeParse(encoded).success).toBe(true);
    expect(CursorPayloadSchema.parse(decodeCursor(encoded))).toEqual(payload);
  });

  it("exports gateway token schema", () => {
    expect(
      GatewayTokenSchema.parse({
        id: "dashboard-read",
        token: "token",
        scopes: ["read"],
      }),
    ).toEqual({
      id: "dashboard-read",
      token: "token",
      scopes: ["read"],
    });
  });
});
