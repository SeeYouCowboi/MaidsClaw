import { describe, expect, it } from "bun:test";
import {
  type Chunk,
  type HiddenReasoningDeltaChunk,
  isHiddenReasoningDeltaChunk,
  isTextDeltaChunk,
} from "../../src/core/chunk.js";

describe("HiddenReasoningDeltaChunk", () => {
  it("isHiddenReasoningDeltaChunk discriminates correctly", () => {
    const reasoning: Chunk = {
      type: "hidden_reasoning_delta",
      text: "let me think...",
      format: "openai_reasoning_content",
      providerId: "deepseek",
    };
    const text: Chunk = { type: "text_delta", text: "hello" };

    expect(isHiddenReasoningDeltaChunk(reasoning)).toBe(true);
    expect(isHiddenReasoningDeltaChunk(text)).toBe(false);
    expect(isTextDeltaChunk(reasoning)).toBe(false);
  });

  it("type narrowing exposes format and text fields", () => {
    const chunk: Chunk = {
      type: "hidden_reasoning_delta",
      text: "deliberation",
      format: "anthropic_thinking",
    };

    if (isHiddenReasoningDeltaChunk(chunk)) {
      // Field access here is the actual unit under test (the type narrows).
      const narrowed: HiddenReasoningDeltaChunk = chunk;
      expect(narrowed.format).toBe("anthropic_thinking");
      expect(narrowed.text).toBe("deliberation");
    } else {
      throw new Error("expected narrowing");
    }
  });
});
