import type { Chunk } from "../chunk.js";
import { MaidsClawError } from "../errors.js";
import type { Logger } from "../logger.js";
import type { ChatCompletionRequest, ChatMessage, ChatModelProvider, ContentBlock } from "./chat-provider.js";
import type { EmbeddingProvider, EmbeddingPurpose } from "./embedding-provider.js";

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type OpenAIChatProviderOptions = {
  apiKey: string;
  defaultEmbeddingModel?: string;
  baseUrl?: string;
  fetchImpl?: FetchFn;
  logger?: Logger;
  supportsStreamingUsage?: boolean;
  extraHeaders?: Record<string, string>;
  pathPrefix?: string;
  supportsThinkingControl?: boolean;
  disableToolChoiceRequired?: boolean;
  supportsHiddenReasoningMetadata?: boolean;
  requiresReasoningEchoForToolCalls?: boolean;
  disableThinkingForToolCalls?: boolean;
  embeddingDimensions?: number;
  /**
   * Idle timeout: aborts the request when no bytes have arrived from the
   * server for this many ms (covering both the initial connect/headers
   * phase and the body stream phase). Each successful body-stream read —
   * including SSE keep-alive comments that do not surface as events —
   * resets the timer. This matches DeepSeek's documented behaviour
   * (https://api-docs.deepseek.com/zh-cn/quick_start/rate_limit) of
   * holding the connection open with periodic keep-alive lines during
   * peak load.
   *
   * Defaults to 30s. Combined with the 3-attempt retry loop in
   * runRpTalkerTurn (1s + 2s + 4s back-off), worst-case wall-clock is
   * ~97s, well inside the 180s gateway-serialised user-message-commit
   * budget. Set to 0 to disable.
   */
  requestIdleTimeoutMs?: number;
};

type OpenAIChatDeltaToolCall = {
  index: number;
  id?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
};

type OpenAIChatChunkPayload = {
  choices?: Array<{
    delta?: {
      content?: string;
      tool_calls?: OpenAIChatDeltaToolCall[];
      // DeepSeek (and other thinking-capable OpenAI-compatible providers)
      // surface their hidden reasoning stream alongside `content`. The field
      // is provider-specific and intentionally not part of the OpenAI spec.
      reasoning_content?: string;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

type OpenAIEmbeddingResponse = {
  data: Array<{
    embedding: number[];
  }>;
};

export class OpenAIProvider implements ChatModelProvider, EmbeddingProvider {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchFn;
  private readonly logger?: Logger;
  private readonly defaultEmbeddingModel: string;
  private readonly pathPrefix: string;

  constructor(private readonly options: OpenAIChatProviderOptions) {
    this.baseUrl = options.baseUrl ?? "https://api.openai.com";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger;
    this.defaultEmbeddingModel = options.defaultEmbeddingModel ?? "text-embedding-3-small";
    this.pathPrefix = normalizePathPrefix(options.pathPrefix);
  }

  async *chatCompletion(request: ChatCompletionRequest): AsyncIterable<Chunk> {
    const payload = this.toChatRequestPayload(request);
    const payloadJson = JSON.stringify(payload);
    this.logger?.debug("Model request", {
      model: payload.model,
      messageCount: (payload.messages as unknown[])?.length,
      toolCount: (payload.tools as unknown[])?.length,
      maxTokens: payload.max_tokens,
      payloadBytes: payloadJson.length,
    });

    const idleTimeoutMs = this.options.requestIdleTimeoutMs ?? 30_000;
    const abortController = new AbortController();
    let lastActivity = Date.now();
    const resetIdle = (): void => {
      lastActivity = Date.now();
    };
    const watchdogHandle =
      idleTimeoutMs > 0
        ? setInterval(() => {
            if (Date.now() - lastActivity > idleTimeoutMs) {
              abortController.abort();
            }
          }, 1_000)
        : undefined;
    try {
      yield* this.streamChatCompletion(
        request,
        payloadJson,
        abortController.signal,
        idleTimeoutMs,
        resetIdle,
      );
    } finally {
      if (watchdogHandle !== undefined) {
        clearInterval(watchdogHandle);
      }
    }
  }

  private async *streamChatCompletion(
    request: ChatCompletionRequest,
    payloadJson: string,
    signal: AbortSignal,
    idleTimeoutMs: number,
    onActivity: () => void,
  ): AsyncIterable<Chunk> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${this.pathPrefix}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.options.apiKey}`,
          ...this.options.extraHeaders,
        },
        body: payloadJson,
        signal,
      });
      onActivity();
    } catch (error) {
      if (signal.aborted) {
        throw new MaidsClawError({
          code: "MODEL_API_TIMEOUT",
          message: `OpenAI chat request idle for >${idleTimeoutMs}ms during connect/headers`,
          retriable: true,
          details: { idleTimeoutMs, phase: "connect" },
        });
      }
      throw error;
    }

    if (!response.ok) {
      let errorBody: string | undefined;
      try {
        errorBody = await response.text();
      } catch {
        errorBody = undefined;
      }

      const parsedError = parseErrorBody(errorBody);
      const msgRoles = request.messages
        .map((m) => `${m.role}${m.toolCallId ? `(tcid:${m.toolCallId})` : ""}`)
        .join(", ");
      this.logger?.error("Model API error", undefined, {
        status: response.status,
        errorType: parsedError?.type,
        errorMessage: parsedError?.message,
        messageRoles: msgRoles,
        errorBody: errorBody?.slice(0, 500),
      });

      throw new MaidsClawError({
        code: "MODEL_API_ERROR",
        message: `OpenAI chat API returned ${response.status}: ${parsedError?.message ?? errorBody?.slice(0, 200) ?? "no body"} [roles: ${msgRoles}]`,
        retriable: response.status >= 500,
        details: {
          status: response.status,
          errorType: parsedError?.type,
          errorMessage: parsedError?.message,
          messageRoles: msgRoles,
          errorBody: errorBody?.slice(0, 500),
        },
      });
    }

    if (!response.body) {
      throw new MaidsClawError({
        code: "MODEL_API_ERROR",
        message: "OpenAI chat response body was empty",
        retriable: true,
      });
    }

    let stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" = "end_turn";
    const toolIdsByIndex = new Map<number, string>();
    const toolNamesByIndex = new Map<number, string>();
    const startedToolIds = new Set<string>();
    const closedToolIds = new Set<string>();
    let emittedMessageEnd = false;
    let usageInputTokens: number | undefined;
    let usageOutputTokens: number | undefined;
    const sseIterator = (async function* (
      body: ReadableStream<Uint8Array>,
      signalRef: AbortSignal,
      idleMs: number,
      heartbeat: () => void,
    ): AsyncIterable<SseEvent> {
      try {
        for await (const event of parseSseEvents(body, heartbeat)) {
          yield event;
        }
      } catch (error) {
        if (signalRef.aborted) {
          throw new MaidsClawError({
            code: "MODEL_API_TIMEOUT",
            message: `OpenAI chat stream idle for >${idleMs}ms`,
            retriable: true,
            details: { idleTimeoutMs: idleMs, phase: "stream" },
          });
        }
        throw error;
      }
    })(response.body, signal, idleTimeoutMs, onActivity);
    for await (const event of sseIterator) {
      if (!event.data) {
        continue;
      }

      if (event.data === "[DONE]") {
        if (!emittedMessageEnd) {
          for (const id of toolIdsByIndex.values()) {
            if (!closedToolIds.has(id)) {
              yield { type: "tool_use_end", id };
              closedToolIds.add(id);
            }
          }

          yield { type: "message_end", stopReason, inputTokens: usageInputTokens, outputTokens: usageOutputTokens };
          emittedMessageEnd = true;
        }
        return;
      }

      let payload: OpenAIChatChunkPayload;
      try {
        payload = JSON.parse(event.data) as OpenAIChatChunkPayload;
      } catch (error) {
        this.logger?.warn("Skipping malformed OpenAI SSE payload", { error: String(error) });
        continue;
      }

      const choice = payload.choices?.[0];

      // Handle usage-only final chunk (no choices, just usage)
      if (!choice && payload.usage) {
        usageInputTokens = payload.usage.prompt_tokens;
        usageOutputTokens = payload.usage.completion_tokens;
        continue;
      }

      if (!choice) {
        continue;
      }

      const content = choice.delta?.content;
      if (content) {
        yield { type: "text_delta", text: content };
      }

      const reasoning = choice.delta?.reasoning_content;
      if (reasoning) {
        yield {
          type: "hidden_reasoning_delta",
          text: reasoning,
          format: "openai_reasoning_content",
        };
      }

        for (const toolCall of choice.delta?.tool_calls ?? []) {
          const callIndex = toolCall.index;
          const callId = toolCall.id ?? toolIdsByIndex.get(callIndex);
        if (!callId) {
          continue;
        }

        if (toolCall.id) {
          toolIdsByIndex.set(callIndex, callId);
        }

        const toolName = toolCall.function?.name ?? toolNamesByIndex.get(callIndex);
        if (toolCall.function?.name) {
          toolNamesByIndex.set(callIndex, toolCall.function.name);
        }

        if (toolName && !startedToolIds.has(callId)) {
          yield { type: "tool_use_start", id: callId, name: toolName };
          startedToolIds.add(callId);
        }

        const partialArguments = toolCall.function?.arguments;
        if (partialArguments) {
          yield { type: "tool_use_delta", id: callId, partialJson: partialArguments };
        }
      }

      if (choice.finish_reason) {
        stopReason = normalizeOpenAIStopReason(choice.finish_reason);

        for (const id of toolIdsByIndex.values()) {
          if (startedToolIds.has(id) && !closedToolIds.has(id)) {
            yield { type: "tool_use_end", id };
            closedToolIds.add(id);
          }
        }

        if (!emittedMessageEnd && !this.options.supportsStreamingUsage) {
          yield { type: "message_end", stopReason, inputTokens: usageInputTokens, outputTokens: usageOutputTokens };
          emittedMessageEnd = true;
        }
      }
    }

    if (!emittedMessageEnd) {
      for (const id of toolIdsByIndex.values()) {
        if (startedToolIds.has(id) && !closedToolIds.has(id)) {
          yield { type: "tool_use_end", id };
        }
      }
      yield { type: "message_end", stopReason, inputTokens: usageInputTokens, outputTokens: usageOutputTokens };
    }
  }

  async embed(texts: string[], purpose: EmbeddingPurpose, modelId: string): Promise<Float32Array[]> {
    const bareModelId = modelId.includes("/")
      ? modelId.slice(modelId.indexOf("/") + 1)
      : modelId;

    const response = await this.fetchImpl(`${this.baseUrl}${this.pathPrefix}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.options.apiKey}`,
        ...this.options.extraHeaders,
      },
      body: JSON.stringify({
        model: bareModelId || this.defaultEmbeddingModel,
        input: texts,
        user: purpose,
        ...(this.options.embeddingDimensions ? { dimensions: this.options.embeddingDimensions } : {}),
      }),
    });

    if (!response.ok) {
      throw new MaidsClawError({
        code: "MODEL_API_ERROR",
        message: `OpenAI embeddings API returned ${response.status}`,
        retriable: response.status >= 500,
        details: { status: response.status },
      });
    }

    const payload = (await response.json()) as OpenAIEmbeddingResponse;
    return payload.data.map((item) => new Float32Array(item.embedding));
  }

  private toChatRequestPayload(request: ChatCompletionRequest): Record<string, unknown> {
    const systemPrompt = request.systemPrompt;
    const messages = request.messages.map((message) => toOpenAIMessage(message));
    if (systemPrompt) {
      messages.unshift({ role: "system", content: systemPrompt });
    }

    // Strip provider prefix (e.g. "moonshot/kimi-k2.5" → "kimi-k2.5") —
    // the prefix is an internal routing mechanism, not part of the API model name.
    const bareModelId = request.modelId.includes("/")
      ? request.modelId.slice(request.modelId.indexOf("/") + 1)
      : request.modelId;

    // ── Thinking-control fallback decision table ──────────────────────
    // Some thinking-capable OpenAI-compatible providers support
    // thinking:{type:"disabled"} for low-latency calls. We additionally
    // auto-disable thinking when the provider would reject a tool
    // continuation without an echo of the prior turn's reasoning, and
    // we don't yet have echo plumbing wired for that provider.
    const hasTools = (request.tools?.length ?? 0) > 0;
    const echoRequiredButUnavailable =
      hasTools &&
      this.options.requiresReasoningEchoForToolCalls === true &&
      this.options.supportsHiddenReasoningMetadata !== true;
    const explicitDisableForTools =
      hasTools && this.options.disableThinkingForToolCalls === true;
    const autoDisableThinking = echoRequiredButUnavailable || explicitDisableForTools;

    if (autoDisableThinking) {
      this.logger?.warn("Auto-disabling thinking for tool-call request", {
        reason: echoRequiredButUnavailable
          ? "echo_required_but_unavailable"
          : "disable_thinking_for_tool_calls",
        toolCount: request.tools?.length ?? 0,
      });
    }

    const thinkingDisabled =
      (request.disableThinking || autoDisableThinking) &&
      (this.options.disableToolChoiceRequired || this.options.supportsThinkingControl);

    // Map provider-agnostic toolChoice to OpenAI's tool_choice format
    let toolChoice: string | Record<string, unknown> | undefined;
    if (request.toolChoice) {
      if (request.toolChoice.type === "auto") {
        toolChoice = "auto";
      } else if (request.toolChoice.type === "any") {
        // With thinking disabled, "required" is supported even on Moonshot/Kimi.
        const forceAuto = this.options.disableToolChoiceRequired && !thinkingDisabled;
        toolChoice = forceAuto ? "auto" : "required";
      } else if (request.toolChoice.type === "tool") {
        toolChoice = { type: "function", function: { name: request.toolChoice.name } };
      }
    }

    const result: Record<string, unknown> = {
      model: bareModelId,
      stream: true,
      temperature: request.temperature,
      max_tokens: request.maxTokens,
      messages,
      tools: request.tools?.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      })),
      tool_choice: toolChoice,
    };

    // Thinking-capable providers (Kimi K2.5, DeepSeek V4) can skip reasoning
    // for low-latency Talker/structured extraction requests.
    if (thinkingDisabled) {
      result.thinking = { type: "disabled" };
    }

    if (this.options.supportsStreamingUsage) {
      result.stream_options = { include_usage: true };
    }

    return result;
  }
}

function normalizePathPrefix(pathPrefix: string | undefined): string {
  if (pathPrefix === undefined) {
    return "/v1";
  }
  const trimmed = pathPrefix.trim();
  if (trimmed === "" || trimmed === "/") {
    return "";
  }
  return trimmed.startsWith("/") ? trimmed.replace(/\/+$/, "") : `/${trimmed.replace(/\/+$/, "")}`;
}

function toOpenAIMessage(message: ChatMessage): Record<string, unknown> {
  // Hidden reasoning echo (DeepSeek `reasoning_content`). Only attached to
  // prior-turn assistant messages. The provider serializer is the *only*
  // place this field should be read from `ChatMessage.providerMetadata`.
  const reasoningEcho =
    message.role === "assistant" &&
    message.providerMetadata?.hiddenReasoning?.format === "openai_reasoning_content"
      ? message.providerMetadata.hiddenReasoning.text
      : undefined;

  if (typeof message.content === "string") {
    return {
      role: message.role === "tool" ? "tool" : message.role,
      content: message.content,
      tool_call_id: message.toolCallId,
      ...(reasoningEcho !== undefined ? { reasoning_content: reasoningEcho } : {}),
    };
  }

  const textBlocks = message.content.filter((b) => b.type === "text");
  const toolUseBlocks = message.content.filter((b) => b.type === "tool_use");

  if (toolUseBlocks.length > 0 && message.role === "assistant") {
    const textContent = textBlocks.map((b) => b.text).join("");
    const toolCalls = toolUseBlocks.map((b, i) => ({
      id: b.id,
      type: "function" as const,
      index: i,
      function: {
        name: b.name,
        arguments: typeof b.input === "string" ? b.input : JSON.stringify(b.input),
      },
    }));

    return {
      role: "assistant",
      content: textContent || null,
      tool_calls: toolCalls,
      ...(reasoningEcho !== undefined ? { reasoning_content: reasoningEcho } : {}),
    };
  }

  return {
    role: message.role === "tool" ? "tool" : message.role,
    content: toOpenAIContentBlocks(message.content),
    tool_call_id: message.toolCallId,
    ...(reasoningEcho !== undefined ? { reasoning_content: reasoningEcho } : {}),
  };
}

function toOpenAIContentBlocks(content: ContentBlock[]): Record<string, unknown>[] {
  return content.map((block) => {
    if (block.type === "text") {
      return { type: "text", text: block.text };
    }

    if (block.type === "tool_result") {
      return {
        type: "tool_result",
        tool_call_id: block.toolCallId,
        content: block.content,
      };
    }

    return {
      type: "tool_use",
      id: block.id,
      name: block.name,
      input: block.input,
    };
  });
}

function normalizeOpenAIStopReason(
  reason: string
): "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" {
  if (reason === "tool_calls") {
    return "tool_use";
  }
  if (reason === "length") {
    return "max_tokens";
  }
  if (reason === "stop") {
    return "end_turn";
  }
  return "stop_sequence";
}

type SseEvent = {
  event?: string;
  data?: string;
};

async function* parseSseEvents(
  stream: ReadableStream<Uint8Array>,
  onRead?: () => void,
): AsyncIterable<SseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    // Reset the idle timer on every byte arrival, including SSE keep-alive
    // comments that parseSingleSseEvent filters out before yielding. Without
    // this, DeepSeek's peak-load keep-alive lines (':\n\n') would be dropped
    // and the watchdog would trip even though the connection is alive.
    onRead?.();

    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");

    while (boundary >= 0) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const parsed = parseSingleSseEvent(rawEvent);
      if (parsed.event || parsed.data) {
        yield parsed;
      }
      boundary = buffer.indexOf("\n\n");
    }
  }

  buffer += decoder.decode();
  if (buffer.trim().length > 0) {
    const parsed = parseSingleSseEvent(buffer);
    if (parsed.event || parsed.data) {
      yield parsed;
    }
  }
}

function parseErrorBody(body: string | undefined): { type?: string; message?: string } | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as { error?: { type?: string; message?: string } };
    return parsed?.error;
  } catch {
    return undefined;
  }
}

function parseSingleSseEvent(rawEvent: string): SseEvent {
  const lines = rawEvent.split("\n");
  let eventName: string | undefined;
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim();
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trim());
    }
  }

  return {
    event: eventName,
    data: dataLines.length > 0 ? dataLines.join("\n") : undefined,
  };
}
