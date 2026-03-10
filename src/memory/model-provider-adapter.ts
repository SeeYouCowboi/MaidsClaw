import type { ChatModelProvider } from "../core/models/chat-provider.js";
import type { DefaultModelServiceRegistry } from "../core/models/registry.js";
import type { EmbeddingPurpose } from "../core/models/embedding-provider.js";
import type {
  ChatMessage,
  ChatToolDefinition,
  MemoryTaskModelProvider,
  ToolCallResult,
} from "./task-agent.js";

export class MemoryTaskModelProviderAdapter implements MemoryTaskModelProvider {
  private readonly chatProvider: ChatModelProvider;

  constructor(
    private readonly modelRegistry: DefaultModelServiceRegistry,
    private readonly chatModelId: string,
    private readonly embeddingModelId: string,
  ) {
    this.chatProvider = this.modelRegistry.resolveChat(this.chatModelId);
  }

  async chat(messages: ChatMessage[], tools: ChatToolDefinition[]): Promise<ToolCallResult[]> {
    const calls = new Map<string, { name: string; partialJson: string }>();

    for await (const chunk of this.chatProvider.chatCompletion({
      modelId: this.chatModelId,
      messages,
      tools,
    })) {
      if (chunk.type === "tool_use_start") {
        calls.set(chunk.id, { name: chunk.name, partialJson: "" });
        continue;
      }

      if (chunk.type === "tool_use_delta") {
        const current = calls.get(chunk.id);
        if (!current) {
          continue;
        }
        current.partialJson += chunk.partialJson;
      }
    }

    return Array.from(calls.values()).map((call) => ({
      name: call.name,
      arguments: parseToolInput(call.partialJson),
    }));
  }

  embed(texts: string[], purpose: EmbeddingPurpose, modelId: string): Promise<Float32Array[]> {
    const resolvedModelId = modelId || this.embeddingModelId;
    const embeddingProvider = this.modelRegistry.resolveEmbedding(resolvedModelId);
    return embeddingProvider.embed(texts, purpose, resolvedModelId);
  }
}

function parseToolInput(input: string): Record<string, unknown> {
  if (input.trim().length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(input);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}
