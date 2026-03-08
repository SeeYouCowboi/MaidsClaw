import { describe, expect, it } from "bun:test";
import { MaidsClawError, wrapError, isMaidsClawError, RETRIABLE_CODES } from "../../src/core/errors.js";
import { withRetry, MODEL_RETRY_POLICY, NO_RETRY_POLICY } from "../../src/core/retry.js";

describe("MaidsClawError", () => {
  it("happy path: maps to Gateway envelope shape", () => {
    const err = new MaidsClawError({
      code: "MODEL_TIMEOUT",
      message: "Upstream chat provider timed out",
      retriable: true,
      details: { providerId: "anthropic" },
    });
    
    const shape = err.toGatewayShape();
    expect(shape.error.code).toBe("MODEL_TIMEOUT");
    expect(shape.error.message).toBe("Upstream chat provider timed out");
    expect(shape.error.retriable).toBe(true);
    expect(shape.error.details).toEqual({ providerId: "anthropic" });
  });

  it("wrapError: wraps unknown string into UNKNOWN_ERROR", () => {
    const wrapped = wrapError("something went wrong");
    expect(isMaidsClawError(wrapped)).toBe(true);
    expect(wrapped.code).toBe("UNKNOWN_ERROR");
    expect(wrapped.retriable).toBe(false);
  });

  it("wrapError: returns MaidsClawError unchanged", () => {
    const original = new MaidsClawError({ code: "MCP_DISCONNECTED", message: "mcp gone", retriable: true });
    const wrapped = wrapError(original);
    expect(wrapped).toBe(original); // Same reference
  });

  it("wrapError: wraps plain Error into INTERNAL_ERROR", () => {
    const wrapped = wrapError(new Error("plain error"));
    expect(wrapped.code).toBe("INTERNAL_ERROR");
  });

  it("RETRIABLE_CODES includes MODEL_TIMEOUT and MODEL_RATE_LIMIT", () => {
    expect(RETRIABLE_CODES.has("MODEL_TIMEOUT")).toBe(true);
    expect(RETRIABLE_CODES.has("MODEL_RATE_LIMIT")).toBe(true);
    expect(RETRIABLE_CODES.has("AGENT_NOT_FOUND")).toBe(false);
  });
});

describe("Retry policy", () => {
  it("happy path: succeeds on first attempt, no retry", async () => {
    let attempts = 0;
    const result = await withRetry(async () => {
      attempts++;
      return "ok";
    }, MODEL_RETRY_POLICY);
    
    expect(result).toBe("ok");
    expect(attempts).toBe(1);
  });

  it("retry: retries and succeeds on second attempt", async () => {
    let attempts = 0;
    const result = await withRetry(async () => {
      attempts++;
      if (attempts === 1) {
        throw new MaidsClawError({ code: "MODEL_TIMEOUT", message: "timeout", retriable: true });
      }
      return "recovered";
    }, { ...MODEL_RETRY_POLICY, backoffMs: 0 }); // No backoff in tests
    
    expect(result).toBe("recovered");
    expect(attempts).toBe(2);
  });

  it("error path: exhausts retries and throws final error", async () => {
    let attempts = 0;
    let caught: MaidsClawError | undefined;
    
    try {
      await withRetry(async () => {
        attempts++;
        throw new MaidsClawError({ code: "MODEL_TIMEOUT", message: "always fails", retriable: true });
      }, { ...MODEL_RETRY_POLICY, maxAttempts: 3, backoffMs: 0 });
    } catch (err) {
      caught = err as MaidsClawError;
    }
    
    expect(attempts).toBe(3);
    expect(caught?.code).toBe("MODEL_TIMEOUT");
  });

  it("non-retriable error: throws immediately without retry", async () => {
    let attempts = 0;
    
    try {
      await withRetry(async () => {
        attempts++;
        throw new MaidsClawError({ code: "AGENT_NOT_FOUND", message: "not found", retriable: false });
      }, MODEL_RETRY_POLICY);
    } catch {}
    
    expect(attempts).toBe(1); // No retry for non-retriable
  });

  it("edge path: unknown throwable wrapped into UNKNOWN_ERROR", async () => {
    let caught: MaidsClawError | undefined;
    
    try {
      await withRetry(async () => {
        throw "a raw string error";
      }, NO_RETRY_POLICY);
    } catch (err) {
      caught = err as MaidsClawError;
    }
    
    expect(caught?.code).toBe("UNKNOWN_ERROR");
  });
});
