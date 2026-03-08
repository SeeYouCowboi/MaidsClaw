import type { AgentProfile } from "../agents/profile.js";
import type { Chunk, TextDeltaChunk } from "./chunk.js";
import { MaidsClawError, wrapError } from "./errors.js";
import type { Logger } from "./logger.js";
import type { ChatCompletionRequest, ChatMessage, ChatModelProvider, ContentBlock } from "./models/chat-provider.js";
import { createRunContext } from "./run-context.js";
import { NoopRuntimeProjectionSink } from "./runtime-projection.js";
import type { RuntimeProjectionSink } from "./runtime-projection.js";
import type { ProjectionAppendix } from "./types.js";
import type { ToolExecutor } from "./tools/tool-executor.js";

type PendingToolCall = {
  id: string;
  name: string;
  argumentsJson: string;
};

export interface AgentLoopOptions {
  profile: AgentProfile;
  modelProvider: ChatModelProvider;
  toolExecutor: ToolExecutor;
  projectionSink?: RuntimeProjectionSink;
  logger?: Logger;
  maxDelegationDepth?: number;
}

export interface AgentRunRequest {
  sessionId: string;
  requestId: string;
  messages: ChatMessage[];
  delegationDepth?: number;
  parentRunId?: string;
}

export class AgentLoop {
  private readonly profile: AgentProfile;
  private readonly modelProvider: ChatModelProvider;
  private readonly toolExecutor: ToolExecutor;
  private readonly projectionSink: RuntimeProjectionSink;
  private readonly logger?: Logger;
  private readonly maxDelegationDepth: number;

  constructor(options: AgentLoopOptions) {
    this.profile = options.profile;
    this.modelProvider = options.modelProvider;
    this.toolExecutor = options.toolExecutor;
    this.projectionSink = options.projectionSink ?? new NoopRuntimeProjectionSink();
    this.logger = options.logger;
    this.maxDelegationDepth = options.maxDelegationDepth ?? 3;
  }

  async *run(request: AgentRunRequest): AsyncIterable<Chunk> {
    const delegationDepth = request.delegationDepth ?? 0;
    if (delegationDepth >= this.maxDelegationDepth) {
      throw new MaidsClawError({
        code: "DELEGATION_DEPTH_EXCEEDED",
        message: `Delegation depth ${delegationDepth} reached max ${this.maxDelegationDepth}`,
        retriable: false,
      });
    }

    const runContext = createRunContext(request.sessionId, request.requestId, this.profile.id, {
      delegationDepth,
      parentRunId: request.parentRunId,
    });
    const loopLogger = this.logger?.child({
      session_id: request.sessionId,
      request_id: request.requestId,
      agent_id: this.profile.id,
    });

    const workingMessages = [...request.messages];
    let turnIndex = 0;

    while (true) {
      turnIndex += 1;
      const pendingToolCalls = new Map<string, PendingToolCall>();
      const completedToolCalls: PendingToolCall[] = [];
      const assistantBlocks: ContentBlock[] = [];
      const assistantToolBlockIndices = new Map<string, number>();
      let assistantText = "";
      let sawMessageEnd = false;

      try {
        const completionRequest = this.buildCompletionRequest(workingMessages);
        for await (const chunk of this.modelProvider.chatCompletion(completionRequest)) {
          if (chunk.type === "text_delta") {
            assistantText += chunk.text;
            appendTextBlock(assistantBlocks, chunk);
            yield chunk;
            continue;
          }

          if (chunk.type === "tool_use_start") {
            pendingToolCalls.set(chunk.id, {
              id: chunk.id,
              name: chunk.name,
              argumentsJson: "",
            });
            assistantToolBlockIndices.set(chunk.id, assistantBlocks.length);
            assistantBlocks.push({
              type: "tool_use",
              id: chunk.id,
              name: chunk.name,
              input: {},
            });
            yield chunk;
            continue;
          }

          if (chunk.type === "tool_use_delta") {
            const pending = pendingToolCalls.get(chunk.id);
            if (pending) {
              pending.argumentsJson += chunk.partialJson;
            }
            yield chunk;
            continue;
          }

          if (chunk.type === "tool_use_end") {
            const pending = pendingToolCalls.get(chunk.id);
            if (pending) {
              completedToolCalls.push(pending);
              pendingToolCalls.delete(chunk.id);
            }
            yield chunk;
            continue;
          }

          if (chunk.type === "message_end") {
            sawMessageEnd = true;
            yield chunk;
            continue;
          }

          yield chunk;
        }
      } catch (error) {
        const wrapped = wrapError(error, { code: "MODEL_API_ERROR", retriable: true });
        loopLogger?.error("Agent loop model call failed", wrapped, { turn: turnIndex });
        yield {
          type: "error",
          code: wrapped.code,
          message: wrapped.message,
          retriable: wrapped.retriable,
        };
        return;
      }

      const normalizedToolCalls: Array<{
        id: string;
        name: string;
        params: Record<string, unknown>;
      }> = [];

      try {
        for (const toolCall of completedToolCalls) {
          const parsed = parseToolArgs(toolCall);
          const blockIndex = assistantToolBlockIndices.get(toolCall.id);
          if (blockIndex !== undefined) {
            assistantBlocks[blockIndex] = {
              type: "tool_use",
              id: toolCall.id,
              name: toolCall.name,
              input: parsed,
            };
          }

          normalizedToolCalls.push({
            id: toolCall.id,
            name: toolCall.name,
            params: parsed,
          });
        }
      } catch (error) {
        const wrapped = wrapError(error, { code: "TOOL_ARGUMENT_INVALID", retriable: false });
        loopLogger?.warn("Agent loop received malformed tool arguments", { turn: turnIndex, code: wrapped.code });
        yield {
          type: "error",
          code: wrapped.code,
          message: wrapped.message,
          retriable: wrapped.retriable,
        };
        return;
      }

      const assistantMessage = finalizeAssistantMessage(assistantBlocks, assistantText);
      if (assistantMessage) {
        workingMessages.push(assistantMessage);
        if (sawMessageEnd) {
          this.projectionSink.onProjectionEligible(
            createProjectionAppendix(assistantText, runContext.agentId, request.requestId, turnIndex),
            request.sessionId
          );
        }
      }

      if (normalizedToolCalls.length === 0) {
        return;
      }

      try {
        for (const toolCall of normalizedToolCalls) {
          const result = await this.toolExecutor.execute(toolCall.name, toolCall.params, {
            sessionId: request.sessionId,
            agentId: this.profile.id,
          });

          workingMessages.push({
            role: "tool",
            toolCallId: toolCall.id,
            content: stringifyToolResult(result),
          });
        }
      } catch (error) {
        const wrapped = wrapError(error, { code: "MCP_TOOL_ERROR", retriable: false });
        loopLogger?.error("Agent loop tool execution failed", wrapped, { turn: turnIndex });
        yield {
          type: "error",
          code: wrapped.code,
          message: wrapped.message,
          retriable: wrapped.retriable,
        };
        return;
      }
    }
  }

  private buildCompletionRequest(messages: ChatMessage[]): ChatCompletionRequest {
    return {
      modelId: this.profile.modelId,
      systemPrompt: buildSystemPrompt(this.profile),
      messages,
      tools: this.toolExecutor.getSchemas().map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.parameters,
      })),
    };
  }
}

function appendTextBlock(blocks: ContentBlock[], chunk: TextDeltaChunk): void {
  const last = blocks.at(-1);
  if (last && last.type === "text") {
    last.text += chunk.text;
    return;
  }

  blocks.push({ type: "text", text: chunk.text });
}

function parseToolArgs(toolCall: PendingToolCall): Record<string, unknown> {
  const argsText = toolCall.argumentsJson.trim();
  if (argsText.length === 0) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(argsText);
  } catch {
    throw new MaidsClawError({
      code: "TOOL_ARGUMENT_INVALID",
      message: `Invalid JSON arguments for tool '${toolCall.name}'`,
      retriable: false,
      details: {
        toolCallId: toolCall.id,
        rawArguments: toolCall.argumentsJson,
      },
    });
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new MaidsClawError({
      code: "TOOL_ARGUMENT_INVALID",
      message: `Tool '${toolCall.name}' arguments must be a JSON object`,
      retriable: false,
      details: {
        toolCallId: toolCall.id,
        rawArguments: toolCall.argumentsJson,
      },
    });
  }

  return parsed as Record<string, unknown>;
}

function finalizeAssistantMessage(blocks: ContentBlock[], fallbackText: string): ChatMessage | undefined {
  if (blocks.length > 0) {
    if (blocks.every((block) => block.type === "text")) {
      return {
        role: "assistant",
        content: blocks.map((block) => block.text).join(""),
      };
    }

    return {
      role: "assistant",
      content: blocks,
    };
  }

  if (fallbackText.length > 0) {
    return {
      role: "assistant",
      content: fallbackText,
    };
  }

  return undefined;
}

function createProjectionAppendix(
  assistantText: string,
  agentId: string,
  requestId: string,
  turnIndex: number
): ProjectionAppendix {
  return {
    publicSummarySeed: assistantText,
    primaryActorEntityId: agentId,
    locationEntityId: "unknown",
    eventCategory: "speech",
    projectionClass: assistantText.trim().length > 0 ? "area_candidate" : "non_projectable",
    sourceRecordId: `${requestId}:assistant:${turnIndex}`,
  };
}

function buildSystemPrompt(profile: AgentProfile): string {
  return `You are agent ${profile.id} with role ${profile.role}.`;
}

function stringifyToolResult(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }

  return JSON.stringify(result);
}
