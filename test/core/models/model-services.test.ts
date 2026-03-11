import { describe, expect, it } from "bun:test";
import type { Chunk } from "../../../src/core/chunk.js";
import { MaidsClawError } from "../../../src/core/errors.js";
import { NoopCacheHintProvider } from "../../../src/core/interfaces/cache-hint-provider.js";
import { AnthropicChatProvider } from "../../../src/core/models/anthropic-provider.js";
import { OpenAIProvider } from "../../../src/core/models/openai-provider.js";
import { CapabilityNotSupportedError, DefaultModelServiceRegistry } from "../../../src/core/models/registry.js";

describe("Model services", () => {
  it("normalizes Anthropic streaming into Chunk union", async () => {
    const anthropic = new AnthropicChatProvider({
      apiKey: "test-key",
      fetchImpl: async () =>
        sseResponse([
          sseEvent("message_start", {
            type: "message_start",
            message: { usage: { input_tokens: 12, output_tokens: 0 } },
          }),
          sseEvent("content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Hello" },
          }),
          sseEvent("content_block_start", {
            type: "content_block_start",
            index: 1,
            content_block: { type: "tool_use", id: "tool_1", name: "search" },
          }),
          sseEvent("content_block_delta", {
            type: "content_block_delta",
            index: 1,
            delta: { type: "input_json_delta", partial_json: '{"q":"' },
          }),
          sseEvent("content_block_delta", {
            type: "content_block_delta",
            index: 1,
            delta: { type: "input_json_delta", partial_json: 'cats"}' },
          }),
          sseEvent("content_block_stop", {
            type: "content_block_stop",
            index: 1,
          }),
          sseEvent("message_delta", {
            type: "message_delta",
            delta: { stop_reason: "tool_use" },
            usage: { output_tokens: 7 },
          }),
          sseEvent("message_stop", { type: "message_stop" }),
        ]),
    });

    const chunks = await collectChunks(
      anthropic.chatCompletion({
        modelId: "claude-3-5-sonnet",
        messages: [{ role: "user", content: "hi" }],
      })
    );

    expect(chunks).toEqual([
      { type: "text_delta", text: "Hello" },
      { type: "tool_use_start", id: "tool_1", name: "search" },
      { type: "tool_use_delta", id: "tool_1", partialJson: '{"q":"' },
      { type: "tool_use_delta", id: "tool_1", partialJson: 'cats"}' },
      { type: "tool_use_end", id: "tool_1" },
      { type: "message_end", stopReason: "tool_use", inputTokens: 12, outputTokens: 7 },
    ]);
  });

  it("normalizes OpenAI streaming and emits tool chunks", async () => {
    const openai = new OpenAIProvider({
      apiKey: "test-key",
      fetchImpl: async () =>
        sseResponse([
          `data: ${JSON.stringify({
            choices: [{ delta: { content: "Hi " } }],
          })}\n\n`,
          `data: ${JSON.stringify({
            choices: [{ delta: { content: "there" } }],
          })}\n\n`,
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_1",
                      function: { name: "lookup", arguments: '{"x":' },
                    },
                  ],
                },
              },
            ],
          })}\n\n`,
          `data: ${JSON.stringify({
            choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] } }],
          })}\n\n`,
          `data: ${JSON.stringify({
            choices: [{ delta: {}, finish_reason: "tool_calls" }],
          })}\n\n`,
          "data: [DONE]\n\n",
        ]),
    });

    const chunks = await collectChunks(
      openai.chatCompletion({
        modelId: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
      })
    );

    expect(chunks).toEqual([
      { type: "text_delta", text: "Hi " },
      { type: "text_delta", text: "there" },
      { type: "tool_use_start", id: "call_1", name: "lookup" },
      { type: "tool_use_delta", id: "call_1", partialJson: '{"x":' },
      { type: "tool_use_delta", id: "call_1", partialJson: "1}" },
      { type: "tool_use_end", id: "call_1" },
      { type: "message_end", stopReason: "tool_use" },
    ]);
  });

  it("returns Float32Array embeddings for batched OpenAI input", async () => {
    const embeddingFetch = (async (url: RequestInfo | URL): Promise<Response> => {
      if (!String(url).endsWith("/v1/embeddings")) {
        return new Response("not found", { status: 404 });
      }

      return Response.json({
        data: [
          { embedding: [0.1, 0.2, 0.3] },
          { embedding: [0.4, 0.5, 0.6] },
        ],
      });
    }) as typeof fetch;

    const openai = new OpenAIProvider({
      apiKey: "test-key",
      fetchImpl: embeddingFetch,
    });

    const vectors = await openai.embed(["first", "second"], "memory_index", "text-embedding-3-small");
    const firstVector = vectors[0];
    const secondVector = vectors[1];

    expect(vectors).toHaveLength(2);
    expect(firstVector instanceof Float32Array).toBe(true);
    if (!firstVector || !secondVector) {
      throw new Error("Expected both embedding vectors to be present");
    }
    expect(Math.abs(firstVector[0] - 0.1) < 1e-6).toBe(true);
    expect(Math.abs(firstVector[1] - 0.2) < 1e-6).toBe(true);
    expect(Math.abs(firstVector[2] - 0.3) < 1e-6).toBe(true);
    expect(Math.abs(secondVector[0] - 0.4) < 1e-6).toBe(true);
    expect(Math.abs(secondVector[1] - 0.5) < 1e-6).toBe(true);
    expect(Math.abs(secondVector[2] - 0.6) < 1e-6).toBe(true);
  });

  it("resolves chat and embedding providers independently", () => {
    const anthropic = new AnthropicChatProvider({ apiKey: "anthropic-key", fetchImpl: (async () => sseResponse([])) as unknown as typeof fetch });
    const openai = new OpenAIProvider({ apiKey: "openai-key", fetchImpl: (async () => sseResponse([])) as unknown as typeof fetch });
    const registry = new DefaultModelServiceRegistry({
      chatPrefixes: [
        { prefix: "claude", provider: anthropic },
        { prefix: "gpt", provider: openai },
      ],
      embeddingPrefixes: [{ prefix: "text-embedding", provider: openai }],
      unsupportedEmbeddingPrefixes: ["claude"],
    });

    expect(registry.resolveChat("claude-3-5-sonnet")).toBe(anthropic);
    expect(registry.resolveChat("gpt-4o")).toBe(openai);
    expect(registry.resolveEmbedding("text-embedding-3-small")).toBe(openai);
  });

  it("throws MODEL_NOT_CONFIGURED for unknown model mapping", () => {
    const registry = new DefaultModelServiceRegistry();

    let thrown: unknown;
    try {
      registry.resolveChat("unknown-model");
    } catch (error) {
      thrown = error;
    }

    expect(thrown instanceof MaidsClawError).toBe(true);
    const err = thrown as MaidsClawError;
    expect(err.code).toBe("MODEL_NOT_CONFIGURED");
  });

  it("throws CAPABILITY_NOT_SUPPORTED when embeddings requested for Anthropic model", () => {
    const openai = new OpenAIProvider({ apiKey: "openai-key", fetchImpl: (async () => sseResponse([])) as unknown as typeof fetch });
    const registry = new DefaultModelServiceRegistry({
      embeddingPrefixes: [{ prefix: "text-embedding", provider: openai }],
      unsupportedEmbeddingPrefixes: ["claude", "anthropic"],
    });

    let thrown: unknown;
    try {
      registry.resolveEmbedding("claude-3-5-sonnet");
    } catch (error) {
      thrown = error;
    }

    expect(thrown instanceof CapabilityNotSupportedError).toBe(true);
    const err = thrown as CapabilityNotSupportedError;
    expect(err.code).toBe("CAPABILITY_NOT_SUPPORTED");
  });

  it("NoopCacheHintProvider returns input messages unchanged", () => {
    const provider = new NoopCacheHintProvider();
    const messages = [
      { role: "user" as const, content: "hello" },
      { role: "assistant" as const, content: "hi" },
    ];

    expect(provider.applyHints(messages)).toBe(messages);
  });
});

describe("OpenAI streaming usage capability", () => {
  it("includes stream_options.include_usage when supportsStreamingUsage is true", async () => {
    let capturedBody: Record<string, unknown> = {};
    const openai = new OpenAIProvider({
      apiKey: "test-key",
      supportsStreamingUsage: true,
      fetchImpl: async (_url: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
        return sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] })}\n\n`,
          "data: [DONE]\n\n",
        ]);
      },
    });

    await collectChunks(openai.chatCompletion({
      modelId: "gpt-4o",
      messages: [{ role: "user", content: "hello" }],
    }));

    expect(capturedBody.stream_options).toEqual({ include_usage: true });
  });

  it("does NOT include stream_options when supportsStreamingUsage is false/absent", async () => {
    let capturedBody: Record<string, unknown> = {};
    const openai = new OpenAIProvider({
      apiKey: "test-key",
      fetchImpl: async (_url: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
        return sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] })}\n\n`,
          "data: [DONE]\n\n",
        ]);
      },
    });

    await collectChunks(openai.chatCompletion({
      modelId: "gpt-4o",
      messages: [{ role: "user", content: "hello" }],
    }));

    expect(capturedBody.stream_options).toBeUndefined();
  });

  it("normalizes usage-only final chunk into message_end token fields", async () => {
    const openai = new OpenAIProvider({
      apiKey: "test-key",
      supportsStreamingUsage: true,
      fetchImpl: async () =>
        sseResponse([
          `data: ${JSON.stringify({
            choices: [{ delta: { content: "Hello" } }],
          })}\n\n`,
          `data: ${JSON.stringify({
            choices: [{ delta: {}, finish_reason: "stop" }],
          })}\n\n`,
          `data: ${JSON.stringify({
            choices: [],
            usage: { prompt_tokens: 42, completion_tokens: 17, total_tokens: 59 },
          })}\n\n`,
          "data: [DONE]\n\n",
        ]),
    });

    const chunks = await collectChunks(openai.chatCompletion({
      modelId: "gpt-4o",
      messages: [{ role: "user", content: "hello" }],
    }));

    const messageEnd = chunks.find((c) => c.type === "message_end");
    expect(messageEnd).toBeDefined();
    if (messageEnd && messageEnd.type === "message_end") {
      expect(messageEnd.inputTokens).toBe(42);
      expect(messageEnd.outputTokens).toBe(17);
    }
  });
});

async function collectChunks(stream: AsyncIterable<Chunk>): Promise<Chunk[]> {
  const chunks: Chunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

function sseEvent(eventName: string, payload: unknown): string {
  return `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
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
