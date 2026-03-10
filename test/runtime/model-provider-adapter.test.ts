import { describe, expect, it } from "bun:test";
import type { Chunk } from "../../src/core/chunk.js";
import type { ChatCompletionRequest, ChatModelProvider } from "../../src/core/models/chat-provider.js";
import type { EmbeddingProvider } from "../../src/core/models/embedding-provider.js";
import { DefaultModelServiceRegistry } from "../../src/core/models/registry.js";
import { MemoryTaskModelProviderAdapter } from "../../src/memory/model-provider-adapter.js";
import { bootstrapRuntime } from "../../src/bootstrap/runtime.js";

class MockChatProvider implements ChatModelProvider {
  public lastRequest: ChatCompletionRequest | null = null;

  async *chatCompletion(request: ChatCompletionRequest): AsyncIterable<Chunk> {
    this.lastRequest = request;
    yield { type: "tool_use_start", id: "tool-1", name: "create_entity" };
    yield { type: "tool_use_delta", id: "tool-1", partialJson: "{\"pointer_key\":\"person:alice\"" };
    yield { type: "tool_use_delta", id: "tool-1", partialJson: ",\"display_name\":\"Alice\"}" };
    yield { type: "tool_use_end", id: "tool-1" };
    yield { type: "message_end", stopReason: "tool_use" };
  }
}

class MockEmbeddingProvider implements EmbeddingProvider {
  public calls: Array<{ texts: string[]; purpose: string; modelId: string }> = [];

  async embed(texts: string[], purpose: "memory_index" | "memory_search" | "query_expansion", modelId: string): Promise<Float32Array[]> {
    this.calls.push({ texts, purpose, modelId });
    return texts.map(() => new Float32Array([1, 2, 3]));
  }
}

describe("MemoryTaskModelProviderAdapter", () => {
  it("bridges chat and embed contracts for MemoryTaskAgent", async () => {
    const chatProvider = new MockChatProvider();
    const embeddingProvider = new MockEmbeddingProvider();
    const registry = new DefaultModelServiceRegistry({
      chatExact: new Map([["anthropic/claude-3-5-haiku-20241022", chatProvider]]),
      embeddingExact: new Map([["openai/text-embedding-3-small", embeddingProvider]]),
    });

    const adapter = new MemoryTaskModelProviderAdapter(
      registry,
      "anthropic/claude-3-5-haiku-20241022",
      "openai/text-embedding-3-small",
    );

    const toolCalls = await adapter.chat(
      [
        { role: "system", content: "system" },
        { role: "user", content: "user" },
      ],
      [
        {
          name: "create_entity",
          description: "Create entity",
          inputSchema: { type: "object", properties: { pointer_key: { type: "string" } } },
        },
      ],
    );

    expect(chatProvider.lastRequest?.modelId).toBe("anthropic/claude-3-5-haiku-20241022");
    expect(chatProvider.lastRequest?.messages).toHaveLength(2);
    expect(chatProvider.lastRequest?.tools?.[0]?.name).toBe("create_entity");
    expect(toolCalls).toEqual([
      {
        name: "create_entity",
        arguments: {
          pointer_key: "person:alice",
          display_name: "Alice",
        },
      },
    ]);

    const vectors = await adapter.embed(["alpha", "beta"], "memory_index", "openai/text-embedding-3-small");
    expect(vectors).toHaveLength(2);
    expect(embeddingProvider.calls).toEqual([
      {
        texts: ["alpha", "beta"],
        purpose: "memory_index",
        modelId: "openai/text-embedding-3-small",
      },
    ]);
  });
});

describe("bootstrapRuntime memory pipeline readiness", () => {
  it("reports degraded memory pipeline and null task agent when embedding model is not configured", () => {
    const runtime = bootstrapRuntime({
      databasePath: ":memory:",
      modelRegistry: new DefaultModelServiceRegistry(),
    });

    try {
      expect(runtime.memoryPipelineReady).toBe(false);
      expect(runtime.memoryTaskAgent).toBeNull();
      expect(runtime.memoryPipelineStatus).toBe("chat_model_unavailable");
      expect(runtime.healthChecks.memory_pipeline).toBe("degraded");
    } finally {
      runtime.shutdown();
    }
  });
});
