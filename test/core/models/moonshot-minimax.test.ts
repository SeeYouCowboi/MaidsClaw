import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Chunk } from "../../../src/core/chunk.js";
import { resolveProviderCredential } from "../../../src/core/config.js";
import { MaidsClawError } from "../../../src/core/errors.js";
import { bootstrapRegistry } from "../../../src/core/models/bootstrap.js";
import { OpenAIProvider } from "../../../src/core/models/openai-provider.js";

// ── Helpers ────────────────────────────────────────────────────────────

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

async function collectChunks(stream: AsyncIterable<Chunk>): Promise<Chunk[]> {
  const chunks: Chunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

// ── Env cleanup ────────────────────────────────────────────────────────

const originalEnv = { ...process.env };

beforeEach(() => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.MOONSHOT_API_KEY;
  delete process.env.MINIMAX_API_KEY;
});

afterEach(() => {
  Object.keys(process.env).forEach((key) => {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  });
  Object.assign(process.env, originalEnv);
});

// ── Tests ──────────────────────────────────────────────────────────────

describe("Moonshot (Kimi) via OpenAI-compatible transport", () => {
  it("resolves moonshot/kimi-k2.5 to an OpenAIProvider via bootstrapRegistry", async () => {
    const fetchCalls: string[] = [];
    const mockFetch = (async (input: RequestInfo | URL) => {
      fetchCalls.push(String(input));
      return sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
        "data: [DONE]\n\n",
      ]);
    }) as typeof fetch;

    const registry = bootstrapRegistry({
      auth: {
        credentials: [{ provider: "moonshot", type: "api-key", apiKey: "sk-moonshot-test" }],
      },
      fetchImpl: mockFetch,
    });

    const provider = registry.resolveChat("moonshot/kimi-k2.5");
    expect(provider instanceof OpenAIProvider).toBe(true);

    // Drive a request to verify the correct baseUrl is used
    await collectChunks(
      provider.chatCompletion({
        modelId: "moonshot/kimi-k2.5",
        messages: [{ role: "user", content: "ping" }],
      }),
    );

    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0]).toContain("api.moonshot.ai");
  });

  it("throws MODEL_NOT_CONFIGURED when no moonshot credentials exist", () => {
    const registry = bootstrapRegistry();

    let thrown: unknown;
    try {
      registry.resolveChat("moonshot/kimi-k2.5");
    } catch (error) {
      thrown = error;
    }

    expect(thrown instanceof MaidsClawError).toBe(true);
    expect((thrown as MaidsClawError).code).toBe("MODEL_NOT_CONFIGURED");
  });
});

describe("MiniMax via OpenAI-compatible transport", () => {
  it("resolves minimax/MiniMax-M2.5 to an OpenAIProvider via bootstrapRegistry", async () => {
    const fetchCalls: string[] = [];
    const mockFetch = (async (input: RequestInfo | URL) => {
      fetchCalls.push(String(input));
      return sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
        "data: [DONE]\n\n",
      ]);
    }) as typeof fetch;

    const registry = bootstrapRegistry({
      auth: {
        credentials: [{ provider: "minimax", type: "api-key", apiKey: "sk-minimax-test" }],
      },
      fetchImpl: mockFetch,
    });

    const provider = registry.resolveChat("minimax/MiniMax-M2.5");
    expect(provider instanceof OpenAIProvider).toBe(true);

    // Drive a request to verify the correct baseUrl is used
    await collectChunks(
      provider.chatCompletion({
        modelId: "minimax/MiniMax-M2.5",
        messages: [{ role: "user", content: "ping" }],
      }),
    );

    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0]).toContain("api.minimax.io");
  });

  it("throws MODEL_NOT_CONFIGURED when no minimax credentials exist", () => {
    const registry = bootstrapRegistry();

    let thrown: unknown;
    try {
      registry.resolveChat("minimax/MiniMax-M2.5");
    } catch (error) {
      thrown = error;
    }

    expect(thrown instanceof MaidsClawError).toBe(true);
    expect((thrown as MaidsClawError).code).toBe("MODEL_NOT_CONFIGURED");
  });
});

describe("Streaming chunk normalization (Moonshot)", () => {
  it("emits text_delta chunks from SSE stream", async () => {
    const mockFetch = (async (_input: RequestInfo | URL) => {
      return sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello from Kimi" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
        "data: [DONE]\n\n",
      ]);
    }) as typeof fetch;

    const registry = bootstrapRegistry({
      auth: {
        credentials: [{ provider: "moonshot", type: "api-key", apiKey: "sk-moonshot-test" }],
      },
      fetchImpl: mockFetch,
    });

    const provider = registry.resolveChat("moonshot/kimi-k2.5");
    const chunks = await collectChunks(
      provider.chatCompletion({
        modelId: "moonshot/kimi-k2.5",
        messages: [{ role: "user", content: "hello" }],
      }),
    );

    const textDeltas = chunks.filter((c) => c.type === "text_delta");
    expect(textDeltas.length).toBeGreaterThan(0);
    expect(textDeltas[0]).toEqual({ type: "text_delta", text: "Hello from Kimi" });

    const messageEnds = chunks.filter((c) => c.type === "message_end");
    expect(messageEnds.length).toBe(1);
  });
});

describe("Env var credential resolution", () => {
  it("resolveProviderCredential picks up MOONSHOT_API_KEY from env", () => {
    process.env.MOONSHOT_API_KEY = "sk-env-moonshot";

    const credential = resolveProviderCredential("moonshot", { credentials: [] });

    expect(credential).toBeDefined();
    expect(credential!.type).toBe("api-key");
    expect(credential!.provider).toBe("moonshot");
    expect((credential as { apiKey: string }).apiKey).toBe("sk-env-moonshot");
  });

  it("resolveProviderCredential picks up MINIMAX_API_KEY from env", () => {
    process.env.MINIMAX_API_KEY = "sk-env-minimax";

    const credential = resolveProviderCredential("minimax", { credentials: [] });

    expect(credential).toBeDefined();
    expect(credential!.type).toBe("api-key");
    expect(credential!.provider).toBe("minimax");
    expect((credential as { apiKey: string }).apiKey).toBe("sk-env-minimax");
  });
});
