import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Chunk } from "../../../src/core/chunk.js";
import { OpenAIProvider } from "../../../src/core/models/openai-provider.js";
import type { ChatMessage } from "../../../src/core/models/chat-provider.js";

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

const originalEnv = { ...process.env };

beforeEach(() => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
});

afterEach(() => {
  Object.keys(process.env).forEach((key) => {
    if (!(key in originalEnv)) delete process.env[key];
  });
  Object.assign(process.env, originalEnv);
});

describe("OpenAIProvider — hidden reasoning stream parsing", () => {
  it("emits hidden_reasoning_delta chunks for reasoning_content fragments", async () => {
    const provider = new OpenAIProvider({
      apiKey: "sk-test",
      baseUrl: "https://example.test",
      pathPrefix: "",
      supportsThinkingControl: true,
      fetchImpl: (async () =>
        sseResponse([
          `data: ${JSON.stringify({
            choices: [{ delta: { reasoning_content: "the user wants" } }],
          })}\n\n`,
          `data: ${JSON.stringify({
            choices: [{ delta: { reasoning_content: " a polite reply" } }],
          })}\n\n`,
          `data: ${JSON.stringify({
            choices: [{ delta: { content: "Hi there." } }],
          })}\n\n`,
          `data: ${JSON.stringify({
            choices: [{ delta: {}, finish_reason: "stop" }],
          })}\n\n`,
          "data: [DONE]\n\n",
        ])) as typeof fetch,
    });

    const chunks = await collectChunks(
      provider.chatCompletion({
        modelId: "deepseek-v4-flash",
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    const hidden = chunks.filter((c) => c.type === "hidden_reasoning_delta");
    expect(hidden).toHaveLength(2);
    expect(hidden[0]).toEqual({
      type: "hidden_reasoning_delta",
      text: "the user wants",
      format: "openai_reasoning_content",
    });
    expect(hidden[1]).toEqual({
      type: "hidden_reasoning_delta",
      text: " a polite reply",
      format: "openai_reasoning_content",
    });

    // Text and message_end still flow normally (regression guard).
    expect(chunks.some((c) => c.type === "text_delta" && c.text === "Hi there.")).toBe(true);
    expect(chunks.some((c) => c.type === "message_end")).toBe(true);
  });

  it("does not synthesize a hidden_reasoning_delta when reasoning_content is missing", async () => {
    const provider = new OpenAIProvider({
      apiKey: "sk-test",
      baseUrl: "https://example.test",
      pathPrefix: "",
      fetchImpl: (async () =>
        sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
          "data: [DONE]\n\n",
        ])) as typeof fetch,
    });

    const chunks = await collectChunks(
      provider.chatCompletion({
        modelId: "deepseek-v4-flash",
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    expect(chunks.some((c) => c.type === "hidden_reasoning_delta")).toBe(false);
  });

  it("ignores empty-string reasoning_content (does not emit a no-op chunk)", async () => {
    const provider = new OpenAIProvider({
      apiKey: "sk-test",
      baseUrl: "https://example.test",
      pathPrefix: "",
      fetchImpl: (async () =>
        sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "" } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
          "data: [DONE]\n\n",
        ])) as typeof fetch,
    });

    const chunks = await collectChunks(
      provider.chatCompletion({
        modelId: "deepseek-v4-flash",
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    expect(chunks.some((c) => c.type === "hidden_reasoning_delta")).toBe(false);
  });
});

describe("OpenAIProvider — hidden reasoning request echo", () => {
  async function captureRequestBody(messages: ChatMessage[]): Promise<Record<string, unknown>> {
    let captured: Record<string, unknown> | undefined;
    const provider = new OpenAIProvider({
      apiKey: "sk-test",
      baseUrl: "https://example.test",
      pathPrefix: "",
      fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        captured = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
          "data: [DONE]\n\n",
        ]);
      }) as typeof fetch,
    });

    await collectChunks(
      provider.chatCompletion({ modelId: "deepseek-v4-flash", messages }),
    );

    if (!captured) throw new Error("fetch was not invoked");
    return captured;
  }

  it("echoes reasoning_content on assistant messages with tool_calls", async () => {
    const reasoning = "I need to call get_weather to fulfill this.";
    const body = await captureRequestBody([
      { role: "user", content: "weather in Paris" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Paris" } },
        ],
        providerMetadata: {
          hiddenReasoning: {
            format: "openai_reasoning_content",
            text: reasoning,
          },
        },
      },
      { role: "tool", toolCallId: "call_1", content: "sunny" },
    ]);

    const messages = body.messages as Array<Record<string, unknown>>;
    const assistantMsg = messages.find((m) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.reasoning_content).toBe(reasoning);
    expect(Array.isArray(assistantMsg!.tool_calls)).toBe(true);
  });

  it("echoes reasoning_content on plain string-content assistant messages", async () => {
    const body = await captureRequestBody([
      {
        role: "assistant",
        content: "ok",
        providerMetadata: {
          hiddenReasoning: { format: "openai_reasoning_content", text: "thought" },
        },
      },
    ]);
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages[0]?.reasoning_content).toBe("thought");
  });

  it("does NOT echo reasoning_content on user/tool messages even if metadata is set", async () => {
    const body = await captureRequestBody([
      {
        role: "user",
        content: "hi",
        providerMetadata: {
          hiddenReasoning: { format: "openai_reasoning_content", text: "leak" },
        },
      },
      {
        role: "tool",
        toolCallId: "x",
        content: "result",
        providerMetadata: {
          hiddenReasoning: { format: "openai_reasoning_content", text: "leak2" },
        },
      },
    ]);

    const messages = body.messages as Array<Record<string, unknown>>;
    for (const msg of messages) {
      expect(msg.reasoning_content).toBeUndefined();
    }
  });

  it("does NOT echo when format is anthropic_thinking_blocks (wrong serializer)", async () => {
    const body = await captureRequestBody([
      {
        role: "assistant",
        content: "ok",
        providerMetadata: {
          hiddenReasoning: { format: "anthropic_thinking_blocks", blocks: [] },
        },
      },
    ]);
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages[0]?.reasoning_content).toBeUndefined();
  });

  it("omits the field entirely when no providerMetadata is set", async () => {
    const body = await captureRequestBody([
      { role: "user", content: "hi" },
      { role: "assistant", content: "ok" },
    ]);
    const messages = body.messages as Array<Record<string, unknown>>;
    expect("reasoning_content" in messages[0]!).toBe(false);
    expect("reasoning_content" in messages[1]!).toBe(false);
  });
});
