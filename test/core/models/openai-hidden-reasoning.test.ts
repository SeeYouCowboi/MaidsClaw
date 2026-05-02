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

describe("OpenAIProvider — thinking-control fallback decision table", () => {
  type ProviderOpts = ConstructorParameters<typeof OpenAIProvider>[0];

  async function captureRequestForOpts(
    opts: Omit<ProviderOpts, "apiKey" | "fetchImpl">,
    requestPatch: { tools?: { name: string; inputSchema: Record<string, unknown> }[]; toolChoice?: { type: "auto" | "any" | "tool"; name?: string }; disableThinking?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    let captured: Record<string, unknown> | undefined;
    const provider = new OpenAIProvider({
      apiKey: "sk-test",
      baseUrl: "https://example.test",
      pathPrefix: "",
      ...opts,
      fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        captured = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
          "data: [DONE]\n\n",
        ]);
      }) as typeof fetch,
    });

    await collectChunks(
      provider.chatCompletion({
        modelId: "deepseek-v4-flash",
        messages: [{ role: "user", content: "hi" }],
        tools: requestPatch.tools,
        toolChoice: requestPatch.toolChoice as
          | { type: "auto" }
          | { type: "any" }
          | { type: "tool"; name: string }
          | undefined,
        disableThinking: requestPatch.disableThinking,
      }),
    );

    if (!captured) throw new Error("fetch was not invoked");
    return captured;
  }

  const lookupTool = {
    name: "lookup",
    inputSchema: { type: "object", properties: {} } as Record<string, unknown>,
  };

  it("auto-disables thinking when echo is required but unavailable AND tools are present", async () => {
    const body = await captureRequestForOpts(
      {
        supportsThinkingControl: true,
        requiresReasoningEchoForToolCalls: true,
        // supportsHiddenReasoningMetadata intentionally absent
      },
      { tools: [lookupTool] },
    );
    expect(body.thinking).toEqual({ type: "disabled" });
  });

  it("does NOT auto-disable thinking when echo is required AND echo plumbing is available", async () => {
    const body = await captureRequestForOpts(
      {
        supportsThinkingControl: true,
        requiresReasoningEchoForToolCalls: true,
        supportsHiddenReasoningMetadata: true,
      },
      { tools: [lookupTool] },
    );
    expect(body.thinking).toBeUndefined();
  });

  it("does NOT auto-disable thinking when no tools are present (echo only matters for continuations)", async () => {
    const body = await captureRequestForOpts(
      {
        supportsThinkingControl: true,
        requiresReasoningEchoForToolCalls: true,
      },
      { tools: undefined },
    );
    expect(body.thinking).toBeUndefined();
  });

  it("auto-disables thinking when disableThinkingForToolCalls is true AND tools are present", async () => {
    const body = await captureRequestForOpts(
      {
        supportsThinkingControl: true,
        disableThinkingForToolCalls: true,
      },
      { tools: [lookupTool] },
    );
    expect(body.thinking).toEqual({ type: "disabled" });
  });

  it("does NOT auto-disable when disableThinkingForToolCalls is true but there are no tools", async () => {
    const body = await captureRequestForOpts(
      {
        supportsThinkingControl: true,
        disableThinkingForToolCalls: true,
      },
      {},
    );
    expect(body.thinking).toBeUndefined();
  });

  it("preserves tool_choice='required' once thinking has been auto-disabled (no over-downgrade)", async () => {
    const body = await captureRequestForOpts(
      {
        supportsThinkingControl: true,
        requiresReasoningEchoForToolCalls: true,
      },
      { tools: [lookupTool], toolChoice: { type: "any" } },
    );
    // thinking gone → required is supported
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.tool_choice).toBe("required");
  });

  it("does NOT emit thinking:disabled when provider has no thinking-control capability", async () => {
    const body = await captureRequestForOpts(
      {
        // no supportsThinkingControl, no disableToolChoiceRequired
        requiresReasoningEchoForToolCalls: true,
      },
      { tools: [lookupTool] },
    );
    expect(body.thinking).toBeUndefined();
  });

  it("explicit request.disableThinking still takes effect on capable providers (regression)", async () => {
    const body = await captureRequestForOpts(
      { supportsThinkingControl: true },
      { disableThinking: true },
    );
    expect(body.thinking).toEqual({ type: "disabled" });
  });
});

describe("OpenAIProvider — idle timeout watchdog", () => {
  it("aborts a hanging fetch after requestIdleTimeoutMs and throws retriable MODEL_API_TIMEOUT", async () => {
    const provider = new OpenAIProvider({
      apiKey: "sk-test",
      baseUrl: "https://example.test",
      pathPrefix: "",
      // Idle timeout 1.5s — watchdog ticks every 1s, so 1500-2000ms is the
      // earliest the abort can fire.
      requestIdleTimeoutMs: 1_500,
      // Hang forever unless abort signal fires.
      fetchImpl: ((_input: RequestInfo | URL, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      }) as typeof fetch,
    });

    let caught: unknown;
    try {
      await collectChunks(
        provider.chatCompletion({
          modelId: "deepseek-v4-flash",
          messages: [{ role: "user", content: "ping" }],
        }),
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeDefined();
    expect((caught as { code: string }).code).toBe("MODEL_API_TIMEOUT");
    expect((caught as { retriable: boolean }).retriable).toBe(true);
  }, 10_000);

  it("aborts a stalled body stream after requestIdleTimeoutMs", async () => {
    const provider = new OpenAIProvider({
      apiKey: "sk-test",
      baseUrl: "https://example.test",
      pathPrefix: "",
      requestIdleTimeoutMs: 1_500,
      fetchImpl: ((_input: RequestInfo | URL, init?: RequestInit) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener("abort", () => {
              controller.error(new Error("aborted"));
            });
          },
        });
        return Promise.resolve(
          new Response(body, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
        );
      }) as typeof fetch,
    });

    let caught: unknown;
    try {
      await collectChunks(
        provider.chatCompletion({
          modelId: "deepseek-v4-flash",
          messages: [{ role: "user", content: "ping" }],
        }),
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeDefined();
    expect((caught as { code: string }).code).toBe("MODEL_API_TIMEOUT");
    expect((caught as { retriable: boolean }).retriable).toBe(true);
    expect((caught as { details: { phase: string } }).details.phase).toBe("stream");
  }, 10_000);

  it("does NOT abort when the body keeps sending SSE keep-alive bytes (DeepSeek peak-load behaviour)", async () => {
    // Simulates DeepSeek's documented behaviour: under peak load, the server
    // holds the connection open with periodic keep-alive comments (`:\n\n`)
    // that parseSingleSseEvent filters out. The watchdog must reset on these
    // raw byte arrivals, not on yielded events.
    const encoder = new TextEncoder();
    const provider = new OpenAIProvider({
      apiKey: "sk-test",
      baseUrl: "https://example.test",
      pathPrefix: "",
      requestIdleTimeoutMs: 1_500, // would trip in 1.5s of silence
      fetchImpl: (() => {
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            // Send 4 keep-alive comments at 700ms intervals (total 2.8s,
            // longer than the idle timeout — without onRead reset this
            // would abort).
            for (let i = 0; i < 4; i++) {
              controller.enqueue(encoder.encode(": keep-alive\n\n"));
              await new Promise((r) => setTimeout(r, 700));
            }
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`,
              ),
            );
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
              ),
            );
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        });
        return Promise.resolve(
          new Response(body, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
        );
      }) as typeof fetch,
    });

    const chunks = await collectChunks(
      provider.chatCompletion({
        modelId: "deepseek-v4-flash",
        messages: [{ role: "user", content: "ping" }],
      }),
    );

    expect(chunks.some((c) => c.type === "text_delta" && c.text === "ok")).toBe(true);
    expect(chunks.some((c) => c.type === "message_end")).toBe(true);
  }, 10_000);
});
