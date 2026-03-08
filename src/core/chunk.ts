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

/** Union of all chunk types */
export type Chunk =
  | TextDeltaChunk
  | ToolUseStartChunk
  | ToolUseDeltaChunk
  | ToolUseEndChunk
  | MessageEndChunk
  | ErrorChunk;

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

/** Helper type to accumulate tool-use argument chunks into a complete call */
export type AccumulatedToolCall = {
  id: string;
  name: string;
  arguments: string; // Complete JSON when done
};
