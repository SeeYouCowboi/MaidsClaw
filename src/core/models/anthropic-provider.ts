import type { Chunk } from "../chunk.js";
import { MaidsClawError } from "../errors.js";
import type { Logger } from "../logger.js";
import type {
  ChatCompletionRequest,
  ChatMessage,
  ChatModelProvider,
  ContentBlock,
  ToolSchema,
} from "./chat-provider.js";

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type AnthropicMessageRole = "user" | "assistant";

type AnthropicTextBlock = {
  type: "text";
  text: string;
};

type AnthropicToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};

type AnthropicToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
};

type AnthropicMessage = {
  role: AnthropicMessageRole;
  content: (AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock)[];
};

type AnthropicEvent = {
  type: string;
  message?: {
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
    };
  };
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    stop_reason?: string | null;
  };
  content_block?: {
    type: string;
    id?: string;
    name?: string;
  };
  index?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
};

const ANTHROPIC_VERSION = "2023-06-01";

export type AnthropicChatProviderOptions = {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: FetchFn;
  logger?: Logger;
};

export class AnthropicChatProvider implements ChatModelProvider {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchFn;
  private readonly logger?: Logger;

  constructor(private readonly options: AnthropicChatProviderOptions) {
    this.baseUrl = options.baseUrl ?? "https://api.anthropic.com";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger;
  }

  async *chatCompletion(request: ChatCompletionRequest): AsyncIterable<Chunk> {
    const payload = this.toRequestPayload(request);
    const response = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.options.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new MaidsClawError({
        code: "MODEL_API_ERROR",
        message: `Anthropic API returned ${response.status}`,
        retriable: response.status >= 500,
        details: { status: response.status },
      });
    }

    if (!response.body) {
      throw new MaidsClawError({
        code: "MODEL_API_ERROR",
        message: "Anthropic API response body was empty",
        retriable: true,
      });
    }

    let stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" = "end_turn";
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    const toolIdsByIndex = new Map<number, string>();

    for await (const event of parseSseEvents(response.body)) {
      if (!event.data || event.data === "[DONE]") {
        continue;
      }

      let parsed: AnthropicEvent;
      try {
        parsed = JSON.parse(event.data) as AnthropicEvent;
      } catch (error) {
        this.logger?.warn("Skipping malformed Anthropic SSE payload", { error: String(error) });
        continue;
      }

      if (parsed.type === "message_start") {
        inputTokens = parsed.message?.usage?.input_tokens;
        outputTokens = parsed.message?.usage?.output_tokens;
      }

      if (parsed.type === "content_block_start" && parsed.content_block?.type === "tool_use") {
        const id = parsed.content_block.id;
        const name = parsed.content_block.name;
        const index = parsed.index;
        if (id && name && typeof index === "number") {
          toolIdsByIndex.set(index, id);
          yield { type: "tool_use_start", id, name };
        }
      }

      if (parsed.type === "content_block_delta" && parsed.delta?.type === "text_delta" && parsed.delta.text) {
        yield { type: "text_delta", text: parsed.delta.text };
      }

      if (
        parsed.type === "content_block_delta" &&
        parsed.delta?.type === "input_json_delta" &&
        typeof parsed.index === "number"
      ) {
        const id = toolIdsByIndex.get(parsed.index);
        if (id && parsed.delta.partial_json) {
          yield { type: "tool_use_delta", id, partialJson: parsed.delta.partial_json };
        }
      }

      if (parsed.type === "content_block_stop" && typeof parsed.index === "number") {
        const id = toolIdsByIndex.get(parsed.index);
        if (id) {
          yield { type: "tool_use_end", id };
        }
      }

      if (parsed.type === "message_delta") {
        const maybeStopReason = parsed.delta?.stop_reason;
        if (maybeStopReason) {
          stopReason = normalizeStopReason(maybeStopReason);
        }
        if (typeof parsed.usage?.output_tokens === "number") {
          outputTokens = parsed.usage.output_tokens;
        }
      }

      if (parsed.type === "message_stop") {
        yield {
          type: "message_end",
          stopReason,
          inputTokens,
          outputTokens,
        };
        return;
      }
    }

    yield {
      type: "message_end",
      stopReason,
      inputTokens,
      outputTokens,
    };
  }

  private toRequestPayload(request: ChatCompletionRequest): Record<string, unknown> {
    const systemPrompt = request.systemPrompt ?? request.messages.find((message) => message.role === "system")?.content;

    // Strip provider prefix (e.g. "minimax/model-x" → "model-x")
    const bareModelId = request.modelId.includes("/")
      ? request.modelId.slice(request.modelId.indexOf("/") + 1)
      : request.modelId;

    // Map provider-agnostic toolChoice to Anthropic's tool_choice format
    let toolChoice: Record<string, unknown> | undefined;
    if (request.toolChoice) {
      if (request.toolChoice.type === "tool") {
        toolChoice = { type: "tool", name: request.toolChoice.name };
      } else {
        toolChoice = { type: request.toolChoice.type };
      }
    }

    return {
      model: bareModelId,
      max_tokens: request.maxTokens ?? 1024,
      temperature: request.temperature,
      stream: true,
      system: typeof systemPrompt === "string" ? systemPrompt : undefined,
      tools: request.tools?.map((tool) => this.toAnthropicTool(tool)),
      tool_choice: toolChoice,
      messages: request.messages
        .filter((message) => message.role !== "system")
        .map((message) => this.toAnthropicMessage(message)),
    };
  }

  private toAnthropicTool(tool: ToolSchema): Record<string, unknown> {
    return {
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    };
  }

  private toAnthropicMessage(message: ChatMessage): AnthropicMessage {
    if (message.role === "tool") {
      return {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: message.toolCallId ?? "",
            content: typeof message.content === "string" ? message.content : JSON.stringify(message.content),
          },
        ],
      };
    }

    const role: AnthropicMessageRole = message.role === "assistant" ? "assistant" : "user";
    return {
      role,
      content: toAnthropicBlocks(message.content),
    };
  }
}

function toAnthropicBlocks(content: string | ContentBlock[]): (AnthropicTextBlock | AnthropicToolUseBlock)[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }

  return content
    .map((block) => {
      if (block.type === "text") {
        return { type: "text", text: block.text };
      }
      if (block.type === "tool_use") {
        return {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input,
        };
      }
      return null;
    })
    .filter((block): block is AnthropicTextBlock | AnthropicToolUseBlock => block !== null);
}

function normalizeStopReason(reason: string): "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" {
  if (reason === "end_turn" || reason === "tool_use" || reason === "max_tokens" || reason === "stop_sequence") {
    return reason;
  }
  return "end_turn";
}

type SseEvent = {
  event?: string;
  data?: string;
};

async function* parseSseEvents(stream: ReadableStream<Uint8Array>): AsyncIterable<SseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const parsedEvent = parseSingleSseEvent(rawEvent);
      if (parsedEvent.data || parsedEvent.event) {
        yield parsedEvent;
      }
      boundary = buffer.indexOf("\n\n");
    }
  }

  buffer += decoder.decode();
  if (buffer.trim().length > 0) {
    const parsedEvent = parseSingleSseEvent(buffer);
    if (parsedEvent.data || parsedEvent.event) {
      yield parsedEvent;
    }
  }
}

function parseSingleSseEvent(rawEvent: string): SseEvent {
  const lines = rawEvent.split("\n");
  const dataLines: string[] = [];
  let eventName: string | undefined;

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
