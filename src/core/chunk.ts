// Chunk types for streaming throughout the system
// These are the ONLY chunk types used end-to-end by ALL LLM providers

/** Text delta chunk (streaming text from LLM) */
export type TextDeltaChunk = {
  type: "text_delta";
  text: string;
};

/** Tool use start chunk (LLM begins calling a tool) */
export type ToolUseStartChunk = {
  type: "tool_use_start";
  id: string;
  name: string;
};

/** Tool use delta chunk (incremental tool arguments) */
export type ToolUseDeltaChunk = {
  type: "tool_use_delta";
  id: string;
  partialJson: string;
};

/** Tool use end chunk (tool call arguments complete) */
export type ToolUseEndChunk = {
  type: "tool_use_end";
  id: string;
};

/** Tool execution result chunk (emitted after tool executor completes) */
export type ToolExecutionResultChunk = {
  type: "tool_execution_result";
  id: string;       // tool call ID
  name: string;     // tool name
  result: unknown;  // execution result
  isError: boolean; // true if tool execution failed
};

/** Message end chunk (final stop reason) */
export type MessageEndChunk = {
  type: "message_end";
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
  inputTokens?: number;
  outputTokens?: number;
};

/** Error chunk */
export type ErrorChunk = {
  type: "error";
  code: string;
  message: string;
  retriable: boolean;
};

/**
 * Hidden reasoning delta chunk — provider-emitted thinking/reasoning tokens
 * that the model wants the *provider* to see again on tool continuation,
 * but that MUST NOT reach the user, transcript, settlement, or persisted
 * traces.
 *
 * This type intentionally does NOT have a counterpart in
 * `app/contracts/execution.ts::ObservationEvent`. The conversion boundary
 * `chunkToObservationEvent` in `gateway/controllers.ts` returns `null` for
 * this case, which means hidden reasoning is dropped before it reaches
 * the gateway SSE stream, the local-turn-client public_chunks buffer, or
 * the trace store. AgentLoop consumes it in-process and binds the
 * accumulated text onto the next assistant message's
 * `providerMetadata.hiddenReasoning`, where the provider serializer can
 * echo it back on the next request.
 */
export type HiddenReasoningDeltaChunk = {
  type: "hidden_reasoning_delta";
  text: string;
  format: "openai_reasoning_content" | "anthropic_thinking";
  providerId?: string;
};

/** Union of all chunk types */
export type Chunk =
  | TextDeltaChunk
  | ToolUseStartChunk
  | ToolUseDeltaChunk
  | ToolUseEndChunk
  | ToolExecutionResultChunk
  | MessageEndChunk
  | ErrorChunk
  | HiddenReasoningDeltaChunk;

// Type guards
export function isTextDeltaChunk(c: Chunk): c is TextDeltaChunk {
  return c.type === "text_delta";
}

export function isToolUseStartChunk(c: Chunk): c is ToolUseStartChunk {
  return c.type === "tool_use_start";
}

export function isToolUseDeltaChunk(c: Chunk): c is ToolUseDeltaChunk {
  return c.type === "tool_use_delta";
}

export function isToolUseEndChunk(c: Chunk): c is ToolUseEndChunk {
  return c.type === "tool_use_end";
}

export function isMessageEndChunk(c: Chunk): c is MessageEndChunk {
  return c.type === "message_end";
}

export function isErrorChunk(c: Chunk): c is ErrorChunk {
  return c.type === "error";
}

export function isToolExecutionResultChunk(c: Chunk): c is ToolExecutionResultChunk {
  return c.type === "tool_execution_result";
}

export function isHiddenReasoningDeltaChunk(c: Chunk): c is HiddenReasoningDeltaChunk {
  return c.type === "hidden_reasoning_delta";
}

/** Helper type to accumulate tool-use argument chunks into a complete call */
export type AccumulatedToolCall = {
  id: string;
  name: string;
  arguments: string; // Complete JSON when done
};
