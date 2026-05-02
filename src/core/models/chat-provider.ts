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

/**
 * Hidden reasoning metadata captured from a prior assistant turn so the
 * provider serializer can echo it back on tool continuation requests
 * (DeepSeek requires `reasoning_content` echo; Anthropic requires
 * `thinking` blocks). MUST NOT be projected into transcripts, settlement
 * payloads, traces, logs, UI, or memory ingest. Only the OpenAI/Anthropic
 * provider request serializers should read this field.
 */
export type HiddenReasoningMetadata = {
  format: "openai_reasoning_content" | "anthropic_thinking_blocks";
  /** Concatenated reasoning text (OpenAI-compatible providers). */
  text?: string;
  /** Opaque thinking blocks captured verbatim (Anthropic-native). */
  blocks?: unknown[];
  providerId?: string;
};

export type ProviderHiddenMetadata = {
  hiddenReasoning?: HiddenReasoningMetadata;
};

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentBlock[];
  toolCallId?: string;
  /**
   * Provider-private continuation metadata. Lives only inside the agent
   * loop's working messages buffer. Redaction is enforced by the type
   * system: this field is not present on `MessagePayload` (interaction
   * log) or `ObservationEvent` (gateway transport).
   */
  providerMetadata?: ProviderHiddenMetadata;
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
  disableThinking?: boolean;
};

export interface ChatModelProvider {
  chatCompletion(request: ChatCompletionRequest): AsyncIterable<Chunk>;
}
