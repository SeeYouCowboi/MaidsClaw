import { describe, expect, it } from "bun:test";
import type { Chunk } from "../../src/core/chunk.js";
import { chunkToObservationEvent } from "../../src/gateway/controllers.js";

describe("chunkToObservationEvent — hidden reasoning redaction firewall", () => {
  it("returns null for hidden_reasoning_delta (openai_reasoning_content)", () => {
    const chunk: Chunk = {
      type: "hidden_reasoning_delta",
      text: "INTERNAL THOUGHT — must not leak",
      format: "openai_reasoning_content",
      providerId: "deepseek",
    };

    const result = chunkToObservationEvent(chunk);

    expect(result).toBeNull();
  });

  it("returns null for hidden_reasoning_delta (anthropic_thinking)", () => {
    const chunk: Chunk = {
      type: "hidden_reasoning_delta",
      text: "anthropic-style hidden block",
      format: "anthropic_thinking",
    };

    expect(chunkToObservationEvent(chunk)).toBeNull();
  });

  it("does not surface hidden reasoning text via stringification", () => {
    const secret = "TOP-SECRET-REASONING-TOKEN-12345";
    const chunk: Chunk = {
      type: "hidden_reasoning_delta",
      text: secret,
      format: "openai_reasoning_content",
    };

    const result = chunkToObservationEvent(chunk);
    const serialized = JSON.stringify(result);

    expect(result).toBeNull();
    expect(serialized).not.toContain(secret);
  });

  it("non-hidden chunks still flow through normally (regression guard)", () => {
    const chunk: Chunk = { type: "text_delta", text: "visible" };
    const result = chunkToObservationEvent(chunk);

    expect(result).toEqual({ type: "text_delta", text: "visible" });
  });
});
