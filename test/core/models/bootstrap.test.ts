import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Chunk } from "../../../src/core/chunk.js";
import { MaidsClawError } from "../../../src/core/errors.js";
import { AnthropicChatProvider } from "../../../src/core/models/anthropic-provider.js";
import { bootstrapRegistry } from "../../../src/core/models/bootstrap.js";
import type { ChatModelProvider } from "../../../src/core/models/chat-provider.js";
import type { EmbeddingProvider } from "../../../src/core/models/embedding-provider.js";
import { SelectionPolicyGuard } from "../../../src/core/models/experimental/selection-policy.js";
import { OpenAIProvider } from "../../../src/core/models/openai-provider.js";
import { BUILT_IN_PROVIDERS } from "../../../src/core/models/provider-catalog.js";
import { DefaultModelServiceRegistry, normalizeModelRef } from "../../../src/core/models/registry.js";

const chatProvider: ChatModelProvider = {
  async *chatCompletion() {
    yield* [];
  },
};

const embeddingProvider: EmbeddingProvider = {
  async embed() {
    return [];
  },
};

const originalEnv = { ...process.env };

beforeEach(() => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
});

afterEach(() => {
  Object.keys(process.env).forEach((key) => {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  });
  Object.assign(process.env, originalEnv);
});

describe("model ref bootstrap behavior", () => {
  it("resolves canonical refs through provider-prefixed registrations", () => {
    const registry = new DefaultModelServiceRegistry({
      chatPrefixes: [
        { prefix: "anthropic/", provider: chatProvider },
        { prefix: "openai/", provider: chatProvider },
      ],
      embeddingPrefixes: [{ prefix: "openai/", provider: embeddingProvider }],
    });

    expect(registry.resolveChat("anthropic/claude-3-5-sonnet-20241022")).toBe(chatProvider);
    expect(registry.resolveEmbedding("openai/text-embedding-3-small")).toBe(embeddingProvider);
  });

  it("normalizes legacy refs to canonical provider/model format", () => {
    expect(normalizeModelRef("claude-3-5-sonnet-20241022")).toBe("anthropic/claude-3-5-sonnet-20241022");
    expect(normalizeModelRef("gpt-4o")).toBe("openai/gpt-4o");
    expect(normalizeModelRef("text-embedding-3-small")).toBe("openai/text-embedding-3-small");
    expect(normalizeModelRef("o3-mini")).toBe("openai/o3-mini");
  });

  it("resolves legacy bare refs using canonical prefix registrations", () => {
    const registry = new DefaultModelServiceRegistry({
      chatPrefixes: [
        { prefix: "anthropic/", provider: chatProvider },
        { prefix: "openai/", provider: chatProvider },
      ],
      embeddingPrefixes: [{ prefix: "openai/", provider: embeddingProvider }],
    });

    expect(registry.resolveChat("claude-3-5-sonnet-20241022")).toBe(chatProvider);
    expect(registry.resolveChat("gpt-4o")).toBe(chatProvider);
    expect(registry.resolveEmbedding("text-embedding-3-small")).toBe(embeddingProvider);
  });

  it("leaves non-legacy refs unchanged", () => {
    expect(normalizeModelRef("moonshot/kimi-k2.5")).toBe("moonshot/kimi-k2.5");
    expect(normalizeModelRef("minimax/MiniMax-M2.5")).toBe("minimax/MiniMax-M2.5");
    expect(normalizeModelRef("my-custom-model")).toBe("my-custom-model");
  });
});

describe("bootstrapRegistry", () => {
  it("returns empty registry with no credentials", () => {
    const registry = bootstrapRegistry();

    let thrown: unknown;
    try {
      registry.resolveChat("openai/gpt-4o");
    } catch (error) {
      thrown = error;
    }

    expect(thrown instanceof MaidsClawError).toBe(true);
    expect((thrown as MaidsClawError).code).toBe("MODEL_NOT_CONFIGURED");
  });

  it("resolves openai models when api-key credential exists", () => {
    const registry = bootstrapRegistry({
      auth: {
        credentials: [{ provider: "openai", type: "api-key", apiKey: "sk-test" }],
      },
    });

    const provider = registry.resolveChat("openai/gpt-4o");
    expect(provider instanceof OpenAIProvider).toBe(true);
  });

  it("resolves anthropic models when api-key credential exists", () => {
    const registry = bootstrapRegistry({
      auth: {
        credentials: [{ provider: "anthropic", type: "api-key", apiKey: "sk-ant-test" }],
      },
    });

    const provider = registry.resolveChat("anthropic/claude-3-5-sonnet-20241022");
    expect(provider instanceof AnthropicChatProvider).toBe(true);
  });

  it("makes oauth providers discoverable but not auto-selectable", () => {
    const guard = new SelectionPolicyGuard([...BUILT_IN_PROVIDERS]);
    const auth = {
      credentials: [
        {
          provider: "openai-chatgpt-codex-oauth",
          type: "oauth-token" as const,
          accessToken: "oauth-token",
        },
        {
          provider: "anthropic-claude-pro-max-oauth",
          type: "setup-token" as const,
          token: "setup-token",
        },
      ],
    };

    const discoverableIds = guard.getDiscoverableProviders(auth).map((provider) => provider.id);
    const autoSelectableIds = guard.getAutoSelectableProviders(auth).map((provider) => provider.id);

    expect(discoverableIds).toContain("openai-chatgpt-codex-oauth");
    expect(discoverableIds).toContain("anthropic-claude-pro-max-oauth");
    expect(autoSelectableIds.includes("openai-chatgpt-codex-oauth")).toBe(false);
    expect(autoSelectableIds.includes("anthropic-claude-pro-max-oauth")).toBe(false);
  });

  it("injects fetchImpl into bootstrapped providers", async () => {
    const fetchCalls: Array<string> = [];
    const mockFetch = (async (input: RequestInfo | URL) => {
      fetchCalls.push(String(input));
      return sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: "hello" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
        "data: [DONE]\n\n",
      ]);
    }) as typeof fetch;

    const registry = bootstrapRegistry({
      auth: {
        credentials: [{ provider: "openai", type: "api-key", apiKey: "sk-test" }],
      },
      fetchImpl: mockFetch,
    });

    const provider = registry.resolveChat("openai/gpt-4o");
    await collectChunks(
      provider.chatCompletion({
        modelId: "openai/gpt-4o",
        messages: [{ role: "user", content: "ping" }],
      })
    );

    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0]).toContain("/v1/chat/completions");
  });

  it("falls back to OPENAI_API_KEY and ANTHROPIC_API_KEY without auth config", () => {
    process.env.OPENAI_API_KEY = "env-openai-key";
    process.env.ANTHROPIC_API_KEY = "env-anthropic-key";

    const registry = bootstrapRegistry();
    expect(registry.resolveChat("openai/gpt-4o") instanceof OpenAIProvider).toBe(true);
    expect(registry.resolveChat("anthropic/claude-3-5-sonnet-20241022") instanceof AnthropicChatProvider).toBe(true);
  });
});

async function collectChunks(stream: AsyncIterable<Chunk>): Promise<Chunk[]> {
  const chunks: Chunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

function sseResponse(events: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(event));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}
