import type { Chunk } from "../chunk.js";

export type ToolSchema = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
};

export type TextContentBlock = {
  type: "text";
  text: string;
};

export type ToolUseContentBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type ToolResultContentBlock = {
  type: "tool_result";
  toolCallId: string;
  content: string;
};

export type ContentBlock = TextContentBlock | ToolUseContentBlock | ToolResultContentBlock;

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentBlock[];
  toolCallId?: string;
};

export type ToolChoiceSpec =
  | { type: "auto" }
  | { type: "any" }
  | { type: "tool"; name: string };

export type ChatCompletionRequest = {
  modelId: string;
  messages: ChatMessage[];
  tools?: ToolSchema[];
  toolChoice?: ToolChoiceSpec;
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
};

export interface ChatModelProvider {
  chatCompletion(request: ChatCompletionRequest): AsyncIterable<Chunk>;
}
