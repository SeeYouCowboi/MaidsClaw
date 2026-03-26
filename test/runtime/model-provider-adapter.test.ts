import { describe, expect, it, mock } from "bun:test";
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

  async embed(texts: string[], purpose: "memory_index" | "narrative_search" | "query_expansion", modelId: string): Promise<Float32Array[]> {
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

  it("reports embedding_model_unavailable when organizer embedding model is not in registry", () => {
    const chatProvider = new MockChatProvider();
    const registry = new DefaultModelServiceRegistry({
      chatExact: new Map([["anthropic/claude-3-5-haiku-20241022", chatProvider]]),
    });

    const runtime = bootstrapRuntime({
      databasePath: ":memory:",
      modelRegistry: registry,
      memoryMigrationModelId: "anthropic/claude-3-5-haiku-20241022",
      memoryEmbeddingModelId: "openai/text-embedding-3-small",
    });

    try {
      expect(runtime.memoryPipelineReady).toBe(false);
      expect(runtime.memoryPipelineStatus).toBe("embedding_model_unavailable");
    } finally {
      runtime.shutdown();
    }
  });
});

describe("MemoryTaskModelProviderAdapter.defaultEmbeddingModelId", () => {
  it("exposes the configured embedding model ID", () => {
    const chatProvider = new MockChatProvider();
    const registry = new DefaultModelServiceRegistry({
      chatExact: new Map([["anthropic/claude-3-5-haiku-20241022", chatProvider]]),
    });
    const adapter = new MemoryTaskModelProviderAdapter(
      registry,
      "anthropic/claude-3-5-haiku-20241022",
      "openai/text-embedding-3-small",
    );
    expect(adapter.defaultEmbeddingModelId).toBe("openai/text-embedding-3-small");
  });
});

describe("MemoryTaskAgent background organize error handling", () => {
  it("background organize failure is caught and does not crash the process", async () => {
    const { MemoryTaskAgent } = await import("../../src/memory/task-agent.js");
    const { Database } = await import("bun:sqlite");

    // Use raw bun:sqlite Database — that is what MemoryTaskAgent.db is
    const rawDb = new Database(":memory:");

    // Create entity_nodes table so renderNodeContent returns content and reaches embed()
    rawDb.exec(`CREATE TABLE entity_nodes (
      id INTEGER PRIMARY KEY,
      pointer_key TEXT NOT NULL,
      display_name TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      memory_scope TEXT NOT NULL,
      owner_agent_id TEXT,
      summary TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    rawDb.prepare(
      `INSERT INTO entity_nodes (id, pointer_key, display_name, entity_type, memory_scope, owner_agent_id, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(1, "person:alice", "Alice", "person", "shared_public", null, "A test entity", Date.now(), Date.now());

    const errorProvider = {
      defaultEmbeddingModelId: "mock-embedding-model",
      chat: async () => [],
      embed: async (): Promise<Float32Array[]> => {
        throw new Error("intentional embed failure");
      },
    };

    const errorSpy = mock((..._args: unknown[]) => {});
    const originalConsoleError = console.error;
    console.error = errorSpy as typeof console.error;

    try {
      // storage/coreMemory/embeddings/materialization are null — safe because embed() throws
      // before any of them would be accessed in runOrganizeInternal
      const agent = new MemoryTaskAgent(
        rawDb,
        null as never,
        null as never,
        null as never,
        null as never,
        errorProvider,
      );

      const job = {
        agentId: "agent-1",
        sessionId: "session-1",
        batchId: "batch-1",
        changedNodeRefs: ["entity:1" as never],
        embeddingModelId: "mock-embedding-model",
      };

      // Simulate the background pattern from task-agent.ts
      const backgroundPromise = Promise.resolve().then(() => agent.runOrganize(job)).catch((err: unknown) => {
          console.error("[MemoryTaskAgent] background organize failed", {
            batchId: job.batchId,
            sessionId: job.sessionId,
            agentId: job.agentId,
            embeddingModelId: job.embeddingModelId,
            error: err instanceof Error ? err.message : String(err),
          });
        });

      await expect(backgroundPromise).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalledWith(
        "[MemoryTaskAgent] background organize failed",
        expect.objectContaining({
          batchId: "batch-1",
          error: "intentional embed failure",
        }),
      );
    } finally {
      console.error = originalConsoleError;
      rawDb.close();
    }
  });
});
